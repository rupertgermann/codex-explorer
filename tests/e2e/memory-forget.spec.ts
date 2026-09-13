import { expect, test } from "@playwright/test";

test("selects, refreshes and cancels Project Forget while protecting unsaved editor changes", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Markdown memory" }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = page.locator("textarea");
  const original = await editor.inputValue();
  await editor.fill(`${original}\nUnsaved editor work.\n`);
  await expect(page.getByRole("button", { name: "Forget project…" })).toBeDisabled();
  await editor.fill(original);
  await page.getByRole("button", { name: "Forget project…" }).click();
  const dialog = page.getByRole("dialog", { name: "Forget project…" });
  const directory = dialog.getByLabel("Project directory");
  await expect(directory).toBeEnabled();
  await expect(dialog.locator('datalist option[value="/work/app"]')).toHaveCount(1);
  await directory.fill("/work/app");
  await dialog.getByRole("button", { name: "Preview project" }).click();
  await expect(dialog.getByText("Matching stage1_outputs (2)")).toBeVisible();
  await expect(dialog.getByText("Retained shared Memories (1)")).toBeVisible();
  await expect(dialog.getByText(/2 matching sessions stay untouched/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Apply Forget plan" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Refresh preview" }).click();
  await expect(dialog.getByRole("button", { name: "Refresh preview" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(editor).toHaveValue(original);
});

test("previews, applies, and manually rechecks one visible Summary Memory", async ({ page }) => {
  const invalid = await page.request.post("/api/memory/forget", { data: { action: "apply", plan: {} } });
  expect(invalid.status()).toBe(400);
  await expect(invalid.json()).resolves.toEqual({ error: "A valid confirmed Forget plan is required." });

  await page.goto("/");
  await page.getByRole("button", { name: "Markdown memory" }).click();
  await page.getByRole("button", { name: /memory_summary\.md/ }).click();
  await expect(page.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Delete orphaned file…" })).toHaveCount(0);
  await page.getByRole("button", { name: "Preview" }).click();

  await page.getByRole("button", { name: "Forget…" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Forget this Memory?" });
  await expect(dialog.getByText("Confirm the durable sources")).toBeVisible();
  await dialog.getByRole("button", { name: "Update plan" }).click();
  await expect(dialog.getByText("Exact affected sections (5)")).toBeVisible();
  await dialog.getByRole("button", { name: "Apply Forget plan" }).click();

  await expect(dialog.getByText("Memory removed and verified; delete tombstone written.")).toBeVisible();
  await expect(dialog.getByText("memory_summary.md", { exact: true }).last()).toBeVisible();
  await dialog.getByRole("button", { name: "Recheck now" }).click();
  await expect(dialog.getByText("No positive copy currently appears in the Memory corpus.")).toBeVisible();
});

test("reaches orphan deletion only through the dedicated advanced workflow", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Markdown memory" }).click();
  await page.getByRole("combobox").selectOption("rollout_summaries");
  await page.getByRole("button", { name: /rollout_summaries\/orphan\.md/ }).click();

  await expect(page.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Delete orphaned file…" }).click();

  const dialog = page.getByRole("dialog", { name: "Delete orphaned file?" });
  await expect(dialog.getByText("rollout_summaries/orphan.md", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/Revision [0-9a-f]{64}/)).toBeVisible();
  await expect(dialog.getByText("No blockers found. This file is an eligible orphan.")).toBeVisible();
  const apply = dialog.getByRole("button", { name: "Delete confirmed orphan" });
  await expect(apply).toBeDisabled();
  await dialog.getByRole("checkbox", { name: /I confirm/ }).check();
  await expect(apply).toBeEnabled();
  await apply.click();

  await expect(dialog.getByText("The confirmed orphan file was deleted.")).toBeVisible();
  await expect(page.getByRole("button", { name: /rollout_summaries\/orphan\.md/ })).toHaveCount(0);
});
