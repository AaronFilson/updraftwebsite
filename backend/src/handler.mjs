// Lambda handler (API Gateway HTTP API / Function URL, payload v2) for the shop.
//   GET  /api/catalog   -> items for sale, read from the Square catalog
//   POST /api/quote     -> tax and total for a cart (Square calculates; nothing is created)
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
  ROUTES = "catalog,quote,subscribe,checkout",
} = process.env;

// Which routes this function serves. The template gives checkout only to the Checkout function, so
// calling the catalog function's public URL directly can't skip the one-order-at-a-time rule.
const routes = new Set(ROUTES.split(",").map((r) => r.trim()));

// Short, so a piece that sells shows "Sold" quickly; checkout always re-reads live stock anyway.
const CATALOG_TTL_MS = 15_000;
const MAX_LINES = 20;
const MAX_QTY = 10;

let client;
export const _setSquare = (fake) => { client = fake; catalogCache = { at: 0, items: [], info: new Map() }; }; // for tests
const square = () =>
  (client ??= new SquareClient({
    token: SQUARE_ACCESS_TOKEN,
    environment: SQUARE_ENV === "production" ? SquareEnvironment.Production : SquareEnvironment.Sandbox,
  }));

let catalogCache = { at: 0, items: [], info: new Map() };

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

// ---- catalog and stock ---------------------------------------------------------------------
// Square records a sale at once, but the stock count it reports catches up a few seconds later.
// So this instance remembers what it has just sold and subtracts any sale newer than the count's
// calculatedAt. Checkout runs one order at a time (Checkout function, concurrency 1), so the next
// checkout always sees the previous sale; after an idle restart the memory is empty, but by then
// Square's count has caught up.
const SALE_MEMORY_MS = 10 * 60_000;
const recentSales = new Map(); // variation id -> [{ qty, at }]

export function recordSale(lines, at = Date.now()) {
  for (const l of lines) recentSales.set(l.variationId, [...(recentSales.get(l.variationId) ?? []), { qty: l.quantity, at }]);
}

// counts: id -> quantity, asOf: id -> ms timestamp the count was calculated. Mutates and returns counts.
export function applyRecentSales(counts, asOf, now = Date.now()) {
  for (const [id, sales] of recentSales) {
    const kept = sales.filter((x) => now - x.at < SALE_MEMORY_MS);
    if (!kept.length) { recentSales.delete(id); continue; }
    recentSales.set(id, kept);
    if (!counts.has(id)) continue;
    const pending = kept.filter((x) => x.at > (asOf.get(id) ?? 0)).reduce((n, x) => n + x.qty, 0);
    counts.set(id, counts.get(id) - pending);
  }
  return counts;
}

// Square stock at our location for tracked variations, less sales the count doesn't include yet.
// Tracked but never counted = 0.
async function liveStock(ids) {
  const out = new Map(ids.map((id) => [id, 0]));
  if (!ids.length) return out;
  const asOf = new Map();
  const pager = await square().inventory.batchGetCounts({ catalogObjectIds: ids, locationIds: [SQUARE_LOCATION_ID], states: ["IN_STOCK"] });
  for await (const c of pager) {
    out.set(c.catalogObjectId, Number(c.quantity));
    asOf.set(c.catalogObjectId, Date.parse(c.calculatedAt) || 0);
  }
  return applyRecentSales(out, asOf);
}

// info: variation id -> { name, tracked, soldOut }. Stock is null when not tracked (no limit).
export function stockOf(info, counts, id) {
  const v = info.get(id);
  if (!v) return 0;
  if (v.soldOut) return 0;
  if (!v.tracked) return null;
  return Math.max(0, Math.floor(counts.get(id) ?? 0));
}

// Cart lines that can't be filled right now, with names for the message.
export function soldLines(lines, info, counts) {
  return lines.filter((l) => {
    const stock = stockOf(info, counts, l.variationId);
    return stock !== null && stock < l.quantity;
  }).map((l) => ({ variationId: l.variationId, name: info.get(l.variationId)?.name ?? "An item" }));
}

