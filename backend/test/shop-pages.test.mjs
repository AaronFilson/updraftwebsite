// Photo resizing requests, the catalog's photos and types, and the /p/<piece> pages and their sitemap.
import test from "node:test";
import assert from "node:assert/strict";
import { handler, _setSquare } from "../src/handler.mjs";
import sharp from "sharp";
import { parseRequest, handler as images, _resetCatalog, _catalogWaits } from "../src/images.mjs";
import { _resetShell } from "../src/piece.mjs";
import { renderPiece, structuredData } from "../src/piece-page.mjs";

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

test("the photo function waits out a busy API instead of failing the photo, but not forever", async (t) => {
  process.env.ALLOWED_ORIGIN = "https://shop.example";
  _catalogWaits.base = 1;
  t.after(() => (_catalogWaits.base = 300));
  const photo = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#6a9" } })
    .jpeg()
    .toBuffer();
  let busy;
  let reads = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url !== "https://shop.example/api/catalog") return new Response(photo);
    reads++;
    return busy-- > 0 ? new Response("", { status: 429 }) : Response.json({ items: [{ image: SQUARE_PHOTO }] });
  });
  const get = () =>
    images({ requestContext: { http: { method: "GET" } }, queryStringParameters: { u: SQUARE_PHOTO, w: "400", f: "webp" } });

  _resetCatalog();
  busy = 2; // throttled twice (the API's concurrency cap), then answers
  assert.equal((await get()).statusCode, 200);
  assert.equal(reads, 3);

  _resetCatalog();
  reads = 0;
  busy = 99; // still busy after every try: the page falls back to Square's original
  assert.equal((await get()).statusCode, 503);
  assert.equal(reads, 4);
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
            updatedAt: "2026-10-15T18:04:00.000Z",
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

// The JSON-LD block of a page.
const ld = (html) => JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)[1]);

test("a piece's page has its name, price, photos, words and product data, and no longer forwards to the shop", async () => {
  _setSquare(fakeCatalog());
  const res = await get("/p/I1");
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"], /text\/html/);
  assert.match(res.body, /<h1>Celadon bowl<\/h1>/);
  assert.match(res.body, /<p class="piece-spec">Cone 10 porcelain · celadon<\/p>/);
  assert.match(res.body, /<p>Thrown in Tacoma\.<\/p>/);
  assert.match(res.body, /<p class="price">\$65\.00<\/p>/);
  assert.match(res.body, /<a class="btn" href="\/shop\.html#p-I1">Buy in the shop<\/a>/, "works without the script");
  assert.match(res.body, /alt="Celadon bowl, photo 2"/);
  assert.match(res.body, /<meta property="og:title" content="Celadon bowl · \$65\.00">/);
  assert.match(res.body, /<meta property="og:description" content="Cone 10 porcelain · celadon">/);
  assert.match(
    res.body,
    /<meta name="description" content="Cone 10 porcelain · celadon\. Handmade in Tacoma by Updraft Pottery Studio\.">/,
  );
  assert.match(res.body, /<meta property="product:price:amount" content="65\.00">/);
  assert.match(res.body, /<link rel="canonical" href="\/p\/I1">/);
  assert.match(res.body, /<a href="\/shop\.html\?type=Bowls">Bowls<\/a>/, "breadcrumbs");
  assert.ok(!res.body.includes("p.js"), "no redirect to the shop any more");
  const [product, crumbs] = ld(res.body)["@graph"];
  assert.equal(product["@type"], "Product");
  assert.equal(product.offers[0].price, "65.00");
  assert.equal(product.offers[0].availability, "https://schema.org/InStock");
  assert.equal(product.image.length, 2);
  assert.deepEqual(
    crumbs.itemListElement.map((c) => c.name),
    ["Shop", "Bowls", "Celadon bowl"],
  );
  const data = JSON.parse(res.body.match(/<script type="application\/json" id="piece-data">(.*?)<\/script>/)[1]);
  assert.deepEqual(data.variations, [{ id: "V1", name: "R", price: 6500, currency: "USD", stock: 1 }]);
});

