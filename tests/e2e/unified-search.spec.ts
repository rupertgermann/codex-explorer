import { expect, test, type Page } from "@playwright/test";

async function searchForAtlas(page: Page) {
  await page.keyboard.press("Meta+k");
  await expect(page.getByRole("heading", { name: "Search everything" })).toBeVisible();
  await page.getByRole("searchbox", { name: "Search all Codex data" }).fill("atlas");
  await page.getByRole("button", { name: "Search everything", exact: true }).click();
  await expect(page.getByText("3 results for “atlas”")).toBeVisible();
}

test("searches every local source and opens each result in context", async ({ page }) => {
  await page.goto("/");

  await searchForAtlas(page);
  await page.getByRole("button", { name: /Atlas search fixture/ }).click();
  await expect(page.getByRole("heading", { name: "Codex Memory" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Atlas search fixture" })).toBeVisible();

  await page.keyboard.press("Meta+k");
  await expect(page.getByText("3 results for “atlas”")).toBeVisible();
  const sessionResult = page.getByRole("button", { name: /atlas-project/ });
  await expect(sessionResult).toContainText("User · L2");
  await expect(sessionResult).toContainText("Investigate the atlas workflow across all local Codex sources.");
  await expect(sessionResult).toContainText("Assistant · L3");
  await sessionResult.click();
  await expect(page.getByRole("heading", { name: "Codex Sessions" })).toBeVisible();
  await expect(page.getByText("Investigate the atlas workflow across all local Codex sources.").last()).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Find in selected transcript" })).toHaveValue("atlas");
  await expect(page.getByText("1 of 2 visible matches")).toBeVisible();
  await page.getByRole("button", { name: "Next transcript match" }).click();
  await expect(page.getByText("2 of 2 visible matches")).toBeVisible();

  await page.keyboard.press("Meta+k");
  await expect(page.getByText("3 results for “atlas”")).toBeVisible();
  await page.getByRole("button", { name: /search-fixture.*atlas_records/ }).click();
  await expect(page.getByRole("heading", { name: "search-fixture" })).toBeVisible();
  await expect(page.getByText("atlas_records", { exact: true })).toBeVisible();
});

test("keeps unified search usable from the mobile module menu", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Choose workspace" }).click();
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search all Codex data" }).fill("atlas");
  await page.getByRole("button", { name: "Search everything", exact: true }).click();
  await expect(page.getByText("3 results for “atlas”")).toBeVisible();
  await expect(page.getByRole("button", { name: /Atlas search fixture/ })).toBeVisible();
});

test("protects an unsaved Memory edit when opening global search", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Markdown memory" }).click();
  await page.getByRole("button", { name: /MEMORY\.md/ }).click();
  await page.getByRole("button", { name: "Edit" }).click();
  const editor = page.locator("textarea");
  await editor.fill(`${await editor.inputValue()}\nUnsaved atlas note.`);

  page.once("dialog", (dialog) => dialog.dismiss());
  await page.keyboard.press("Meta+k");
  await expect(page.getByRole("heading", { name: "Codex Memory" })).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await page.keyboard.press("Meta+k");
  await expect(page.getByRole("heading", { name: "Search everything" })).toBeVisible();
});