export async function loadCatalog() {
  if (Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.items;

  const objects = [];
  const pager = await square().catalog.list({ types: "ITEM,IMAGE" });
  for await (const obj of pager) objects.push(obj);

  const images = new Map(objects.filter((o) => o.type === "IMAGE").map((o) => [o.id, o.imageData?.url]));
  const info = new Map();
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
        .map((v) => {
          const d = v.itemVariationData;
          const here = d.locationOverrides?.find((x) => x.locationId === SQUARE_LOCATION_ID);
          const name = (o.itemData.variations.length > 1 ? `${o.itemData.name} (${d.name})` : o.itemData.name);
          info.set(v.id, { name, tracked: Boolean(here?.trackInventory ?? d.trackInventory), soldOut: Boolean(here?.soldOut) });
          return { id: v.id, name: d.name, price: Number(d.priceMoney.amount), currency: d.priceMoney.currency };
        }),
    }))
    .filter((i) => i.variations.length);

  const counts = await liveStock([...info].filter(([, v]) => v.tracked).map(([id]) => id));
  for (const item of items) for (const v of item.variations) v.stock = stockOf(info, counts, v.id);
  // Pieces still for sale first; sold pieces stay listed (marked Sold) after them.
  items.sort((a, b) => Number(a.variations.every((v) => v.stock === 0)) - Number(b.variations.every((v) => v.stock === 0)));

  catalogCache = { at: Date.now(), items, info };
  return items;
}

// Live check (never cached) of whether the cart can still be filled.
async function checkStock(lines) {
  await loadCatalog();
  const { info } = catalogCache;
  const tracked = [...new Set(lines.map((l) => l.variationId))].filter((id) => info.get(id)?.tracked);
  return soldLines(lines, info, await liveStock(tracked));
}
const soldResponse = (sold) => respond(409, {
  errors: [`Sorry, ${sold.map((x) => x.name).join(" and ")} just sold.`],
  sold: sold.map((x) => x.variationId),
  notCharged: true,
});

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Best-effort abuse limits, per warm Lambda instance (the template also caps concurrency):
// at most 5 signup attempts per IP per 10 minutes, and a repeat of the same email within an hour is a no-op.
const IP_WINDOW_MS = 10 * 60_000;
const IP_MAX = 5;
const EMAIL_WINDOW_MS = 60 * 60_000;
const ipHits = new Map();
const recentEmails = new Map();
const prune = (map, now, ttl) => { for (const [k, v] of map) if (now - (v.at ?? v) > ttl) map.delete(k); };
export function _resetLimits() { ipHits.clear(); recentEmails.clear(); recentSales.clear(); } // for tests

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

// ---- orders, quotes and checkout ---------------------------------------------------------
const ZIP_RE = /^\d{5}(-\d{4})?$/;
const STATE_RE = /^[A-Za-z]{2}$/;
const text = (v, max = 100) => (typeof v === "string" ? v.trim().slice(0, max) : "");

function validateLines(b, errors) {
  if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > MAX_LINES) errors.push("Cart is empty or too large.");
  for (const l of b.lines ?? []) {
    if (typeof l.variationId !== "string" || !Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > MAX_QTY)
      errors.push("Invalid cart line.");
  }
  // One line per piece, so the stock check sees the full quantity asked for.
  if (Array.isArray(b.lines) && new Set(b.lines.map((l) => l?.variationId)).size !== b.lines.length) errors.push("Each piece can only appear once in the cart.");
  if (b.fulfillment !== "shipping" && b.fulfillment !== "pickup") errors.push("Choose pickup or shipping.");
}

// US addresses only for now. `who` names the address in error messages.
function cleanAddress(a, who, errors, { needName = false } = {}) {
  a ??= {};
  const out = {
    name: text(a.name), line1: text(a.line1), line2: text(a.line2), city: text(a.city, 60),
    state: text(a.state, 20).toUpperCase(), postalCode: text(a.postalCode, 20), // long enough that bad input fails the checks below
  };
  if ((needName && !out.name) || !out.line1 || !out.city || !STATE_RE.test(out.state) || !ZIP_RE.test(out.postalCode))
    errors.push(`Complete ${who} address required.`);
  return out;
}

