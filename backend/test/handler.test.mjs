import test from "node:test";
import assert from "node:assert/strict";
import { handler, _resetLimits } from "../src/handler.mjs";

const call = (method, path, body) =>
  handler({ requestContext: { http: { method } }, rawPath: path, body: body && JSON.stringify(body) });

test("unknown route is 404", async () => {
  assert.equal((await call("GET", "/nope")).statusCode, 404);
});

test("checkout rejects an empty cart without touching Square", async () => {
  const res = await call("POST", "/api/checkout", { lines: [], sourceId: "x", email: "a@b.co", name: "A", fulfillment: "pickup" });
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).errors[0], /Cart/);
});

test("checkout requires an address for shipping", async () => {
  const res = await call("POST", "/api/checkout", {
    lines: [{ variationId: "v", quantity: 1 }], sourceId: "x", email: "a@b.co", name: "A", fulfillment: "shipping",
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /shipping address/);
});

test("malformed JSON is 400", async () => {
  const res = await handler({ requestContext: { http: { method: "POST" } }, rawPath: "/api/checkout", body: "{" });
  assert.equal(res.statusCode, 400);
});

test("subscribe rejects an invalid email without touching Square", async () => {
  const res = await call("POST", "/api/subscribe", { email: "not-an-email" });
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /valid email/);
});

test("subscribe quietly accepts bot submissions without touching Square", async () => {
  const res = await call("POST", "/api/subscribe", { email: "a@b.co", website: "spam" });
  assert.equal(res.statusCode, 200);
});

test("subscribe limits repeated attempts from one IP", async () => {
  _resetLimits();
  const from = (ip) => handler({
    requestContext: { http: { method: "POST", sourceIp: ip } }, rawPath: "/api/subscribe", body: JSON.stringify({ email: "bad" }),
  });
  for (let i = 0; i < 5; i++) assert.equal((await from("1.2.3.4")).statusCode, 400);
  assert.equal((await from("1.2.3.4")).statusCode, 429);
  assert.equal((await from("5.6.7.8")).statusCode, 400); // other visitors unaffected
});

const billing = { line1: "1 Main St", city: "Tacoma", state: "WA", postalCode: "98402" };
const base = { lines: [{ variationId: "v", quantity: 1 }], sourceId: "x", email: "a@b.co", name: "Ann Potter" };
const errorsOf = async (body) => JSON.parse((await call("POST", "/api/checkout", body)).body).errors.join(" ");

test("pickup orders paid online still need a billing address", async () => {
  const res = await call("POST", "/api/checkout", { ...base, fulfillment: "pickup" });
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /billing address/);
  assert.doesNotMatch(res.body, /shipping address/);
});

test("shipping needs a recipient name and full US address", async () => {
  const errs = await errorsOf({ ...base, fulfillment: "shipping", billing, shipping: { ...billing, name: "" } });
  assert.match(errs, /shipping address/);
  assert.doesNotMatch(errs, /billing address/);
});

test("billing ZIP and state must be US format", async () => {
  assert.match(await errorsOf({ ...base, fulfillment: "pickup", billing: { ...billing, postalCode: "ABC" } }), /billing address/);
  assert.match(await errorsOf({ ...base, fulfillment: "pickup", billing: { ...billing, state: "Washington" } }), /billing address/);
});

test("quote validates the cart before calling Square", async () => {
  const res = await call("POST", "/api/quote", { lines: [], fulfillment: "pickup" });
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /Cart/);
  assert.equal((await call("POST", "/api/quote", { lines: [{ variationId: "v", quantity: 1 }], fulfillment: "drone" })).statusCode, 400);
});

import { stockOf, soldLines } from "../src/handler.mjs";

const info = new Map([
  ["open", { name: "Untracked mug", tracked: false, soldOut: false }],
  ["one", { name: "Celadon bowl", tracked: true, soldOut: false }],
  ["gone", { name: "Tenmoku jar", tracked: true, soldOut: false }],
  ["flagged", { name: "Vase", tracked: false, soldOut: true }],
  ["nocount", { name: "New piece", tracked: true, soldOut: false }],
]);
const counts = new Map([["one", 1], ["gone", 0]]);

test("stock: untracked is unlimited, tracked uses the count, sold-out switch wins", () => {
  assert.equal(stockOf(info, counts, "open"), null);
  assert.equal(stockOf(info, counts, "one"), 1);
  assert.equal(stockOf(info, counts, "gone"), 0);
  assert.equal(stockOf(info, counts, "flagged"), 0);
  assert.equal(stockOf(info, counts, "nocount"), 0); // tracked but never counted
  assert.equal(stockOf(info, counts, "unknown"), 0);
});

test("soldLines names lines that can't be filled", () => {
  const lines = [{ variationId: "open", quantity: 5 }, { variationId: "one", quantity: 1 }, { variationId: "gone", quantity: 1 }];
  assert.deepEqual(soldLines(lines, info, counts), [{ variationId: "gone", name: "Tenmoku jar" }]);
  assert.deepEqual(soldLines([{ variationId: "one", quantity: 2 }], info, counts).map((x) => x.name), ["Celadon bowl"]);
  assert.deepEqual(soldLines([{ variationId: "one", quantity: 1 }], info, counts), []);
});

import { recordSale, applyRecentSales } from "../src/handler.mjs";

test("a sale is subtracted until Square's count includes it, never twice", () => {
  _resetLimits();
  const t0 = Date.parse("2026-10-05T23:17:00Z");
  recordSale([{ variationId: "bowl", quantity: 1 }], t0 + 1000);
  // Square's count was calculated before the sale: still says 1 -> treat as 0
  assert.equal(applyRecentSales(new Map([["bowl", 1]]), new Map([["bowl", t0]]), t0 + 2000).get("bowl"), 0);
  // a few seconds later Square's count includes the sale (0, calculated after it) -> stays 0, not -1
  assert.equal(applyRecentSales(new Map([["bowl", 0]]), new Map([["bowl", t0 + 5000]]), t0 + 6000).get("bowl"), 0);
  // other pieces are untouched
  assert.equal(applyRecentSales(new Map([["jar", 1]]), new Map([["jar", t0]]), t0 + 2000).get("jar"), 1);
});

test("sale memory expires after 10 minutes", () => {
  _resetLimits();
  const t0 = Date.parse("2026-10-05T23:17:00Z");
  recordSale([{ variationId: "bowl", quantity: 1 }], t0);
  assert.equal(applyRecentSales(new Map([["bowl", 1]]), new Map([["bowl", t0 - 1]]), t0 + 11 * 60_000).get("bowl"), 1);
});
