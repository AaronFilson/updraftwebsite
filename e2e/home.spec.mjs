// The home page flow: hero -> Available now (from the shop) -> the potter and the kilns -> recent
// work -> signup -> ordering and care. Available now only shows what can still be bought.
import { test, expect } from "@playwright/test";
import { mockApi, item } from "./mock-api.mjs";

const strip = (page) => page.locator("#available");

test("Available now shows up to four pieces still for sale, linked to their shop cards", async ({ page }) => {
  const options = {
    ...item("set", "Mug set", 3000, null),
    variations: [
      { id: "set-1", name: "One", price: 3000, currency: "USD", stock: null },
      { id: "set-2", name: "Pair", price: 5500, currency: "USD", stock: 3 },
    ],
  };
  await mockApi(page, {
    items: [
      item("jar", "Tenmoku jar", 9000, 0),
      item("bowl", "Celadon bowl", 6500, 1),
      options,
      item("a", "Cup A", 2800, 1),
      item("b", "Cup B", 2800, 1),
      item("c", "Cup C", 2800, 1),
    ],
  });
  await page.goto("/");
  await expect(strip(page)).toBeVisible();
  const cards = strip(page).locator("a.card");
  await expect(cards).toHaveCount(4);
  await expect(cards.locator("h3")).toHaveText(["Celadon bowl", "Mug set", "Cup A", "Cup B"]); // the sold jar is skipped
  await expect(cards.nth(0).locator(".price")).toHaveText("$65.00");
  await expect(cards.nth(1).locator(".price")).toHaveText("From $30.00");
  await expect(cards.nth(0)).toHaveAttribute("href", "/shop.html#p-item-bowl");
  await expect(strip(page).getByRole("link", { name: "Shop all pieces →" })).toHaveAttribute("href", "/shop.html");
});

test("when everything has sold, it points to the signup instead", async ({ page }) => {
  await mockApi(page, { items: [item("jar", "Tenmoku jar", 9000, 0)] });
  await page.goto("/");
  await expect(strip(page)).toContainText("Everything in the shop has sold for now.");
  await strip(page).getByRole("link", { name: "Get a first look at the next pieces" }).click();
  await expect(page).toHaveURL(/#signup$/);
});

test("with nothing listed, or the shop unreachable, the section stays out of the way", async ({ page }) => {
  await mockApi(page, { items: [] });
  await page.goto("/");
  await expect(page.locator(".studio")).toBeVisible();
  await expect(strip(page)).toBeHidden();
  await page.unroute("**/api/catalog");
  await page.route("**/api/catalog", (route) => route.fulfill({ status: 502, json: {} }));
  await page.reload();
  await expect(page.locator(".studio")).toBeVisible();
  await expect(strip(page)).toBeHidden();
});

test("the page runs in the planned order, with the full story on the About page", async ({ page }) => {
  await mockApi(page, { items: [item("bowl", "Celadon bowl", 6500, 1)] });
  await page.goto("/");
  await expect(strip(page)).toBeVisible();
  const order = await page
    .locator("main > *")
    .evaluateAll((els) =>
      els.map((e) => e.id || e.className.split(" ").find((c) => ["hero", "studio", "signup", "trust"].includes(c)) || e.tagName),
    );
  expect(order).toEqual(["hero", "available", "about", "work", "signup", "trust"]);
  await expect(page.locator(".studio").getByRole("link", { name: "Read the full story →" })).toHaveAttribute("href", "/about.html");
  await expect(page.locator(".studio").getByRole("link", { name: "See the kilns →" })).toHaveAttribute("href", "/kilns.html");
  await expect(page.locator(".trust")).toContainText("Orders ship in 1–2 business days.");
  await page.goto("/about.html");
  await expect(page.locator("h1")).toHaveText("About the studio");
  await expect(page.locator(".gallery .tile")).toHaveCount(9);
});