test("a piece's page goes into the site's shell; without one it's a plain page kept out of search", async (t) => {
  const SHELL =
    '<!DOCTYPE html><html lang="en"><head><title>Piece | Updraft Pottery Studio</title><style>x</style></head>' +
    '<body><nav><a href="/policies.html">Shipping</a></nav><main id="main">[[piece]]</main></body></html>';
  const { ALLOWED_ORIGIN } = await import("../src/config.mjs");
  const site = ALLOWED_ORIGIN === "*" ? "" : ALLOWED_ORIGIN;
  const html = renderPiece({
    item: { id: "I1", name: "Bowl", description: "", variations: [{ id: "V", name: "R", price: 100, stock: 0 }] },
    items: [],
    shell: SHELL,
    site: "https://s.example",
  });
  assert.match(html, /<title>Bowl \| Updraft Pottery Studio<\/title>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/s\.example\/p\/I1">.*<\/head>/);
  assert.match(html, /<main id="main"><div class="wrap piece-page">/);
  assert.match(html, /<a href="\/policies\.html">Shipping, pickup &amp; returns<\/a>/, "the shell's menu has the policy page");
  assert.match(html, /<p class="price">Sold<\/p>/);
  assert.ok(!html.includes("Buy in the shop"), "a sold piece has no way to buy");
  assert.ok(!html.includes("noindex"));
  assert.equal(ld(html)["@graph"][0].offers[0].availability, "https://schema.org/SoldOut");

  // Through the handler: with no site to read a shell from (tests run with ALLOWED_ORIGIN unset), the
  // plain page. Reading the shell from the site: piece-shell.test.mjs.
  assert.equal(site, "");
  _resetShell();
  _setSquare(fakeCatalog());
  const fetched = t.mock.method(globalThis, "fetch", async () => new Response(SHELL));
  const plain = await get("/p/I1");
  assert.match(plain.body, /<meta name="robots" content="noindex">/);
  assert.match(plain.headers["cache-control"], /max-age=60/, "kept briefly, so the styled page soon takes over");
  assert.equal(fetched.mock.callCount(), 0);
});

test("other pieces still for sale are linked from a piece's page, and its text is escaped", () => {
  const piece = (id, name, stock) => ({ id, name, description: "", variations: [{ id: `${id}v`, name: "R", price: 1000, stock }] });
  const items = [piece("A", 'Bowl <b>"x"</b>', 1), piece("B", "Mug", 1), piece("C", "Jar", 0), piece("D", "Cup", null)];
  const html = renderPiece({ item: items[0], items, shell: null, site: "" });
  assert.ok(!html.includes("<b>"));
  assert.match(html, /<h1>Bowl &lt;b&gt;&quot;x&quot;&lt;\/b&gt;<\/h1>/);
  assert.match(html, /href="\/p\/B"/);
  assert.match(html, /href="\/p\/D"/);
  assert.ok(!html.includes('href="/p/C"'), "sold pieces aren't offered");
  // A "<" in the product data can't close its script block.
  const evil = { ...items[0], name: "</script><script>alert(1)</script>" };
  const out = renderPiece({ item: evil, items: [], shell: null, site: "" });
  assert.equal(out.match(/<script/g).length, 2, "only the two data blocks");
  assert.equal(structuredData(evil, "")["@graph"][0].name, evil.name);
});

test("unknown or odd ids are gone (410), never an error", async () => {
  _setSquare(fakeCatalog());
  // 410 rather than 404, which CloudFront would replace with the site's generic error page.
  assert.equal((await get("/p/NOPE")).statusCode, 410);
  assert.match((await get("/p/NOPE")).body, /isn't listed any more/);
  assert.equal((await get("/p/..%2Fapi%2Fcatalog")).statusCode, 410);
  assert.equal((await get("/p/%E0")).statusCode, 410, "a malformed escape is not an unhandled error");
});

test("the pieces' sitemap lists every listed piece with the day it last changed", async () => {
  _setSquare(fakeCatalog());
  const res = await get("/p/sitemap.xml");
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"], /application\/xml/);
  assert.match(res.body, /<url><loc>\/p\/I1<\/loc><lastmod>2026-10-15<\/lastmod><\/url>/);
});