// Square wants 9-16 digits; normalise US numbers to E.164 and drop anything unusable.
function cleanPhone(v) {
  const digits = String(v ?? "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits.length >= 9 && digits.length <= 16 ? `+${digits}` : undefined;
}

// Customer's order note: plain text, up to 500 characters (Square's payment-note limit), no control
// characters other than line breaks.
export const cleanNote = (v) => (typeof v === "string" ? v.replace(/[^\S\n]+/g, " ").replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 500) : "");

const splitName = (full) => { const [first, ...rest] = full.trim().split(/\s+/); return { first, last: rest.join(" ") || undefined }; };
const squareAddress = (a, name) => {
  const { first, last } = splitName(name);
  return {
    addressLine1: a.line1, addressLine2: a.line2 || undefined, locality: a.city,
    administrativeDistrictLevel1: a.state, postalCode: a.postalCode, country: "US", firstName: first, lastName: last,
  };
};

// The parts of the order that decide its price; shared by /api/quote and /api/checkout so they always agree.
function priceableOrder(b) {
  const shipping = Number(SHIPPING_CENTS);
  return {
    locationId: SQUARE_LOCATION_ID,
    lineItems: b.lines.map((l) => ({ catalogObjectId: l.variationId, quantity: String(l.quantity) })),
    pricingOptions: { autoApplyTaxes: true },
    serviceCharges:
      b.fulfillment === "shipping" && shipping > 0
        ? [{ name: "Shipping", amountMoney: { amount: BigInt(shipping), currency: "USD" }, calculationPhase: "SUBTOTAL_PHASE" }]
        : undefined,
  };
}

async function unknownLines(lines) {
  const known = new Set((await loadCatalog()).flatMap((i) => i.variations.map((v) => v.id)));
  return lines.some((l) => !known.has(l.variationId));
}

// Tax and total for the cart, before paying. Nothing is created in Square.
export async function quote(b) {
  const errors = [];
  validateLines(b, errors);
  if (errors.length) return respond(400, { errors });
  if (await unknownLines(b.lines)) return respond(400, { errors: ["An item is no longer available."] });
  const sold = await checkStock(b.lines);
  if (sold.length) return soldResponse(sold);
  const { order } = await square().orders.calculate({ order: priceableOrder(b) });
  return respond(200, {
    subtotal: Number(order.totalMoney.amount) - Number(order.totalTaxMoney?.amount ?? 0) - Number(order.totalServiceChargeMoney?.amount ?? 0),
    shipping: Number(order.totalServiceChargeMoney?.amount ?? 0),
    tax: Number(order.totalTaxMoney?.amount ?? 0),
    total: Number(order.totalMoney.amount),
  });
}

function validateCheckout(b) {
  const errors = [];
  validateLines(b, errors);
  if (typeof b.sourceId !== "string" || !b.sourceId) errors.push("Missing payment token.");
  if (!EMAIL_RE.test(b.email ?? "")) errors.push("A valid email is required.");
  if (!text(b.name)) errors.push("Name is required.");
  // Every order paid on the site needs a billing address; shipped orders also need where to send it.
  const billing = cleanAddress(b.billing, "billing", errors);
  const shipping = b.fulfillment === "shipping" ? cleanAddress(b.shipping, "shipping", errors, { needName: true }) : null;
  return { errors, billing, shipping };
}

