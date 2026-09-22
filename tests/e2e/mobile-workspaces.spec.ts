import { expect, test } from "@playwright/test";

test("mobile memory browsing returns keyboard focus to the selected document", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Choose workspace" }).click();
  await page.getByRole("button", { name: "Markdown memory", exact: true }).click();

  const browse = page.locator("#memory-browser > summary");
  const search = page.getByRole("textbox", { name: "Search Memory contents" });
  await expect(browse).toBeVisible();
  await expect(search).not.toBeVisible();
  await expect(page.getByRole("region", { name: "Memory preview" })).toBeInViewport();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);

  await browse.focus();
  await page.keyboard.press("Enter");
  await expect(search).toBeVisible();
  await page.getByRole("button", { name: /Atlas search fixture/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Atlas search fixture" })).toBeVisible();
  await expect(search).not.toBeVisible();
  await expect(page.locator("#memory-document")).toBeFocused();

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);

  await page.route("**/api/memory/document?*", route => route.fulfill({ status: 503, json: { error: "Could not open this file. Try again." } }));
  const reopen = page.getByRole("button", { name: "Browse files", exact: true });
  await expect(reopen).toBeInViewport();
  await reopen.focus();
  await page.keyboard.press("Enter");
  await expect(browse).toBeFocused();
  await expect(browse).toBeInViewport();
  await expect(search).toBeVisible();
  const nextFile = page.getByRole("button", { name: /MEMORY\.md/ });
  await nextFile.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Could not open this file. Try again.");
  await expect(search).toBeVisible();
  await expect(nextFile).toBeFocused();
  await expect(page.getByRole("heading", { name: "Atlas search fixture" })).toBeVisible();
});

test("mobile session browsing closes after selecting a filtered session", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Choose workspace" }).click();
  await page.getByRole("button", { name: "Session archive", exact: true }).click();

  const browse = page.locator("#session-browser > summary");
  const project = page.getByRole("combobox", { name: "Filter sessions by project" });
  await expect(page.getByRole("region", { name: "Session transcript" })).toBeVisible();
  await expect(project).not.toBeVisible();
  await browse.focus();
  await page.keyboard.press("Enter");
  await project.selectOption("atlas-project");
  await page.getByRole("button", { name: /^atlas-project User atlas-session/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Investigate the atlas workflow across all local Codex sources.").last()).toBeVisible();
  await expect(project).not.toBeVisible();
  await expect(page.locator("#session-document")).toBeFocused();

  const reopen = page.getByRole("button", { name: "Browse sessions", exact: true });
  await expect(reopen).toBeInViewport();
  await reopen.click();
  await expect(browse).toBeFocused();
  await expect(browse).toBeInViewport();
  await expect(project).toHaveValue("atlas-project");
  await expect(project).toBeVisible();
});
