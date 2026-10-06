import "./setup.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const { sha256Hex, postJson } = await import("../api.js");

test("sha256Hex matches the standard test vectors", async () => {
  assert.equal(await sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("POSTs carry the body's hash, which CloudFront-signed Lambda URLs require", async () => {
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url, init };
    return new Response("{}");
  };
  await postJson("/api/quote", { lines: [], fulfillment: "pickup" });
  assert.equal(seen.url, "/api/quote");
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.headers["x-amz-content-sha256"], await sha256Hex(seen.init.body));
});
