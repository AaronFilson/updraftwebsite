// Photo resizing requests, the catalog's photos and types, and the /p/<piece> share page.
import test from "node:test";
import assert from "node:assert/strict";
import { handler, _setSquare } from "../src/handler.mjs";
import { parseRequest, handler as images } from "../src/images.mjs";

const SQUARE_PHOTO = "https://items-images-sandbox.s3.us-west-2.amazonaws.com/files/abc/original.jpeg";

test("photo requests only accept Square's photo hosts, fixed widths and three formats", () => {
  assert.deepEqual(parseRequest({ u: SQUARE_PHOTO, w: "800", f: "avif" }), { url: SQUARE_PHOTO, width: 800, format: "avif" });
  for (const u of [
    "https://example.com/x.jpg",
    "http://items-images-sandbox.s3.us-west-2.amazonaws.com/files/abc/original.jpeg",
    "https://items-images-sandbox.s3.us-west-2.amazonaws.com:8443/x.jpeg",
    "https://user:pw@items-images-sandbox.s3.us-west-2.amazonaws.com/x.jpeg",
    "https://items-images-sandbox.s3.us-west-2.amazonaws.com.evil.example/x.jpeg",
    "not a url",
  ])
    assert.ok(parseRequest({ u, w: "800", f: "avif" }).error, u);
  assert.ok(parseRequest({ u: SQUARE_PHOTO, w: "801", f: "avif" }).error);
  assert.ok(parseRequest({ u: SQUARE_PHOTO, w: "800", f: "gif" }).error);
  assert.ok(parseRequest({ u: SQUARE_PHOTO, w: "800", f: "constructor" }).error);
});

test("the photo function answers bad requests without fetching anything", async () => {
  const bad = await images({
    requestContext: { http: { method: "GET" } },
    queryStringParameters: { u: "https://example.com/a.jpg", w: "400", f: "webp" },
  });
  assert.equal(bad.statusCode, 400);
  assert.equal((await images({ requestContext: { http: { method: "POST" } } })).statusCode, 405);
});

const iter = (arr) => ({
  async *[Symbol.asyncIterator]() {
    yield* arr;
  },
});
function fakeCatalog({ name = "Celadon bowl", description = "Cone 10 porcelain · celadon\nThrown in Tacoma." } = {}) {
  return {
    catalog: {
      list: async () =>
        iter([
          { type: "CATEGORY", id: "C1", categoryData: { name: "Bowls" } },
          { type: "IMAGE", id: "M1", imageData: { url: SQUARE_PHOTO } },
          { type: "IMAGE", id: "M2", imageData: { url: SQUARE_PHOTO.replace("abc", "def") } },
          {
            type: "ITEM",
            id: "I1",
            itemData: {
              name,
              description,
              imageIds: ["M1", "M2"],
              categories: [{ id: "C1" }],
              variations: [
                { id: "V1", itemVariationData: { name: "R", priceMoney: { amount: 6500n, currency: "USD" }, trackInventory: true } },
              ],
            },
          },
        ]),
    },
    inventory: { batchGetCounts: async () => iter([{ catalogObjectId: "V1", quantity: "1", calculatedAt: "2000-01-01T00:00:00Z" }]) },
  };
}
const get = (path) => handler({ requestContext: { http: { method: "GET" } }, rawPath: path });

test("the catalog lists every photo, in order, and the piece's type", async () => {
  _setSquare(fakeCatalog());
  const { items } = JSON.parse((await get("/api/catalog")).body);
  assert.equal(items[0].image, SQUARE_PHOTO);
  assert.deepEqual(items[0].images, [SQUARE_PHOTO, SQUARE_PHOTO.replace("abc", "def")]);
  assert.equal(items[0].category, "Bowls");
});

test("a share page carries the piece's name, price, spec line and photo, then sends people to the shop", async () => {
  _setSquare(fakeCatalog());
  const res = await get("/p/I1");
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"], /text\/html/);
  assert.match(res.body, /<meta property="og:title" content="Celadon bowl · \$65\.00">/);
  assert.match(res.body, /<meta property="og:description" content="Cone 10 porcelain · celadon">/);
  assert.match(
    res.body,
    new RegExp(`og:image" content="/api/img\\?u=${encodeURIComponent(SQUARE_PHOTO).replace(/[.?]/g, "\\$&")}&amp;w=1200&amp;f=jpeg"`),
  );
  assert.match(res.body, /<script src="\/p\.js" defer><\/script>/);
  assert.match(res.body, /href="\/shop\.html#p-I1"/);
});

test("share pages escape what's in Square, and unknown or odd ids are a 404", async () => {
  _setSquare(fakeCatalog({ name: 'Bowl <script>alert("x")</script>' }));
  const res = await get("/p/I1");
  assert.ok(!res.body.includes("<script>alert"));
  assert.match(res.body, /Bowl &lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.equal((await get("/p/NOPE")).statusCode, 404);
  assert.equal((await get("/p/..%2Fapi%2Fcatalog")).statusCode, 404);
});
