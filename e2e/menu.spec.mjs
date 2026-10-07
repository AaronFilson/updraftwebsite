// The nav: three dropdowns plus Cart on one line, every page one tap away, and menus that behave
// (one open at a time; Escape, a click elsewhere or choosing a link closes them), with or without JS.
import { test, expect } from "@playwright/test";

const everyPage = [
  "/#work",
  "/past-work.html",
  "/about.html",
  "/kilns.html",
  "/terms.html",
  "/shop.html",
  "/care.html",
  "/policies.html",
  "/shop.html#cart",
];
const menu = (page, name) => page.locator("nav details.menu", { has: page.locator(`summary:text-is("${name}")`) });

for (const width of [320, 390, 1280]) {
  test.describe(`${width}px`, () => {
    test.use({ viewport: { width, height: 800 } });

    test("the nav fits one line and every page is in it", async ({ page }) => {
      await page.goto("/");
      const tops = await page
        .locator("nav > details > summary, nav > a")
        .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
      expect(new Set(tops).size, "rows in the nav").toBe(1);
      const hrefs = await page.locator("nav a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
      expect(hrefs.sort()).toEqual([...everyPage].sort());
    });

    test("each open menu stays on screen and shows its links", async ({ page }) => {
      await page.goto("/");
      for (const name of ["Work", "Studio", "Shop"]) {
        await menu(page, name).locator("summary").click();
        const links = menu(page, name).locator("ul a");
        await expect(links.first()).toBeVisible();
        for (const box of await links.evaluateAll((as) => as.map((a) => a.getBoundingClientRect().toJSON())))
          expect(box.left >= 0 && box.right <= width, `${name} link within the screen`).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
      }
    });
  });
}

test("one menu open at a time; Escape and outside clicks close it", async ({ page }) => {
  await page.goto("/");
  await menu(page, "Work").locator("summary").click();
  await menu(page, "Studio").locator("summary").click();
  await expect(menu(page, "Work")).not.toHaveAttribute("open", "");
  await expect(menu(page, "Studio")).toHaveAttribute("open", "");
  await page.keyboard.press("Escape");
  await expect(menu(page, "Studio")).not.toHaveAttribute("open", "");
  await expect(menu(page, "Studio").locator("summary")).toBeFocused();
  await menu(page, "Shop").locator("summary").click();
  await page.locator("h1").click();
  await expect(menu(page, "Shop")).not.toHaveAttribute("open", "");
});

test("keyboard: Enter opens a menu, Tab reaches its links, choosing one navigates", async ({ page, browserName }) => {
  test.skip(browserName === "webkit", "Safari only tabs to links with full keyboard access, which WebKit here can't emulate");
  await page.goto("/");
  await menu(page, "Studio").locator("summary").focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await expect(page.locator('nav a[href="/about.html"]')).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/about\.html$/);
  await expect(menu(page, "Studio")).toHaveClass(/is-current/);
  await expect(page.locator('nav a[href="/about.html"]')).toHaveAttribute("aria-current", "page");
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });
  test("the menus still open", async ({ page }) => {
    await page.goto("/");
    await menu(page, "Shop").locator("summary").click();
    await expect(page.locator('nav a[href="/care.html"]')).toBeVisible();
  });
});
