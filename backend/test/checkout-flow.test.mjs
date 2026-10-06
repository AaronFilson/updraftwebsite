// Checkout failure paths against a fake Square client (no network).
import test from "node:test";
import assert from "node:assert/strict";
import { handler, _setSquare, _resetLimits, clientIp } from "../src/handler.mjs";

function fakeSquare({ stock = 1, fail = null } = {}) {
  const orderStore = new Map(), byKey = new Map(), paymentStore = new Map();
  let n = 0;
  const fakeCalls = {};
  const iter = (arr) => ({ async *[Symbol.asyncIterator]() { yield* arr; } });
  const boom = (step) => { throw new Error(`fake ${step} failure`); };
  return {
    orderStore, paymentStore, fakeCalls,
    catalog: { list: async () => iter([{ type: "ITEM", id: "I1", itemData: { name: "Celadon bowl", variations: [
      { id: "V1", itemVariationData: { name: "R", priceMoney: { amount: 5000n, currency: "USD" }, trackInventory: true } }] } }]) },
    inventory: { batchGetCounts: async () => iter([{ catalogObjectId: "V1", quantity: String(stock), calculatedAt: "2000-01-01T00:00:00Z" }]) },
    orders: {
      calculate: async () => ({ order: { totalMoney: { amount: 5000n }, totalTaxMoney: { amount: 0n } } }),
      create: async ({ idempotencyKey, order: req }) => {
        fakeCalls.order = req;
        if (!byKey.has(idempotencyKey)) {
          const o = { id: `O${++n}`, state: "OPEN", version: 1, totalMoney: { amount: 5000n }, tenders: [], fulfillments: [{ uid: "F1", state: "PROPOSED" }] };
          byKey.set(idempotencyKey, o); orderStore.set(o.id, o);
        }
        return { order: byKey.get(idempotencyKey) };
      },
      get: async ({ orderId }) => ({ order: orderStore.get(orderId) }),
      // Like Square: an order can only be cancelled together with all of its fulfillments.
      update: async ({ orderId, order }) => {
        const o = orderStore.get(orderId);
        for (const f of order.fulfillments ?? []) Object.assign(o.fulfillments.find((x) => x.uid === f.uid) ?? {}, { state: f.state });
        if (order.state === "CANCELED" && o.fulfillments.some((f) => !["COMPLETED", "CANCELED", "FAILED"].includes(f.state)))
          throw new Error("All fulfillments must have a state of COMPLETED, CANCELED, or FAILED");
        o.state = order.state;
        return {};
      },
    },
    payments: {
      create: async (req) => {
        const { orderId } = req;
        fakeCalls.payment = req;
        if (fail === "authorize") boom("authorize");
        const p = { id: `P${++n}`, status: "APPROVED", receiptUrl: "https://receipt" };
        paymentStore.set(p.id, p); orderStore.get(orderId).tenders.push({ paymentId: p.id });
        return { payment: p };
      },
      complete: async ({ paymentId }) => {
        if (fail === "complete") boom("complete");
        paymentStore.get(paymentId).status = "COMPLETED";
        if (fail === "complete-reply-lost") boom("reply lost");
        return { payment: paymentStore.get(paymentId) };
      },
      cancel: async ({ paymentId }) => { paymentStore.get(paymentId).status = "CANCELED"; return {}; },
      get: async ({ paymentId }) => ({ payment: paymentStore.get(paymentId) }),
    },
  };
}

const body = (key) => ({
  lines: [{ variationId: "V1", quantity: 1 }], sourceId: "tok", idempotencyKey: key, fulfillment: "pickup",
  name: "Ann Potter", email: "a@b.co", billing: { line1: "1 Main St", city: "Tacoma", state: "WA", postalCode: "98402" },
});
const post = async (b) => { const r = await handler({ requestContext: { http: { method: "POST" } }, rawPath: "/api/checkout", body: JSON.stringify(b) }); return { status: r.statusCode, body: JSON.parse(r.body) }; };
const fresh = (opts) => { _resetLimits(); const sq = fakeSquare(opts); _setSquare(sq); return sq; };
const only = (map) => [...map.values()];

test("declined card: no unpaid order is left behind", async () => {
  const sq = fresh({ fail: "authorize" });
  assert.equal((await post(body("k1"))).status, 500);
  assert.deepEqual(only(sq.orderStore).map((o) => o.state), ["CANCELED"]);
});