export async function checkout(b) {
  const { errors, billing, shipping } = validateCheckout(b);
  if (errors.length) return respond(400, { errors });
  if (await unknownLines(b.lines)) return respond(400, { errors: ["An item is no longer available."] });
  const name = text(b.name);
  const phone = cleanPhone(b.phone);
  const note = cleanNote(b.note);
  const fulfillment = shipping
    ? {
        type: "SHIPMENT",
        state: "PROPOSED",
        shipmentDetails: {
          recipient: { displayName: shipping.name, emailAddress: b.email, phoneNumber: phone, address: squareAddress(shipping, shipping.name) },
          shippingNote: note || undefined,
        },
      }
    : { type: "PICKUP", state: "PROPOSED", pickupDetails: { recipient: { displayName: name, emailAddress: b.email, phoneNumber: phone }, scheduleType: "ASAP", note: note || undefined } };

  const soldBefore = await checkStock(b.lines);
  if (soldBefore.length) {
    if (validKey(b.idempotencyKey)) {
      const paid = await alreadyPaid({ idempotencyKey: `o-${b.idempotencyKey}`, order: { ...priceableOrder(b), fulfillments: [fulfillment] } }, b.idempotencyKey);
      if (paid) return paid;
    }
    return soldResponse(soldBefore);
  }

  // Never charge something other than what the customer was shown (prices or tax changed meanwhile).
  // Checked with a calculation first, so a mismatch doesn't leave an unpaid order behind in Square.
  if (Number.isInteger(b.expectedTotal)) {
    const { order: preview } = await square().orders.calculate({ order: priceableOrder(b) });
    const now = Number(preview.totalMoney.amount);
    if (now !== b.expectedTotal)
      return respond(409, { errors: ["The total changed since it was shown. Please check the new total and pay again."], total: now });
  }

  const key = validKey(b.idempotencyKey) ? b.idempotencyKey : randomUUID();
  const orderRequest = { idempotencyKey: `o-${key}`, order: { ...priceableOrder(b), fulfillments: [fulfillment] } };
  const { order } = await square().orders.create(orderRequest);
  const total = Number(order.totalMoney.amount);

  // Authorise only; the card is charged after one last stock check, so a piece that sold a moment
  // ago is never charged for (the authorisation is cancelled instead).
  let auth;
  try {
    ({ payment: auth } = await square().payments.create({
      idempotencyKey: `p-${key}`,
      autocomplete: false,
      sourceId: b.sourceId,
      locationId: SQUARE_LOCATION_ID,
      orderId: order.id,
      amountMoney: order.totalMoney,
      buyerEmailAddress: b.email,
      buyerPhoneNumber: phone,
      billingAddress: squareAddress(billing, name),
      shippingAddress: shipping ? squareAddress(shipping, shipping.name) : undefined,
      // Also on the payment, so the note shows under Transactions as well as on the order.
      note: note ? `Customer note: ${note}`.slice(0, 500) : undefined,
    }));
  } catch (err) {
    await cancelOrder(order.id, key); // declined card etc.: don't leave an unpaid order behind
    throw err;
  }

  // From here on the card is on hold: any failure must release it, never leave it hanging.
  try {
    const soldAfter = await checkStock(b.lines);
    if (soldAfter.length) {
      await releaseHold(auth.id, order.id, key);
      return soldResponse(soldAfter);
    }
    // Note the time before charging: Square's own sale time is then never earlier than ours, so once
    // its count includes this sale it isn't subtracted twice.
    const saleAt = Date.now();
    const { payment } = await square().payments.complete({ paymentId: auth.id });
    recordSale(b.lines, saleAt);
    return respond(200, { orderId: order.id, total, status: payment.status, receiptUrl: payment.receiptUrl });
  } catch (err) {
    // The charge may have gone through even though the call failed (e.g. a timeout on the reply).
    const status = await paymentStatus(auth.id);
    if (status?.status === "COMPLETED") {
      recordSale(b.lines, Date.now());
      return respond(200, { orderId: order.id, total, status: status.status, receiptUrl: status.receiptUrl });
    }
    console.error("Checkout failed after authorising; releasing the hold", order.id, err?.message);
    await releaseHold(auth.id, order.id, key);
    throw err;
  }
}

const validKey = (k) => typeof k === "string" && k.length > 0 && k.length <= 40;

// Best effort: each step logs instead of throwing, so cleanup never hides the original error.
async function cancelOrder(orderId, key) {
  try {
    const { order: current } = await square().orders.get({ orderId });
    if (current.state !== "OPEN") return;
    // Square only cancels an order once each of its fulfillments (the pickup or shipment) is cancelled too.
    await square().orders.update({
      orderId, idempotencyKey: `c-${key}`,
      order: {
        locationId: SQUARE_LOCATION_ID, version: current.version, state: "CANCELED",
        fulfillments: (current.fulfillments ?? []).map((f) => ({ uid: f.uid, state: "CANCELED" })),
      },
    });
  } catch (err) {
    console.error("Couldn't cancel order", orderId, err?.message);
  }
}
async function releaseHold(paymentId, orderId, key) {
  try { await square().payments.cancel({ paymentId }); } catch (err) { console.error("Couldn't cancel payment", paymentId, err?.message); }
  await cancelOrder(orderId, key);
}
async function paymentStatus(paymentId) {
  try { return (await square().payments.get({ paymentId })).payment; } catch { return null; }
}

