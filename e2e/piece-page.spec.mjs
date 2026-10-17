// A piece's own page (/p/ITEM): what search engines and shared links see, with or without the script,
// and Add to cart. scripts/serve.mjs draws it from e2e/fixtures/pieces.json as the API does from Square.
import { test, expect } from "@playwright/test";
import sharp from "sharp";

// 1x1 PNG, for Square's own photos
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
// A real 16×16 photo in each format /api/img serves, so the browser decodes what it asked for.
const SIZED = Object.fromEntries(
  await Promise.all(
    ["avif", "webp", "jpeg"].map(async (f) => [
      f,
      await sharp({ create: { width: 16, height: 16, channels: 3, background: "#6a9" } })
        .toFormat(f)
        .toBuffer(),
    ]),
  ),
);
const ld = async (page) => JSON.parse(await page.locator('script[type="application/ld+json"]').textContent());

test("a piece's page has its name, price, product data and its own address", async ({ page }) => {
  await page.goto("/p/fixture-bowl");
  await expect(page).toHaveTitle("Celadon footed bowl | Updraft Pottery Studio");
  await expect(page.locator("h1")).toHaveText("Celadon footed bowl");
  await expect(page.locator(".piece-spec")).toHaveText("Cone 10 porcelain · celadon · 5½″ wide × 3″ tall");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", /\/p\/fixture-bowl$/);
  await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
  await expect(page.locator(".site-header")).toBeVisible(); // in the site's own shell
  const [product] = (await ld(page))["@graph"];
  expect([product["@type"], product.name, product.offers[0].price]).toEqual(["Product", "Celadon footed bowl", "65.00"]);
  // Other pieces still for sale, each by its own page; the sold jar isn't among them.
  await expect(page.locator(".more-pieces h3")).toHaveText(["Everyday mug", "Lantern plate"]);
});

test("Add to cart on a piece's page fills the shop's cart", async ({ page }) => {
  await page.goto("/p/fixture-bowl");
  await page.getByRole("button", { name: "Add Celadon footed bowl to cart" }).click();
  await expect(page.locator(".piece-added")).toContainText("Added to your cart (1 item).");
  await expect(page.getByRole("button", { name: "Celadon footed bowl is in your cart" })).toBeDisabled(); // one of a kind
  await expect(page.locator("[data-cart-count]").first()).toHaveText("1");
  await page.getByRole("link", { name: "View cart and check out" }).click();
  await expect(page).toHaveURL(/\/shop\.html#cart$/);
});

test("a sold piece's page stays up, marked sold, with no way to buy", async ({ page }) => {
  await page.goto("/p/fixture-jar");
  await expect(page.locator("h1")).toHaveText("Tenmoku jar");
  await expect(page.locator(".piece-buy .price")).toHaveText("Sold");
  await expect(page.locator(".piece-buy button")).toHaveCount(0);
  expect((await ld(page))["@graph"][0].offers[0].availability).toBe("https://schema.org/SoldOut");
});

test("a piece no longer listed is gone (410), with a way to the shop", async ({ page }) => {
  const res = await page.goto("/p/no-such-piece");
  expect(res.status()).toBe(410);
  await expect(page.getByRole("link", { name: "See what's in the shop" })).toBeVisible();
});

test("the pieces' sitemap lists every piece", async ({ request }) => {
  const xml = await (await request.get("/p/sitemap.xml")).text();
  expect([...xml.matchAll(/<loc>[^<]*\/p\/([^<]+)<\/loc>/g)].map((m) => m[1])).toEqual([
    "fixture-bowl",
    "fixture-mug",
    "fixture-jar",
    "fixture-plate",
    "fixture-photos",
  ]);
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });
  test("the page reads in full, and links to the shop to buy", async ({ page }) => {
    await page.goto("/p/fixture-bowl");
    await expect(page.locator("h1")).toHaveText("Celadon footed bowl");
    await expect(page.locator(".piece-buy .price")).toHaveText("$65.00");
    await expect(page.getByRole("link", { name: "Buy in the shop" })).toHaveAttribute("href", "/shop.html#p-fixture-bowl");
  });
});

test("a photo the resizer is too busy for is asked for again, and loads resized", async ({ page }) => {
  let busy = 2; // the first two photo requests are turned away, as at the resizer's limit
  const originals = [];
  await page.route("**/api/img**", (r) => {
    if (busy-- > 0) return r.fulfill({ status: 429, body: "" });
    const f = new URL(r.request().url()).searchParams.get("f") ?? "webp";
    return r.fulfill({ body: SIZED[f], contentType: `image/${f}` });
  });
  await page.route("https://items-images-sandbox.s3.us-west-2.amazonaws.com/**", (r) => {
    originals.push(r.request().url());
    return r.fulfill({ body: PNG, contentType: "image/png" });
  });
  await page.goto("/p/fixture-photos");
  const imgs = page.locator(".piece-gallery img");
  await expect(imgs).toHaveCount(2);
  await imgs.last().scrollIntoViewIfNeeded(); // the second is lazy-loaded
  await expect
    .poll(() => imgs.evaluateAll((l) => l.every((i) => i.complete && i.naturalWidth > 0 && i.currentSrc.includes("/api/img?"))), {
      timeout: 15_000,
    })
    .toBe(true);
  expect(originals).toEqual([]);
});
