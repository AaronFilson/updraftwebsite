// Search and discoverability checks across the built site: structured data (@type), matching visual
// and JSON-LD breadcrumbs, canonical 301 redirects, Atom feed, visible gallery captions, and image sitemaps.
import { test, expect } from "@playwright/test";
import { mockApi } from "./mock-api.mjs";
import { INDEXNOW_KEY } from "../scripts/indexnow.mjs";

const expectedTypes = [
  ["/", "OnlineStore", null],
  ["/shop.html", "CollectionPage", ["Home", "Shop"]],
  ["/past-work.html", "CollectionPage", ["Home", "Past work"]],
  ["/about.html", "ProfilePage", ["Home", "About the studio"]],
  ["/kilns.html", "CollectionPage", ["Home", "Kiln projects"]],
  ["/terms.html", "DefinedTermSet", ["Home", "Ceramic terms"]],
  ["/care.html", "WebPage", ["Home", "Shop", "Care & use"]],
  ["/policies.html", "WebPage", ["Home", "Shop", "Shipping, pickup & returns"]],
];

for (const [path, type, crumbs] of expectedTypes) {
  test(`${path} has ${type} JSON-LD, Atom feed discovery, and matching breadcrumbs`, async ({ page }) => {
    await mockApi(page);
    await page.goto(path);
    await expect(page.locator('head link[rel="alternate"][type="application/atom+xml"]')).toHaveAttribute("href", /\/p\/feed\.xml$/);
    const schema = JSON.parse(await page.locator('head script[type="application/ld+json"]').first().textContent());
    expect(schema["@graph"][0]["@type"]).toBe(type);
    if (!crumbs) {
      await expect(page.locator("nav.crumbs")).toHaveCount(0);
    } else {
      await expect(page.locator("nav.crumbs li")).toHaveText(crumbs);
      await expect(page.locator("nav.crumbs [aria-current='page']")).toHaveText(crumbs.at(-1));
      const ldCrumbs = schema["@graph"].find((n) => n["@type"] === "BreadcrumbList");
      expect(ldCrumbs.itemListElement.map((c) => c.name)).toEqual(crumbs);
      expect(ldCrumbs.itemListElement.at(-1).item).toBeUndefined();
    }
  });
}

test("canonical 301 redirects resolve /index.html and extensionless page URLs", async ({ request }) => {
  for (const [from, to] of [
    ["/index.html", "/"],
    ["/shop?type=Bowls", "/shop.html?type=Bowls"],
    ["/about/", "/about.html"],
    ["/past-work", "/past-work.html"],
  ]) {
    const res = await request.get(from, { maxRedirects: 0 });
    expect([from, res.status(), res.headers()["location"]]).toEqual([from, 301, to]);
  }
});

test("past-work exposes VisualArtwork metadata, visible descriptions, and descriptive image filenames", async ({ page }) => {
  await page.goto("/past-work.html");
  const src = await page.locator(".gallery .tile img").first().getAttribute("src");
  expect(src).toMatch(/^\/img\/archive\/01-green-footed-bowl-\d+-[0-9a-f]{8}\.webp$/);
  await expect(page.locator(".gallery .tile figcaption").first()).toContainText("Footed bowl in a green glaze");
  const schema = JSON.parse(await page.locator('head script[type="application/ld+json"]').first().textContent());
  const firstArt = schema["@graph"][0].mainEntity.itemListElement[0].item;
  expect(firstArt).toMatchObject({
    "@type": "VisualArtwork",
    name: "Green footed bowl",
    artform: "Pottery",
  });
  expect(firstArt.description).toContain("Footed bowl in a green glaze");
});

test("terms glossary anchors match DefinedTerm deep-links", async ({ page }) => {
  await page.goto("/terms.html");
  const schema = JSON.parse(await page.locator('head script[type="application/ld+json"]').first().textContent());
  const terms = schema["@graph"][0].hasDefinedTerm;
  expect(terms.length).toBeGreaterThanOrEqual(18);
  for (const term of terms) {
    const id = term.url.split("#")[1];
    await expect(page.locator(`dt#${id}`)).toHaveCount(1);
  }
});

test("sitemap-pages.xml includes lastmod and high-res gallery images, and IndexNow key is served", async ({ request }) => {
  const keyRes = await request.get(`/${INDEXNOW_KEY}.txt`);
  expect(keyRes.status()).toBe(200);
  expect((await keyRes.text()).trim()).toBe(INDEXNOW_KEY);

  const res = await request.get("/sitemap-pages.xml");
  test.skip(res.status() === 404, "built without SITE_URL");
  const xml = await res.text();
  const lastmods = [...xml.matchAll(/<lastmod>(\d{4}-\d{2}-\d{2})<\/lastmod>/g)];
  expect(lastmods.length).toBeGreaterThanOrEqual(8);
  const locs = [...xml.matchAll(/<image:loc>([^<]+)<\/image:loc>/g)].map((m) => new URL(m[1]).pathname);
  expect(locs.length).toBeGreaterThanOrEqual(120); // work + archive + artist + kilns
  expect(locs.some((p) => /^\/img\/archive\/01-green-footed-bowl-1600-[0-9a-f]{8}\.webp$/.test(p))).toBe(true);
  const img = await request.get(locs[0]);
  expect(img.status()).toBe(200);
});

test("the Atom feed (/p/feed.xml) lists available pieces and skips sold ones", async ({ request }) => {
  const res = await request.get("/p/feed.xml");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("application/atom+xml");
  const xml = await res.text();
  expect(xml).toContain("Celadon footed bowl · $65.00");
  expect(xml).toContain("Everyday mug · $30.00");
  expect(xml).not.toContain("Tenmoku jar"); // sold
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });
  test("shop shows its heading and opening description for non-JS crawlers", async ({ page }) => {
    await page.goto("/shop.html");
    await expect(page.locator("h1")).toHaveText("Shop");
    await expect(page.locator(".shop-lede").first()).toContainText("One-of-a-kind porcelain and stoneware");
  });
});
