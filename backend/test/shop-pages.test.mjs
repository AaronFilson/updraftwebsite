// Photo resizing requests, the catalog's photos and types, and the /p/<piece> share page.
import test from "node:test";
import assert from "node:assert/strict";
import { handler, _setSquare } from "../src/handler.mjs";
import sharp from "sharp";
import { parseRequest, handler as images, _resetCatalog } from "../src/images.mjs";

const SQUARE_PHOTO = "https://items-images-sandbox.s3.us-west-2.amazonaws.com/files/abc/original.jpeg";

test("photo requests only accept the stage's Square photo host, fixed widths and three formats", () => {
  assert.deepEqual(parseRequest({ u: SQUARE_PHOTO, w: "800", f: "avif" }), { url: SQUARE_PHOTO, width: 800, format: "avif" });
  const live = SQUARE_PHOTO.replace("-sandbox", "-production");
  assert.equal(parseRequest({ u: live, w: "800", f: "avif" }, "production").url, live);
  assert.ok(parseRequest({ u: live, w: "800", f: "avif" }, "sandbox").error, "a sandbox stage takes sandbox photos only");
  assert.ok(parseRequest({ u: SQUARE_PHOTO, w: "800", f: "avif" }, "production").error, "and the other way round");
  for (const u of [
    "https://example.com/x.jpg",
    // Other spellings of the same photo would each be a new cache entry, so only Square's own is taken.
    `${SQUARE_PHOTO}?v=2`,
    `${SQUARE_PHOTO}#a`,
    SQUARE_PHOTO.replace("items-images", "ITEMS-images"),
    SQUARE_PHOTO.replace("/files/", "/files/./"),
    SQUARE_PHOTO.replace("https://", "https://items-images-sandbox.s3.us-west-2.amazonaws.com:443@"),
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

test("the photo function only resizes photos in the shop's own catalog, and survives bad ones", async (t) => {
  process.env.ALLOWED_ORIGIN = "https://shop.example";
  _resetCatalog();
  const NOT_AN_IMAGE = SQUARE_PHOTO.replace("abc", "txt");
  const STRANGER = SQUARE_PHOTO.replace("abc", "someone-else");
  const photo = await sharp({ create: { width: 100, height: 1000, channels: 3, background: "#6a9" } })
    .jpeg()
    .toBuffer();
  const asked = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    asked.push(String(url));
    if (url === "https://shop.example/api/catalog")
      return Response.json({ items: [{ image: SQUARE_PHOTO, images: [SQUARE_PHOTO, NOT_AN_IMAGE] }] });
    if (url === SQUARE_PHOTO) return new Response(photo);
    if (url === NOT_AN_IMAGE) return new Response("<html>not a photo</html>");
    return new Response("", { status: 404 });
  });
  const get = (u, w = "400") => images({ requestContext: { http: { method: "GET" } }, queryStringParameters: { u, w, f: "webp" } });
  const catalogReads = () => asked.filter((u) => u.endsWith("/api/catalog")).length;

  const ok = await get(SQUARE_PHOTO);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers["content-type"], "image/webp");
  assert.match(ok.headers["cache-control"], /max-age=31536000/);
  // Never enlarged, and a tall photo is held to twice the width: 100×1000 fits 400×800 as 80×800.
  const meta = await sharp(Buffer.from(ok.body, "base64")).metadata();
  assert.deepEqual([meta.width, meta.height], [80, 800]);

  const stranger = await get(STRANGER);
  assert.equal(stranger.statusCode, 404);
  assert.ok(!asked.includes(STRANGER), "a photo outside the catalog is never fetched");
  await get(STRANGER.replace("someone", "another"));
  assert.equal(catalogReads(), 1, "unknown photos re-read the catalog at most every 20 seconds");

  const broken = await get(NOT_AN_IMAGE);
  assert.equal(broken.statusCode, 422, "bytes sharp can't read are a 422, not a crash");
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

test("share pages escape what's in Square, and unknown or odd ids are gone (410), never an error", async () => {
  _setSquare(fakeCatalog({ name: 'Bowl <script>alert("x")</script>' }));
  const res = await get("/p/I1");
  assert.ok(!res.body.includes("<script>alert"));
  assert.match(res.body, /Bowl &lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  // 410 rather than 404, which CloudFront would replace with the site's generic error page.
  assert.equal((await get("/p/NOPE")).statusCode, 410);
  assert.match((await get("/p/NOPE")).body, /isn't listed any more/);
  assert.equal((await get("/p/..%2Fapi%2Fcatalog")).statusCode, 410);
  assert.equal((await get("/p/%E0")).statusCode, 410, "a malformed escape is not an unhandled error");
});
