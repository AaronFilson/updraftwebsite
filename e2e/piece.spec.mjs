// Shop pieces in detail: the detail view (photos, spec line, add to cart, share, links and Back),
// resized photos with their fallback, type filters, and the product data for search engines.
import { test, expect } from "@playwright/test";
import { mockApi, item } from "./mock-api.mjs";
import { fakeSquare } from "./fake-square.mjs";

const PHOTO = (n) => `https://items-images-sandbox.s3.us-west-2.amazonaws.com/files/p${n}/original.jpeg`;
// 1x1 PNG, served for every photo request in these tests
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const servePhotos = (page, { failResized = false } = {}) =>
  Promise.all([
    page.route("**/api/img**", (r) =>
      failResized ? r.fulfill({ status: 502, body: "" }) : r.fulfill({ body: PNG, contentType: "image/png" }),
    ),
    page.route("https://items-images-sandbox.s3.us-west-2.amazonaws.com/**", (r) => r.fulfill({ body: PNG, contentType: "image/png" })),
  ]);
const bowl = item("bowl", "Celadon bowl", 6500, 1, {
  description: "Cone 10 porcelain · celadon · 5½″ × 3″\nThrown and trimmed in Tacoma.\nSoda fired.",
  images: [PHOTO(1), PHOTO(2), PHOTO(3)],
  category: "Bowls",
});
const dialog = (page) => page.locator("dialog.piece");

test.beforeEach(async ({ page }) => {
  await fakeSquare(page);
  await servePhotos(page);
});

test("cards show the spec line and resized photos", async ({ page }) => {
  await mockApi(page, { items: [bowl] });
  await page.goto("/shop.html");
  const card = page.locator("#p-item-bowl");
  await expect(card.locator(".spec")).toHaveText("Cone 10 porcelain · celadon · 5½″ × 3″");
  await expect(card.locator("img")).toHaveAttribute("src", `/api/img?u=${encodeURIComponent(PHOTO(1))}&w=400&f=webp`);
  await expect(card.locator("source")).toHaveAttribute("type", "image/avif");
});

test("if a resized photo can't load, the card falls back to Square's original", async ({ page }) => {
  await page.unroute("**/api/img**");
  await servePhotos(page, { failResized: true });
  await mockApi(page, { items: [bowl] });
  await page.goto("/shop.html");
  await expect(page.locator("#p-item-bowl img")).toHaveAttribute("src", PHOTO(1));
});

test("the detail view: photos, full description, add to cart, then Escape returns to the card", async ({ page }) => {
  await mockApi(page, { items: [bowl] });
  await page.goto("/shop.html");
  await page.locator("#p-item-bowl h3 a").click();
  await expect(dialog(page)).toBeVisible();
  await expect(page).toHaveURL(/#p-item-bowl$/);
  await expect(dialog(page).locator("h2")).toHaveText("Celadon bowl");
  await expect(dialog(page).locator(".piece-spec")).toHaveText("Cone 10 porcelain · celadon · 5½″ × 3″");
  await expect(dialog(page).locator(".piece-desc p")).toHaveText(["Thrown and trimmed in Tacoma.", "Soda fired."]);
  await expect(dialog(page).locator(".piece-count")).toHaveText("1 of 3");
  await page.keyboard.press("ArrowRight");
  await expect(dialog(page).locator(".piece-count")).toHaveText("2 of 3");
  await dialog(page).getByRole("button", { name: "Previous photo" }).click();
  await expect(dialog(page).locator(".piece-count")).toHaveText("1 of 3");
  await dialog(page).getByRole("button", { name: "Add Celadon bowl to cart" }).click();
  await expect(dialog(page).locator(".piece-buy .btn")).toHaveText("In cart");
  await expect(page.locator("#p-item-bowl .btn")).toHaveText("In cart"); // the card follows
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toBeHidden();
  await expect(page).not.toHaveURL(/#p-/);
  await expect(page.locator("#p-item-bowl h3 a")).toBeFocused();
});

test("Back closes the detail view; a link to one piece opens it directly", async ({ page }) => {
  await mockApi(page, { items: [item("mug", "Mug", 3000, null), bowl] });
  await page.goto("/shop.html");
  await page.locator("#p-item-bowl h3 a").click();
  await expect(dialog(page)).toBeVisible();
  await page.goBack();
  await expect(dialog(page)).toBeHidden();
  await page.goto("/shop.html#p-item-bowl");
  await expect(dialog(page).locator("h2")).toHaveText("Celadon bowl");
  await dialog(page).getByRole("button", { name: "Close" }).click();
  await expect(page).toHaveURL(/\/shop\.html$/);
});

test("Share copies the piece's /p/ link where there's no share sheet", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "share", { value: undefined });
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (t) => (window.__copied = t) } });
  });
  await mockApi(page, { items: [bowl] });
  await page.goto("/shop.html#p-item-bowl");
  await dialog(page).getByRole("button", { name: "Share this piece" }).click();
  await expect(dialog(page).locator(".piece-shared")).toHaveText(/^Link copied: http:\/\/localhost:\d+\/p\/item-bowl$/);
  expect(await page.evaluate(() => window.__copied)).toMatch(/\/p\/item-bowl$/);
});

const many = [
  ...["a", "b", "c", "d", "e"].map((x) => item(`m${x}`, `Mug ${x}`, 3000, 1, { category: "Mugs" })),
  ...["a", "b", "c"].map((x) => item(`b${x}`, `Bowl ${x}`, 5000, 1, { category: "Bowls" })),
];

test("type filters appear once there are enough pieces, and keep their choice in the link", async ({ page }) => {
  await mockApi(page, { items: many });
  await page.goto("/shop.html");
  const chips = page.locator("#filters .chip");
  await expect(chips).toHaveText(["All (8)", "Mugs (5)", "Bowls (3)"]);
  await expect(chips.nth(0)).toHaveAttribute("aria-pressed", "true");
  await chips.nth(2).click();
  await expect(page.locator("#products .card:visible")).toHaveCount(3);
  await expect(page).toHaveURL(/\?type=Bowls$/);
  await page.reload();
  await expect(page.locator("#filters .chip").nth(2)).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#products .card:visible")).toHaveCount(3);
});

test("no filters with only a few pieces", async ({ page }) => {
  await mockApi(page, { items: many.slice(0, 4) });
  await page.goto("/shop.html");
  await expect(page.locator("#products .card")).toHaveCount(4);
  await expect(page.locator("#filters")).toBeHidden();
});

test("search engines get product data with price and availability", async ({ page }) => {
  await mockApi(page, { items: [bowl, item("jar", "Jar", 9000, 0)] });
  await page.goto("/shop.html");
  await expect(page.locator("#p-item-jar")).toBeVisible();
  const data = JSON.parse(await page.locator('head script[type="application/ld+json"]').last().textContent());
  expect(data.itemListElement.map((e) => [e.item.name, e.item.offers.price, e.item.offers.availability])).toEqual([
    ["Celadon bowl", "65.00", "https://schema.org/InStock"],
    ["Jar", "90.00", "https://schema.org/SoldOut"],
  ]);
});

test("the home page's Available now uses resized photos too", async ({ page }) => {
  await mockApi(page, { items: [bowl] });
  await page.goto("/");
  await expect(page.locator("#available img")).toHaveAttribute("src", `/api/img?u=${encodeURIComponent(PHOTO(1))}&w=400&f=webp`);
});