test("failure after authorising releases the hold and cancels the order", async () => {
  const sq = fresh({ fail: "complete" });
  assert.equal((await post(body("k2"))).status, 500);
  assert.deepEqual(only(sq.paymentStore).map((p) => p.status), ["CANCELED"]);
  assert.deepEqual(only(sq.orderStore).map((o) => o.state), ["CANCELED"]);
});

test("charge that went through despite an error is reported as success", async () => {
  const sq = fresh({ fail: "complete-reply-lost" });
  const r = await post(body("k3"));
  assert.equal(r.status, 200);
  assert.deepEqual(only(sq.paymentStore).map((p) => p.status), ["COMPLETED"]);
});

test("retry of a paid order (same key, page reloaded) shows success, not 'just sold'", async () => {
  fresh();
  assert.equal((await post(body("k4"))).status, 200);
  const again = await post(body("k4"));
  assert.equal(again.status, 200);
  assert.equal(again.body.alreadyPaid, true);
});

test("a different buyer after the sale is told it sold, not charged, with no stray order", async () => {
  const sq = fresh();
  assert.equal((await post(body("k5"))).status, 200);
  const second = await post(body("k6"));
  assert.equal(second.status, 409);
  assert.equal(second.body.notCharged, true);
  assert.deepEqual(only(sq.orderStore).map((o) => o.state).sort(), ["CANCELED", "OPEN"]); // the probe order was cancelled
  assert.deepEqual(only(sq.paymentStore).map((p) => p.status), ["COMPLETED"]);
});

test("the same piece twice in one request is rejected", async () => {
  fresh();
  const r = await post({ ...body("k7"), lines: [{ variationId: "V1", quantity: 1 }, { variationId: "V1", quantity: 1 }] });
  assert.equal(r.status, 400);
  assert.match(r.body.errors.join(" "), /only appear once/);
});

test("client IP comes from the forwarded chain, not CloudFront's address", () => {
  const ev = (xff, src = "130.176.1.1") => ({ requestContext: { http: { sourceIp: src } }, headers: xff ? { "x-forwarded-for": xff } : {} });
  assert.equal(clientIp(ev("203.0.113.9")), "203.0.113.9");
  assert.equal(clientIp(ev("203.0.113.9, 130.176.1.1")), "203.0.113.9");      // Function URL appended CloudFront
  assert.equal(clientIp(ev("6.6.6.6, 203.0.113.9")), "203.0.113.9");          // client tried to fake an address
  assert.equal(clientIp(ev("")), "130.176.1.1");                               // direct call, no proxy
});

test("a function only serves its own routes", async () => {
  process.env.ROUTES = "catalog,quote,subscribe";
  const { handler: apiOnly } = await import("../src/handler.mjs?routes=api");
  const r = await apiOnly({ requestContext: { http: { method: "POST" } }, rawPath: "/api/checkout", body: "{}" });
  assert.equal(r.statusCode, 404);
  delete process.env.ROUTES;
});

import { declineMessage } from "../src/handler.mjs";
test("decline codes become plain messages", () => {
  assert.match(declineMessage("GENERIC_DECLINE"), /declined/);
  assert.match(declineMessage("CVV_FAILURE"), /security code/);
  assert.match(declineMessage("ADDRESS_VERIFICATION_FAILURE"), /ZIP/);
  assert.match(declineMessage("INSUFFICIENT_FUNDS"), /insufficient/);
});

import { cleanNote } from "../src/handler.mjs";
test("order note reaches the pickup order and the payment", async () => {
  const sq = fresh();
  assert.equal((await post({ ...body("n1"), note: "Text me at 253-555-0100 to set a time." })).status, 200);
  assert.equal(sq.fakeCalls.order.fulfillments[0].pickupDetails.note, "Text me at 253-555-0100 to set a time.");
  assert.equal(sq.fakeCalls.payment.note, "Customer note: Text me at 253-555-0100 to set a time.");
});
test("order note on a shipped order goes to the shipping note", async () => {
  const sq = fresh();
  const shipping = { name: "Gift Person", line1: "5 Pine St", city: "Seattle", state: "WA", postalCode: "98101" };
  assert.equal((await post({ ...body("n2"), fulfillment: "shipping", shipping, note: "Happy birthday!" })).status, 200);
  assert.equal(sq.fakeCalls.order.fulfillments[0].shipmentDetails.shippingNote, "Happy birthday!");
});
test("notes are trimmed, capped at 500 and stripped of control characters", () => {
  assert.equal(cleanNote("  hi\u0007 there  "), "hi there");
  assert.equal(cleanNote("a\n\n\n\nb"), "a\n\nb");
  assert.equal(cleanNote("x".repeat(900)).length, 500);
  assert.equal(cleanNote(42), "");
});
