import { expect, test } from "@playwright/test";
import type { UsageData } from "../../lib/usage-report";

const since = Date.parse("2026-09-01T00:00:00Z") / 1000;
const dimensions = { model: "large", effort: "high", speed: "normal" } as const;
const usage = { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 1 };
const coverage = { files: 1, scanned: 1, skippedRecords: 0, invalidUsage: 0, missingTime: 0, duplicateEvents: 0, rewrittenSessions: 0, undatedUsage: 0 };

test("restores, filters and regenerates a 150,000-event session without losing totals", async ({ page }) => {
  test.setTimeout(60000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const data: UsageData = {
    since, until: since + 3600, generatedAt: since,
    sessions: [{ id: "large", title: "Large session", parent: "", project: "fixture", sources: [] }],
    events: Array.from({ length: 150000 }, (_, i) => ({ ...dimensions, effort: i % 2 ? "medium" : "high", t: since + i % 3600,
      sessionId: "large", turn: "turn", source: "fixture", line: i + 1, usage })),
    intervals: [], snapshots: [], coverage,
  };
  await page.route("**/api/usage**", route => route.fulfill({ json: data }));
  await page.goto("/");
  await page.getByRole("button", { name: "Usage report", exact: true }).click();
  await expect(page.getByTestId("usage-total")).toHaveText("150,000", { timeout: 30000 });
  await page.getByRole("combobox", { name: "Effort", exact: true }).selectOption("high");
  await expect(page.getByTestId("usage-total")).toHaveText("75,000");
  await page.getByRole("button", { name: "Regenerate report", exact: true }).click();
  await expect(page.getByTestId("usage-total")).toHaveText("150,000", { timeout: 30000 });
  expect(errors).toEqual([]);
});

test("quota bucket and minimum-duration controls retain ownership results", async ({ page }) => {
  const data: UsageData = {
    since, until: since + 1800, generatedAt: since,
    sessions: [{ id: "quota", title: "Quota fixture", parent: "", project: "fixture", sources: [] }],
    events: [{ ...dimensions, t: since + 1, sessionId: "quota", turn: "turn", source: "fixture", line: 1, usage }],
    intervals: [{ ...dimensions, sessionId: "quota", turn: "turn", start: since, end: since + 1200, partial: false }],
    snapshots: [10080, 300].flatMap(windowMinutes => Array.from({ length: windowMinutes === 300 ? 4 : 7 }, (_, i) => ({
      ...dimensions, t: since + i * 200, sessionId: "quota", usedPercent: 10 + i, resetsAt: since + 10000, limitId: "codex", windowMinutes,
      source: "fixture", line: i + 1, reliable: true,
    }))), coverage,
  };
  await page.route("**/api/usage**", route => route.fulfill({ json: data }));
  await page.goto("/");
  await page.getByRole("button", { name: "Usage report", exact: true }).click();
  const comparison = page.getByRole("region", { name: "Isolated quota comparison" });
  await expect(page.getByText(/7 reliable readings/)).toBeVisible();
  await expect(comparison.getByRole("cell", { name: "large · high · normal", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Minimum quota window" }).selectOption("30");
  await expect(comparison).toHaveCount(0);
  await page.getByRole("combobox", { name: "Minimum quota window" }).selectOption("5");
  await expect(comparison).toBeVisible();
  await page.getByRole("combobox", { name: "Quota bucket" }).selectOption("codex/300");
  await expect(page.getByText(/4 reliable readings/)).toBeVisible();
  await expect(comparison).toBeVisible();
  await expect(page.getByTestId("usage-total")).toHaveText("1");
});
