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