// A repeat of an order that was already paid (same idempotency key, e.g. the page reloaded while
// paying). Re-sending the same order request returns Square's original order if there was one;
// if it creates a new one instead, that one is cancelled straight away.
async function alreadyPaid(orderRequest, key) {
  let order;
  try { ({ order } = await square().orders.create(orderRequest)); } catch { return null; } // key reused with a different cart
  const paymentId = order.tenders?.[0]?.paymentId ?? order.tenders?.[0]?.id;
  const payment = paymentId ? await paymentStatus(paymentId) : null;
  if (payment?.status === "COMPLETED")
    return respond(200, { orderId: order.id, total: Number(order.totalMoney.amount), status: payment.status, receiptUrl: payment.receiptUrl, alreadyPaid: true });
  await cancelOrder(order.id, key);
  return null;
}

// Square's decline codes, in words a buyer can act on.
export function declineMessage(code = "") {
  if (/CVV/.test(code)) return "The security code (CVV) doesn't match this card. Please check it and try again.";
  if (/ADDRESS_VERIFICATION|POSTAL_CODE/.test(code)) return "The billing ZIP code doesn't match this card. Please check it and try again.";
  if (/INSUFFICIENT_FUNDS/.test(code)) return "The card was declined for insufficient funds. Please try a different card.";
  if (/EXPIR/.test(code)) return "The card's expiration date doesn't look right, or the card has expired.";
  if (/CARD_NUMBER|INVALID_CARD/.test(code)) return "The card number doesn't look right. Please check it and try again.";
  return "Your card was declined. Please try a different card.";
}

// The visitor's address. Behind CloudFront, sourceIp is CloudFront's own server, so use the
// X-Forwarded-For chain: entries a client sends come first and can be faked, CloudFront appends the
// real viewer, and the Function URL may append CloudFront. Take the last entry that isn't sourceIp.
export function clientIp(event) {
  const source = event.requestContext?.http?.sourceIp ?? "unknown";
  const chain = String(event.headers?.["x-forwarded-for"] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  while (chain.length && chain.at(-1) === source) chain.pop();
  return chain.at(-1) ?? source;
}

export async function handler(event) {
  const method = event.requestContext?.http?.method ?? event.httpMethod;
  const path = event.rawPath ?? event.path;
  const route = path?.startsWith("/api/") ? path.slice(5) : "";
  try {
    if (method === "OPTIONS") return respond(204, "");
    if (route && !routes.has(route)) return respond(404, { errors: ["Not found"] });
    if (method === "GET" && path === "/api/catalog") return respond(200, { items: await loadCatalog() }, { "cache-control": "public, max-age=15" });
    if (method === "POST" && path === "/api/quote") return await quote(JSON.parse(event.body ?? "{}"));
    if (method === "POST" && path === "/api/checkout") return await checkout(JSON.parse(event.body ?? "{}"));
    if (method === "POST" && path === "/api/subscribe")
      return await subscribe(JSON.parse(event.body ?? "{}"), clientIp(event));
    return respond(404, { errors: ["Not found"] });
  } catch (err) {
    if (err instanceof SquareError) {
      // Card problems are shown in plain words; anything else stays in the logs.
      const msgs = [...new Set((err.errors ?? []).filter((e) => e.category === "PAYMENT_METHOD_ERROR").map((e) => declineMessage(e.code)))];
      console.error("Square error", err.statusCode, JSON.stringify(err.errors));
      const fallback = path === "/api/subscribe" ? "Couldn't sign you up right now. Please try again later."
        : path === "/api/quote" ? "Couldn't look up tax right now." : "Payment could not be completed.";
      return respond(msgs.length ? 402 : 502, { errors: msgs.length ? msgs : [fallback] });
    }
    console.error(err);
    return respond(err instanceof SyntaxError ? 400 : 500, { errors: ["Something went wrong."] });
  }
}
