// Automated accessibility checks (axe-core) on every page, at phone and desktop widths, in light and
// dark color schemes, plus the shop with the checkout form open. Serious and critical problems fail
// the build. axe's rules don't depend on the browser engine, so this runs in Chromium only.
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockApi, item } from "./mock-api.mjs";
import { fakeSquare } from "./fake-square.mjs";

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
const items = [item("bowl", "Celadon bowl", 6500, 1), item("mug", "Everyday mug", 3000, null), item("jar", "Tenmoku jar", 9000, 0)];

// Every WCAG 2.0-2.2 A/AA rule axe has, plus its best-practice rules; only serious/critical fail.
async function problems(page) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
    .analyze();
  return violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map(
      (v) =>
        `${v.id} (${v.impact}): ${v.help} -> ${v.nodes
          .map((n) => n.target.join(" "))
          .slice(0, 3)
          .join(", ")}`,
    );
}

test.beforeEach(({ browserName }) => {
  test.skip(browserName !== "chromium", "axe results don't depend on the engine; once is enough");
});

for (const colorScheme of ["light", "dark"]) {
  for (const width of [390, 1280]) {
    test.describe(`${colorScheme}, ${width}px`, () => {
      test.use({ viewport: { width, height: 900 }, colorScheme });
      for (const path of pages) {
        test(`${path} has no serious accessibility problems`, async ({ page }) => {
          await mockApi(page, { items });
          await page.goto(path);
          await page.waitForLoadState("load");
          await expect(page.locator('[aria-busy="true"]')).toHaveCount(0); // the shop's pieces have replaced the placeholders
          expect(await problems(page)).toEqual([]);
        });
      }
    });
  }

  test(`shop checkout form (${colorScheme}) has no serious accessibility problems`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 390, height: 900 });
    await fakeSquare(page);
    await mockApi(page, { items });
    await page.goto("/shop.html");
    await page.locator(".card", { hasText: "Everyday mug" }).getByRole("button").click();
    await expect(page.locator("#checkout")).toBeVisible();
    await page.locator("#pay").click(); // show the field errors too
    await expect(page.locator(".field-err").first()).toBeVisible();
    expect(await problems(page)).toEqual([]);
  });
}
