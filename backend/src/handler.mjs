// Lambda handler (API Gateway HTTP API / Function URL, payload v2) for the shop.
//   GET  /api/catalog   -> items for sale, read from the Square catalog
//   POST /api/checkout  -> builds a Square order from variation ids + quantities, then charges the card
// Prices are always taken from Square, never from the browser.
import { randomUUID } from "node:crypto";
import { SquareClient, SquareEnvironment, SquareError } from "square";

const {
  SQUARE_ACCESS_TOKEN,
  SQUARE_LOCATION_ID,
  SQUARE_ENV = "sandbox",
  SHIPPING_CENTS = "0",
  ALLOWED_ORIGIN = "*",
} = process.env;

const CATALOG_TTL_MS = 60_000;
const MAX_LINES = 20;
const MAX_QTY = 10;

let client;
const square = () =>
  (client ??= new SquareClient({
    token: SQUARE_ACCESS_TOKEN,
    environment: SQUARE_ENV === "production" ? SquareEnvironment.Production : SquareEnvironment.Sandbox,
  }));

let catalogCache = { at: 0, items: [] };

const respond = (status, body, extra = {}) => ({
  statusCode: status,
  headers: {
    "cache-control": "no-store",
    "content-type": "application/json",
    "access-control-allow-origin": ALLOWED_ORIGIN,
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    ...extra,
  },
  // Square returns money amounts as BigInt
  body: JSON.stringify(body, (_, v) => (typeof v === "bigint" ? Number(v) : v)),
});

export async function loadCatalog() {
  if (Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.items;

  const objects = [];
  const pager = await square().catalog.list({ types: "ITEM,IMAGE" });
  for await (const obj of pager) objects.push(obj);

  const images = new Map(objects.filter((o) => o.type === "IMAGE").map((o) => [o.id, o.imageData?.url]));
  const items = objects
    .filter((o) => o.type === "ITEM" && !o.isDeleted && o.itemData?.productType !== "APPOINTMENTS_SERVICE")
    .filter((o) => !o.itemData.isArchived)
    .map((o) => ({
      id: o.id,
      name: o.itemData.name,
      description: o.itemData.descriptionPlaintext ?? o.itemData.description ?? "",
      image: images.get(o.itemData.imageIds?.[0]) ?? null,
      variations: (o.itemData.variations ?? [])
        .filter((v) => v.itemVariationData?.priceMoney)
        .map((v) => ({
          id: v.id,
          name: v.itemVariationData.name,
          price: Number(v.itemVariationData.priceMoney.amount),
          currency: v.itemVariationData.priceMoney.currency,
        })),
    }))
    .filter((i) => i.variations.length);

  catalogCache = { at: Date.now(), items };
  return items;
}

function validateCheckout(b) {
  const errors = [];
  if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > MAX_LINES) errors.push("Cart is empty or too large.");
  for (const l of b.lines ?? []) {
    if (typeof l.variationId !== "string" || !Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > MAX_QTY)
      errors.push("Invalid cart line.");
  }
  if (typeof b.sourceId !== "string" || !b.sourceId) errors.push("Missing payment token.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email ?? "")) errors.push("A valid email is required.");
  if (!b.name?.trim()) errors.push("Name is required.");
  if (b.fulfillment === "shipping") {
    const a = b.address ?? {};
    if (!a.line1 || !a.city || !a.state || !a.postalCode) errors.push("Complete shipping address required.");
  } else if (b.fulfillment !== "pickup") errors.push("Choose pickup or shipping.");
  return errors;
}

export async function checkout(b) {
  const errors = validateCheckout(b);
  if (errors.length) return respond(400, { errors });

  // Only allow variations that exist in the live catalog.
  const known = new Set((await loadCatalog()).flatMap((i) => i.variations.map((v) => v.id)));
  if (b.lines.some((l) => !known.has(l.variationId))) return respond(400, { errors: ["An item is no longer available."] });

  const [first, ...rest] = b.name.trim().split(/\s+/);
  const recipient = { displayName: b.name.trim(), emailAddress: b.email };
  const fulfillment =
    b.fulfillment === "pickup"
      ? { type: "PICKUP", state: "PROPOSED", pickupDetails: { recipient, scheduleType: "ASAP" } }
      : {
          type: "SHIPMENT",
          state: "PROPOSED",
          shipmentDetails: {
            recipient: {
              ...recipient,
              address: {
                addressLine1: b.address.line1,
                addressLine2: b.address.line2 || undefined,
                locality: b.address.city,
                administrativeDistrictLevel1: b.address.state,
                postalCode: b.address.postalCode,
                country: "US",
                firstName: first,
                lastName: rest.join(" ") || undefined,
              },
            },
          },
        };

  const shipping = Number(SHIPPING_CENTS);
  const key = typeof b.idempotencyKey === "string" && b.idempotencyKey.length <= 40 ? b.idempotencyKey : randomUUID();

  const { order } = await square().orders.create({
    idempotencyKey: `o-${key}`,
    order: {
      locationId: SQUARE_LOCATION_ID,
      lineItems: b.lines.map((l) => ({ catalogObjectId: l.variationId, quantity: String(l.quantity) })),
      fulfillments: [fulfillment],
      pricingOptions: { autoApplyTaxes: true },
      serviceCharges:
        b.fulfillment === "shipping" && shipping > 0
          ? [{ name: "Shipping", amountMoney: { amount: BigInt(shipping), currency: "USD" }, calculationPhase: "SUBTOTAL_PHASE" }]
          : undefined,
    },
  });

  const { payment } = await square().payments.create({
    idempotencyKey: `p-${key}`,
    sourceId: b.sourceId,
    verificationToken: b.verificationToken,
    locationId: SQUARE_LOCATION_ID,
    orderId: order.id,
    amountMoney: order.totalMoney,
    buyerEmailAddress: b.email,
  });

  return respond(200, {
    orderId: order.id,
    total: Number(order.totalMoney.amount),
    status: payment.status,
    receiptUrl: payment.receiptUrl,
  });
}

export async function handler(event) {
  const method = event.requestContext?.http?.method ?? event.httpMethod;
  const path = event.rawPath ?? event.path;
  try {
    if (method === "OPTIONS") return respond(204, "");
    if (method === "GET" && path === "/api/catalog") return respond(200, { items: await loadCatalog() }, { "cache-control": "public, max-age=60" });
    if (method === "POST" && path === "/api/checkout") return await checkout(JSON.parse(event.body ?? "{}"));
    return respond(404, { errors: ["Not found"] });
  } catch (err) {
    if (err instanceof SquareError) {
      // Card declines etc. are safe and useful to show; anything else stays in the logs.
      const msgs = (err.errors ?? []).filter((e) => e.category === "PAYMENT_METHOD_ERROR").map((e) => e.detail);
      console.error("Square error", err.statusCode, JSON.stringify(err.errors));
      return respond(msgs.length ? 402 : 502, { errors: msgs.length ? msgs : ["Payment could not be completed."] });
    }
    console.error(err);
    return respond(err instanceof SyntaxError ? 400 : 500, { errors: ["Something went wrong."] });
  }
}
