// Every page at phone, tablet and desktop widths: no sideways scrolling, no script errors, and the
// headline lays out as designed. The menus have their own spec (menu.spec.mjs).
import { test, expect } from "@playwright/test";
import { mockApi } from "./mock-api.mjs";

const pages = [
  "/",
  "/about.html",
  "/past-work.html",
  "/kilns.html",
  "/terms.html",
  "/care.html",
  "/policies.html",
  "/shop.html",
  "/no-such-page",
];
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

// The home headline and subtitle each break only at their <br> (after "hand," and before "from").
// Widest real-device fonts, as width / font-size: "Pottery shaped by hand," 12.2 (Georgia) and
// "Functional and sculptural ceramics" 15.5 (Roboto, Android). The CSS caps the sizes to fit those.
for (const width of [320, 360, 390, 412, 700, 768]) {
  test.describe(`home headline at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });
    test("each line fits whole, so it breaks only where intended", async ({ page }) => {
      await page.goto("/");
      const m = await page.evaluate(() => {
        const box = (el) => {
          const cs = getComputedStyle(el);
          return {
            size: parseFloat(cs.fontSize),
            width: el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
            lines: Math.round(el.getBoundingClientRect().height / parseFloat(cs.lineHeight)),
          };
        };
        // Is one of the serif fonts the headline asks for (before the generic fallback) installed?
        const span = document.createElement("span");
        span.textContent = "Pottery shaped by hand,";
        span.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap;font-size:40px";
        document.body.append(span);
        const widthIn = (family) => ((span.style.fontFamily = family), span.getBoundingClientRect().width);
        const realSerif = ['"Iowan Old Style"', '"Palatino Linotype"', "Palatino", "Georgia"].some(
          (f) => widthIn(`${f}, monospace`) !== widthIn("monospace"),
        );
        span.remove();
        return { h1: box(document.querySelector(".hero-text h1")), p: box(document.querySelector(".hero-text p")), realSerif };
      });
      // The sizing rule, independent of which fonts this machine has.
      expect(m.h1.size * 12.2).toBeLessThanOrEqual(m.h1.width);
      expect(m.p.size * 15.5).toBeLessThanOrEqual(m.p.width);
      // The real rendering, where a real-device serif is installed (not on Linux CI, which has DejaVu).
      if (m.realSerif) expect([m.h1.lines, m.p.lines]).toEqual([2, 2]);
    });
  });
}

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
