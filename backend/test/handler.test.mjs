import test from "node:test";
import assert from "node:assert/strict";
import { handler } from "../src/handler.mjs";

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
