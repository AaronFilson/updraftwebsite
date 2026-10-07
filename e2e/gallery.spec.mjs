// Photo galleries: the lightbox works from the keyboard, and the home slideshow runs, pauses and
// respects reduced motion.
import { test, expect } from "@playwright/test";

test("lightbox opens from the keyboard, steps with arrows, and returns focus", async ({ page }) => {
  await page.goto("/past-work.html");
  await page.locator(".tile a").first().focus();
  await page.keyboard.press("Enter");
  const dialog = page.locator("dialog.lightbox");
  await expect(dialog).toBeVisible();
  const first = await page.locator("#lightbox-title").textContent();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".lb-count")).toHaveText(/^3 of \d+$/);
  const third = await page.locator("#lightbox-title").textContent();
  expect(third).not.toBe(first);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  // The dialog's close event (which moves focus) fires just after it hides, so wait for focus to settle.
  await expect.poll(() => page.evaluate(() => document.activeElement.dataset.title)).toBe(third);
});

test("slideshow goes 09 -> 01 every 15 s and loops; the pause button holds it", async ({ page }) => {
  await page.clock.install();
  await page.goto("/");
  const active = () => page.locator(".slide.is-active img").getAttribute("alt");
  const seen = [await active()];
  const count = await page.locator(".slide").count();
  for (let i = 0; i < count; i++) {
    await page.clock.runFor(15_000);
    seen.push(await active());
  }
  expect(new Set(seen.slice(0, count)).size).toBe(count); // every photo shown once
  expect(seen[count]).toBe(seen[0]); // then back to the start
  await page.getByRole("button", { name: "Pause slideshow" }).click();
  const held = await active();
  await page.clock.runFor(60_000);
  expect(await active()).toBe(held);
  await expect(page.getByRole("button", { name: "Play slideshow" })).toBeVisible();
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });
  test("the slideshow starts paused", async ({ page }) => {
    await page.clock.install();
    await page.goto("/");
    const before = await page.locator(".slide.is-active img").getAttribute("alt");
    await page.clock.runFor(45_000);
    expect(await page.locator(".slide.is-active img").getAttribute("alt")).toBe(before);
    await expect(page.getByRole("button", { name: "Play slideshow" })).toBeVisible();
  });
});
