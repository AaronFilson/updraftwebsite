// The shop against a mocked API and a fake Square card form: stock, tax quotes, the checkout form,
// what checkout sends, and how "just sold" is handled.
import { test, expect } from "@playwright/test";
import { mockApi, item } from "./mock-api.mjs";
import { fakeSquare } from "./fake-square.mjs";

const bowl = item("bowl", "Celadon bowl", 6500, 1);
const mug = item("mug", "Everyday mug", 3000, null);
const jar = item("jar", "Tenmoku jar", 9000, 0);
const card = (page, name) => page.locator(".card", { hasText: name });

async function fillCheckout(page, { shipping = false } = {}) {
  if (shipping) await page.getByLabel("Shipping (US)").check();
  await page.getByLabel("Full name").fill("Ann Potter");
  await page.getByLabel("Email (for your receipt)").fill("ann@example.com");
  await page.locator("input[name=billLine1]").fill("1 Main St");
  await page.locator("input[name=billCity]").fill("Tacoma");
  await page.locator("input[name=billState]").fill("WA");
  await page.locator("input[name=billZip]").fill("98402");
}

test.beforeEach(async ({ page }) => {
  await fakeSquare(page);
});

test("stock shows on the cards: sold pieces, one-of-a-kind limits, open-ended items", async ({ page }) => {
  await mockApi(page, { items: [bowl, mug, jar] });
  await page.goto("/shop.html");
  await expect(card(page, "Tenmoku jar").getByRole("button")).toHaveText("Sold");
  await expect(card(page, "Tenmoku jar").locator(".sold-badge")).toBeVisible();
  await card(page, "Celadon bowl")
    .getByRole("button", { name: /Add Celadon bowl/ })
    .click();
  await expect(card(page, "Celadon bowl").getByRole("button")).toHaveText("In cart");
  await expect(page.locator(".cart-line", { hasText: "Celadon bowl" }).getByRole("button")).toHaveText("Remove");
  await card(page, "Everyday mug").getByRole("button").click();
  await expect(page.locator(".cart-line", { hasText: "Everyday mug" }).getByRole("button", { name: /Increase/ })).toBeEnabled();
});

test("a saved cart loses pieces that sold since, with a message", async ({ page }) => {
  await mockApi(page, { items: [bowl, jar] });
  await page.addInitScript(() =>
    localStorage.setItem("updraft-cart", JSON.stringify([{ variationId: "jar", itemName: "Tenmoku jar", price: 9000, quantity: 1 }])),
  );
  await page.goto("/shop.html");
  await expect(page.locator("#cart-notice")).toHaveText("Tenmoku jar has sold and was removed from your cart.");
  await expect(page.locator(".cart-line")).toHaveCount(0);
});

test("tax is looked up before paying, with a visible 'looking up' state", async ({ page }) => {
  let release;
  const gate = new Promise((ok) => (release = ok));
  await mockApi(page, {
    items: [mug],
    quote: async (route, body) => {
      await gate;
      route.fulfill({ json: { subtotal: 3000, shipping: 0, tax: 300, total: 3300 } });
    },
  });
  await page.goto("/shop.html");
  await card(page, "Everyday mug").getByRole("button").click();
  await expect(page.locator("#quote-status")).toHaveText("Looking up sales tax…");
  await expect(page.locator("#pay")).toBeDisabled();
  release();
  await expect(page.locator("#t-tax")).toHaveText("$3.00");
  await expect(page.locator("#pay")).toHaveText("Pay $33.00");
});

test("a piece that sells during the tax lookup leaves the cart with a message", async ({ page }) => {
  await mockApi(page, {
    items: [bowl],
    quote: (route) =>
      route.fulfill({ status: 409, json: { errors: ["Sorry, Celadon bowl just sold."], sold: ["bowl"], notCharged: true } }),
  });
  await page.goto("/shop.html");
  await card(page, "Celadon bowl").getByRole("button").click();
  await expect(page.locator("#cart-notice")).toHaveText("Sorry, Celadon bowl just sold. It was removed from your cart.");
  await expect(card(page, "Celadon bowl").getByRole("button")).toHaveText("Sold");
});

