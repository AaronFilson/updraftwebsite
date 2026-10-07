// Email signup: validation, success, and that the form stays hidden without JavaScript.
import { test, expect } from "@playwright/test";
import { mockApi } from "./mock-api.mjs";

test("rejects a bad address, then signs up and confirms", async ({ page }) => {
  const calls = await mockApi(page);
  await page.goto("/");
  const form = page.locator(".signup-form");
  await form.getByLabel("Email address").fill("nope");
  await form.getByRole("button", { name: "Sign up" }).click();
  await expect(page.locator(".signup-status")).toHaveText("Enter a valid email address.");
  await form.getByLabel("Email address").fill("potter@example.com");
  await form.getByRole("button", { name: "Sign up" }).click();
  await expect(page.locator(".signup-status")).toHaveText("You're on the list. Thank you!");
  expect(calls.subscribe).toEqual([{ email: "potter@example.com", website: "" }]);
  expect(calls.badHash).toEqual([]);
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });
  test("the form is hidden so an address can't end up in a URL", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".signup-form")).toBeHidden();
    await expect(page.locator(".signup noscript")).toHaveCount(1);
  });
});
