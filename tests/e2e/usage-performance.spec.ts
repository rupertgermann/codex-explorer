import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { buildUsageReport, csvText, perHour, usageBuckets, type UsageData } from "../../lib/usage-report";

const since = Date.parse("2026-09-01T00:00:00Z") / 1000;
const dimensions = { model: "large", effort: "high", speed: "normal" } as const;
const usage = { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 1 };
const coverage = { files: 1, scanned: 1, skippedRecords: 0, invalidUsage: 0, missingTime: 0, duplicateEvents: 0, rewrittenSessions: 0, undatedUsage: 0 };

for (const hours of [1, 6] as const) {
  test(`downloads exact per-session ${hours}-hour CSV with report-aligned boundaries`, async ({ page }) => {
    const start = 123.0001, until = start + 2 * 86400 + 123.5;
    const data: UsageData = {
      since: start, until, generatedAt: start, snapshots: [], coverage,
      sessions: ["boundary", '=root;"quoted"\nnext', "child", "final"].map((id, i) => ({
        id, title: `Session ${i}`, parent: i === 2 ? "root" : "", project: "fixture", sources: [],
      })),
      events: [], intervals: [],
    };
    for (const [sessionIndex, offset, total, effort] of [[0, 3 * hours * 3600, 1, "high"], [1, 10, 5, "high"],
      [1, 21600, 9, "medium"], [2, 7200, 3, "high"], [3, until - start, 4, "medium"]] as const) {
      const sessionId = data.sessions[sessionIndex].id;
      data.events.push({ ...dimensions, model: 'model;"quoted"', effort, t: start + offset, sessionId, turn: "turn", source: "fixture", line: 1,
        usage: { input_tokens: total, cached_input_tokens: 1, cache_write_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1, total_tokens: total + 3 } });
      if (sessionIndex !== 0) data.intervals.push({ ...dimensions, model: 'model;"quoted"', effort, sessionId, turn: "turn",
        start: start + offset - 60, end: start + offset + 60, partial: false });
    }
    await page.route("**/api/usage**", route => route.fulfill({ json: data }));
    await page.goto("/");
    await page.getByRole("button", { name: "Usage report", exact: true }).click();
    await expect(page.getByTestId("usage-total")).toHaveText("37");
    const kind = hours === 1 ? "session-hourly" : "session-six-hourly";
    await page.getByRole("combobox", { name: "Export dataset" }).selectOption(kind);
    for (const effort of [undefined, "high"]) {
      if (effort) await page.getByRole("combobox", { name: "Effort", exact: true }).selectOption(effort);
      const report = buildUsageReport(data, { effort });
      const rows = report.sessions.flatMap(session => usageBuckets(report.events.filter(e => e.sessionId === session.id),
        report.intervals.filter(i => i.sessionId === session.id), data.sessions, data.since, data.until, hours)
        .filter(b => b.start < session.end && b.end > session.start || b.total_tokens > 0)
        .map(b => ({ ...b, start: Math.max(b.start, session.start), end: Math.min(b.end, session.end) }))
        .map(({ series, ...b }) => ({ sessionId: session.id, ...b, start: new Date(b.start * 1000).toISOString(),
          end: new Date(b.end * 1000).toISOString(), tokensPerClockHour: perHour(b.total_tokens, b.end - b.start), series })));
      const downloading = page.waitForEvent("download");
      await page.getByRole("button", { name: "Download CSV", exact: true }).click();
      const download = await downloading;
      expect(download.suggestedFilename()).toBe(`usage-${kind}.csv`);
      const csv = await readFile((await download.path())!, "utf8");
      expect(csv).toBe(csvText(rows));
      expect(csv.split("\r\n")[0]).toBe('\uFEFF"sessionId";"input_tokens";"cached_input_tokens";"cache_write_input_tokens";"output_tokens";"reasoning_output_tokens";"total_tokens";"start";"end";"activeSeconds";"rootTokens";"subagentTokens";"tokensPerClockHour";"series"');
    }
  });
}

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