test("checkout form: billing is required, shipping fields appear only when shipping elsewhere", async ({ page }) => {
  await mockApi(page, { items: [mug] });
  await page.goto("/shop.html");
  await card(page, "Everyday mug").getByRole("button").click();
  await expect(page.locator("#pay")).toBeEnabled();
  await page.locator("#pay").click();
  await expect(page.locator("#error")).toHaveText("Please fix the highlighted fields.");
  await expect(page.locator("input[name=name]")).toBeFocused();
  await expect(page.locator("input[name=billLine1]")).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#ship-fields")).toBeHidden();
  await page.getByLabel("Shipping (US)").check();
  await expect(page.locator("#ship-fields")).toBeHidden(); // "Ship to my billing address" is ticked
  await page.getByLabel("Ship to my billing address").uncheck();
  await expect(page.locator("#ship-fields")).toBeVisible();
  await expect(page.locator("input[name=shipLine1]")).toHaveAttribute("required", "");
});

test("checkout sends billing, shipping, note and the quoted total, signed with the body hash", async ({ page }) => {
  const calls = await mockApi(page, { items: [mug] });
  await page.goto("/shop.html");
  await card(page, "Everyday mug").getByRole("button").click();
  await fillCheckout(page, { shipping: true });
  await page.getByLabel("Ship to my billing address").uncheck();
  await page.locator("input[name=shipName]").fill("Gift Person");
  await page.locator("input[name=shipLine1]").fill("5 Pine St");
  await page.locator("input[name=shipCity]").fill("Seattle");
  await page.locator("input[name=shipState]").fill("WA");
  await page.locator("input[name=shipZip]").fill("98101");
  await page.locator("textarea[name=note]").fill("Happy birthday!");
  await expect(page.locator("#note-count")).toHaveText("15 of 500 characters");
  await expect(page.locator("#pay")).toHaveText("Pay $33.00");
  await page.locator("#pay").click();
  await expect(page.locator("#cart-lines")).toContainText("Thank you! Your order is confirmed ($33.00).");
  const sent = calls.checkout[0];
  expect(sent).toMatchObject({
    sourceId: "test-token",
    fulfillment: "shipping",
    note: "Happy birthday!",
    expectedTotal: 3300,
    billing: { line1: "1 Main St", city: "Tacoma", state: "WA", postalCode: "98402" },
    shipping: { name: "Gift Person", line1: "5 Pine St", city: "Seattle", state: "WA", postalCode: "98101" },
  });
  expect(await page.evaluate(() => window.__tokenized.billingContact.city)).toBe("Tacoma");
  expect(calls.badHash).toEqual([]);
});

test("'just sold' at checkout says the card was not charged", async ({ page }) => {
  await mockApi(page, {
    items: [bowl],
    checkout: (route) =>
      route.fulfill({ status: 409, json: { errors: ["Sorry, Celadon bowl just sold."], sold: ["bowl"], notCharged: true } }),
  });
  await page.goto("/shop.html");
  await card(page, "Celadon bowl").getByRole("button").click();
  await fillCheckout(page);
  await page.locator("#pay").click();
  await expect(page.locator("#cart-notice")).toHaveText(
    "Sorry, Celadon bowl just sold. Your card was not charged. It was removed from your cart.",
  );
});

test("a busy checkout (HTTP 429) is retried with a message, then succeeds", async ({ page }) => {
  let tries = 0;
  await mockApi(page, {
    items: [mug],
    checkout: (route, body) =>
      ++tries < 3 ? route.fulfill({ status: 429, json: {} }) : route.fulfill({ json: { orderId: "o", total: body.expectedTotal } }),
  });
  await page.goto("/shop.html");
  await card(page, "Everyday mug").getByRole("button").click();
  await fillCheckout(page);
  await page.locator("#pay").click();
  await expect(page.locator("#cart-lines")).toContainText("Thank you!", { timeout: 15_000 });
  expect(tries).toBe(3);
});
