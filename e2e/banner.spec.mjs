// Site-wide announcement banner: omitted by the build once past `until`, and also hidden live by
// banner.js on both site.js pages (/) and shop.js (/shop.html) when `data-until` passes.
import { test, expect } from "@playwright/test";
import { mockApi } from "./mock-api.mjs";

const injectBanner = (page, path, until) =>
  page.route(
    (url) => url.pathname === path,
    async (route) => {
      const res = await route.fetch();
      const html = await res.text();
      const banner = `<div class="sale-banner" role="region" aria-label="Announcement" data-until="${until}"><p>Kiln opening Saturday! <a href="/shop.html">Shop</a></p></div>`;
      await route.fulfill({ response: res, body: html.replace('<header class="site-header">', `${banner}<header class="site-header">`) });
    },
  );

for (const path of ["/", "/shop.html"]) {
  test(`an expired banner is removed on ${path}`, async ({ page }) => {
    await mockApi(page);
    await injectBanner(page, path, "2026-10-24T16:00:00-07:00");
    await page.goto(path);
    await expect(page.locator(".sale-banner")).toHaveCount(0);
  });

  test(`an active banner stays visible on ${path}`, async ({ page }) => {
    await mockApi(page);
    await injectBanner(page, path, "2099-01-01T00:00:00Z");
    await page.goto(path);
    await expect(page.locator(".sale-banner")).toBeVisible();
    await expect(page.locator(".sale-banner")).toContainText("Kiln opening Saturday!");
  });
}
