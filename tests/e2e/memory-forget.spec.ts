import { expect, test } from "@playwright/test";

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

test("previews every project Memory source without exposing Apply", async ({ page }) => {
  const response = await page.request.post("/api/memory/forget", { data: { action: "project-preview", directory: "/work/alpha" } });
  expect(response.status()).toBe(200);
  const preview = await response.json();
  expect(preview).toMatchObject({
    actionable: true,
    scopes: ["/work/alpha"],
    sessionCount: 1,
    databaseRows: [{ threadId: "thread-alpha" }],
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Markdown memory" }).click();
  await page.getByRole("button", { name: "Forget project…" }).click();
  const dialog = page.getByRole("dialog", { name: "Preview Project Forget" });
  await dialog.getByLabel("Project directory").fill("/work/alpha");
  await dialog.getByRole("button", { name: "Preview project" }).click();

  await expect(dialog.getByText("/work/alpha", { exact: true }).first()).toBeVisible();
  await expect(dialog.getByText("5 affected sections")).toBeVisible();
  await expect(dialog.getByText("1 active Memory database row")).toBeVisible();
  await expect(dialog.getByText("thread-alpha · alpha · selected for phase 2", { exact: true })).toBeVisible();
  await expect(dialog.getByText("1 matching session remains read-only")).toBeVisible();
  await expect(dialog.getByText("Shared Memories retained")).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Apply/ })).toHaveCount(0);
});
