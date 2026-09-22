import { expect, test } from "@playwright/test";

test("appearance follows the system, supports keyboard choices, and remembers an explicit theme", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  const control = page.getByRole("complementary").getByRole("group", { name: "Appearance", exact: true });
  const root = page.locator("html");
  await expect(control.getByRole("radio", { name: "System", exact: true })).toBeChecked();
  await expect(root).toHaveCSS("color-scheme", "dark");

  await page.emulateMedia({ colorScheme: "light" });
  await expect(root).toHaveCSS("color-scheme", "light");
  await control.getByRole("radio", { name: "System", exact: true }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(control.getByRole("radio", { name: "Dark", exact: true })).toBeChecked();
  await expect(root).toHaveCSS("color-scheme", "dark");
  await page.reload();
  await expect(control.getByRole("radio", { name: "Dark", exact: true })).toBeChecked();
  await expect(root).toHaveCSS("color-scheme", "dark");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.emulateMedia({ colorScheme: "light" });
  await expect(root).toHaveCSS("color-scheme", "dark");

  await control.getByRole("radio", { name: "Dark", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(root).toHaveCSS("color-scheme", "light");
  await page.reload();
  await expect(control.getByRole("radio", { name: "System", exact: true })).toBeChecked();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(root).toHaveCSS("color-scheme", "dark");
  await page.setViewportSize({ width: 390, height: 844 });
  const menu = page.getByRole("button", { name: "Choose workspace" });
  await menu.click();
  await page.getByRole("main").getByRole("radio", { name: "Dark", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await expect(menu).toBeFocused();
  expect(errors.filter(message => /hydration|did not match|server rendered/i.test(message))).toEqual([]);
});

test("stored dark appearance is applied before the app JavaScript loads", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ colorScheme: "light", storageState: {
    cookies: [], origins: [{ origin: new URL(baseURL!).origin, localStorage: [{ name: "codex-explorer-appearance", value: "dark" }] }],
  } });
  const page = await context.newPage();
  await page.route("**/_next/**/*.js", route => route.abort());
  await page.goto(baseURL!);
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await context.close();
});
