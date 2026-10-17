// The /p/<piece> page reads the site's shell (dist/piece-shell.html) through the site, and keeps it.
// Its own file: ALLOWED_ORIGIN is read when the modules load, and the other tests run without one.
import test from "node:test";
import assert from "node:assert/strict";

process.env.ALLOWED_ORIGIN = "https://shop.example";
const { handler, _setSquare } = await import("../src/handler.mjs");
const { _resetShell } = await import("../src/piece.mjs");

const iter = (arr) => ({
  async *[Symbol.asyncIterator]() {
    yield* arr;
  },
});
_setSquare({
  catalog: {
    list: async () =>
      iter([
        {
          type: "ITEM",
          id: "I1",
          itemData: {
            name: "Bowl",
            description: "",
            variations: [{ id: "V1", itemVariationData: { name: "R", priceMoney: { amount: 6500n, currency: "USD" } } }],
          },
        },
      ]),
  },
  inventory: { batchGetCounts: async () => iter([]) },
});
const get = (path) => handler({ requestContext: { http: { method: "GET" } }, rawPath: path });
const SHELL = '<!DOCTYPE html><html><head><title>Piece</title></head><body><main id="main">[[piece]]</main></body></html>';

test("the shell is read from the site once and kept, and pages get the site's address", async (t) => {
  _resetShell();
  const asked = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    asked.push(String(url));
    return new Response(SHELL);
  });
  const first = await get("/p/I1");
  await get("/p/I1");
  assert.deepEqual(asked, ["https://shop.example/piece-shell.html"]);
  assert.match(first.body, /<main id="main"><div class="wrap piece-page">/);
  assert.match(first.body, /<link rel="canonical" href="https:\/\/shop\.example\/p\/I1">/);
  assert.ok(!first.body.includes("noindex"));
  assert.match(first.headers["cache-control"], /max-age=300/);
});

test("a shell that can't be read gives the plain page, kept out of search and kept briefly", async (t) => {
  _resetShell();
  // CloudFront answers a missing file with the site's error page.
  t.mock.method(globalThis, "fetch", async () => new Response("<html>not found</html>", { status: 404 }));
  const res = await get("/p/I1");
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /<meta name="robots" content="noindex">/);
  assert.match(res.body, /<h1>Bowl<\/h1>/);
  assert.match(res.headers["cache-control"], /max-age=60/);
});

test("the pieces' sitemap uses the site's address", async () => {
  assert.match((await get("/p/sitemap.xml")).body, /<loc>https:\/\/shop\.example\/p\/I1<\/loc>/);
});
