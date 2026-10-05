// Lambda handler (API Gateway HTTP API / Function URL, payload v2) for the shop.
//   GET  /api/catalog   -> items for sale, read from the Square catalog
//   POST /api/checkout  -> builds a Square order from variation ids + quantities, then charges the card
//   POST /api/subscribe -> adds an email to the Square customer directory (and newsletter group, if set)
// Prices are always taken from Square, never from the browser.
import { createHash, randomUUID } from "node:crypto";
import { SquareClient, SquareEnvironment, SquareError } from "square";

const {
  SQUARE_ACCESS_TOKEN,
  SQUARE_LOCATION_ID,
  SQUARE_ENV = "sandbox",
  SHIPPING_CENTS = "0",
  ALLOWED_ORIGIN = "*",
  NEWSLETTER_GROUP_ID = "",
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

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Best-effort abuse limits, per warm Lambda instance (the template also caps concurrency):
// at most 5 signup attempts per IP per 10 minutes, and a repeat of the same email within an hour is a no-op.
const IP_WINDOW_MS = 10 * 60_000;
const IP_MAX = 5;
const EMAIL_WINDOW_MS = 60 * 60_000;
const ipHits = new Map();
const recentEmails = new Map();
const prune = (map, now, ttl) => { for (const [k, v] of map) if (now - (v.at ?? v) > ttl) map.delete(k); };
export function _resetLimits() { ipHits.clear(); recentEmails.clear(); } // for tests

function overLimit(ip, now = Date.now()) {
  prune(ipHits, now, IP_WINDOW_MS);
  const hit = ipHits.get(ip) ?? { at: now, n: 0 };
  hit.n += 1;
  ipHits.set(ip, hit);
  return hit.n > IP_MAX;
}

// Same response whether or not the address was already known, so the form can't be used to probe the list.
export async function subscribe(b, ip = "unknown") {
  if (b.website) return respond(200, { ok: true }); // spam trap field, filled only by bots
  if (overLimit(ip)) return respond(429, { errors: ["Too many attempts. Please try again in a few minutes."] });
  const email = String(b.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) return respond(400, { errors: ["Enter a valid email address."] });
  const now = Date.now();
  prune(recentEmails, now, EMAIL_WINDOW_MS);
  if (recentEmails.has(email)) return respond(200, { ok: true });

  const { customers = [] } = await square().customers.search({
    limit: BigInt(1),
    query: { filter: { emailAddress: { exact: email } } },
  });
  let id = customers[0]?.id;
  if (!id) {
    const { customer } = await square().customers.create({
      idempotencyKey: `s-${createHash("sha256").update(email).digest("hex").slice(0, 40)}`,
      emailAddress: email,
      note: "Signed up for email updates on the website",
    });
    id = customer.id;
  }
  if (NEWSLETTER_GROUP_ID) await square().customers.groups.add({ customerId: id, groupId: NEWSLETTER_GROUP_ID });
  recentEmails.set(email, now);
  return respond(200, { ok: true });
}

function validateCheckout(b) {
  const errors = [];
  if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > MAX_LINES) errors.push("Cart is empty or too large.");
  for (const l of b.lines ?? []) {
    if (typeof l.variationId !== "string" || !Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > MAX_QTY)
      errors.push("Invalid cart line.");
  }
  if (typeof b.sourceId !== "string" || !b.sourceId) errors.push("Missing payment token.");
  if (!EMAIL_RE.test(b.email ?? "")) errors.push("A valid email is required.");
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
    if (method === "POST" && path === "/api/subscribe")
      return await subscribe(JSON.parse(event.body ?? "{}"), event.requestContext?.http?.sourceIp);
    return respond(404, { errors: ["Not found"] });
  } catch (err) {
    if (err instanceof SquareError) {
      // Card declines etc. are safe and useful to show; anything else stays in the logs.
      const msgs = (err.errors ?? []).filter((e) => e.category === "PAYMENT_METHOD_ERROR").map((e) => e.detail);
      console.error("Square error", err.statusCode, JSON.stringify(err.errors));
      const fallback = path === "/api/subscribe" ? "Couldn't sign you up right now. Please try again later." : "Payment could not be completed.";
      return respond(msgs.length ? 402 : 502, { errors: msgs.length ? msgs : [fallback] });
    }
    console.error(err);
    return respond(err instanceof SyntaxError ? 400 : 500, { errors: ["Something went wrong."] });
  }
}
