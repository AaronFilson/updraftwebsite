// Every page at phone, tablet and desktop widths: no sideways scrolling, no script errors, and the
// nav and headline lay out as designed.
import { test, expect } from "@playwright/test";
import { mockApi } from "./mock-api.mjs";

const pages = ["/", "/past-work.html", "/kilns.html", "/terms.html", "/care.html", "/policies.html", "/shop.html", "/no-such-page"];
const widths = [390, 768, 1280];

for (const width of widths) {
  test.describe(`${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });
    for (const path of pages) {
      test(`${path} fits and runs cleanly`, async ({ page }) => {
        const errors = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await mockApi(page);
        await page.goto(path);
        await page.waitForLoadState("load");
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        expect(overflow, "horizontal overflow (px)").toBe(0);
        expect(errors).toEqual([]);
      });
    }
  });
}

test.describe("phone layout", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("nav fits one line with the short Glossary label, and the headline breaks at the comma", async ({ page }) => {
    await page.goto("/");
    const nav = await page.evaluate(() => ({
      rows: new Set([...document.querySelectorAll("nav a")].map((a) => Math.round(a.getBoundingClientRect().top))).size,
      glossary: document.querySelector('nav a[href="/terms.html"]').innerText,
    }));
    expect(nav).toEqual({ rows: 1, glossary: "Glossary" });
    const lines = await page.evaluate(() => {
      const h = document.querySelector(".hero h1");
      return Math.round(h.getBoundingClientRect().height / parseFloat(getComputedStyle(h).lineHeight));
    });
    expect(lines).toBe(2);
  });
});

test("the 404 page has a working skip link and the right status", async ({ page, browserName }) => {
  const res = await page.goto("/missing.html");
  expect(res.status()).toBe(404);
  await expect(page.locator("main#main")).toBeVisible();
  // The skip link is the first link on the page and points at main#main.
  expect(await page.evaluate(() => document.querySelector("a[href]").className)).toBe("skip");
  await expect(page.locator(".skip")).toHaveAttribute("href", "#main");
  // Safari only tabs to links with full keyboard access turned on, which WebKit here can't emulate.
  if (browserName !== "webkit") {
    await page.keyboard.press("Tab");
    await expect(page.locator(".skip")).toBeFocused();
  }
});
