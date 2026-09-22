import { expect, test } from "@playwright/test";
import type { UsageData } from "../../lib/usage-report";

test("dense chart legends are keyboard accessible and keep their state in fullscreen", async ({ page }) => {
  const since = Date.parse("2026-09-01T00:00:00Z") / 1000;
  const models = Array.from({ length: 6 }, (_, index) => `model-${index}`);
  const report: UsageData = {
    since, until: since + 86400, generatedAt: since + 86400,
    sessions: models.map(id => ({ id, title: id, project: "fixture", parent: "", sources: [] })),
    events: models.map((model, index) => ({
      t: since + 3600 + index * 10, sessionId: model, turn: model, model, effort: "high", speed: "normal", source: "fixture", line: 1,
      usage: { input_tokens: 100, cached_input_tokens: 50, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 },
    })),
    intervals: [], snapshots: [],
    coverage: { files: 6, scanned: 6, skippedRecords: 0, invalidUsage: 0, missingTime: 0, duplicateEvents: 0, rewrittenSessions: 0, undatedUsage: 0 },
  };
  await page.route("**/api/usage**", route => route.fulfill({ json: report }));
  await page.goto("/");
  await page.getByRole("button", { name: "Usage report", exact: true }).click();
  const plot = page.getByRole("img", { name: "Tokens per hour by model, effort and speed, with remaining account quota" });
  await plot.locator("rect").filter({ hasText: "model-5" }).hover();
  const tooltip = page.getByRole("status").filter({ hasText: "Whole bucket:" });
  await expect(tooltip).toContainText("+1 other series in this hour");
  await expect(tooltip).toContainText("Total: 720");
  const legend = page.locator("details").filter({ has: page.locator("summary", { hasText: "All 6 series" }) });
  const lastSeries = legend.getByText("model-5 · high · normal", { exact: true });
  await expect(lastSeries).toBeHidden();
  await legend.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(lastSeries).toBeVisible();
  await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Tokens and remaining quota" });
  await expect(dialog.getByText("model-5 · high · normal", { exact: true })).toBeVisible();
  await page.keyboard.press("Meta+k");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Usage report", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Fullscreen", exact: true })).toBeFocused();
  await expect(lastSeries).toBeVisible();
  await page.getByRole("combobox", { name: "Model", exact: true }).selectOption("model-5");
  await expect(page.locator("summary", { hasText: "All 6 series" })).toHaveCount(0);
  await expect(page.getByTestId("usage-total")).toHaveText("120");
});
