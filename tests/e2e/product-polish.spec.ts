import { expect, test, type Page } from "@playwright/test";
import type { UsageData } from "../../lib/usage-report";

async function openDatabase(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "SQLite databases", exact: true }).click();
  await page.getByRole("button", { name: /^search-fixture / }).click();
  await expect(page.getByRole("heading", { name: "search-fixture" })).toBeVisible();
}

async function search(page: Page, query: string) {
  await page.keyboard.press("Meta+k");
  await page.getByRole("searchbox", { name: "Search all Codex data" }).fill(query);
  await page.getByRole("main").getByRole("button", { name: "Search everything", exact: true }).click();
}

test("empty catalog has a recovery action and failed discovery can be retried", async ({ page }) => {
  let state = "empty";
  await page.route("**/api/catalog", route => state === "live" ? route.continue() : route.fulfill({
    status: state === "empty" ? 200 : 500,
    json: state === "empty" ? { databases: [] } : { error: "Store unavailable" },
  }));
  await page.goto("/");
  await page.getByRole("button", { name: "SQLite databases", exact: true }).click();
  await expect(page.getByText("No SQLite databases found")).toBeVisible();
  state = "error";
  await page.getByRole("button", { name: "Refresh database catalog" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Store unavailable");
  state = "live";
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("button", { name: /^search-fixture / })).toBeVisible();
});

test("table inventory opens records, pagination is accurate, and row details work by keyboard", async ({ page }) => {
  await openDatabase(page);
  await page.getByRole("button", { name: "atlas_records", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Choose table" })).toHaveValue("atlas_records");
  await expect(page.getByRole("status", { name: "Table rows" })).toHaveText("1–50 of 65");
  const row = page.getByRole("button", { name: "Open row 1 details" });
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Row details" })).toContainText("Record 65");
  await page.keyboard.press("Escape");
  await expect(row).toBeFocused();
  await page.getByRole("button", { name: "Next table page" }).click();
  await expect(page.getByRole("status", { name: "Table rows" })).toHaveText("51–65 of 65");
  await expect(page.getByRole("button", { name: "Next table page" })).toBeDisabled();
  await page.getByRole("textbox", { name: "Search table rows" }).fill("missing-polish-record");
  await expect(page.getByText("No matching rows", { exact: true })).toBeVisible();
  await expect(page.getByRole("status", { name: "Table rows" })).toHaveText("0 rows");
  await page.getByRole("button", { name: "Clear table search" }).click();
  await expect(page.getByRole("status", { name: "Table rows" })).toHaveText("1–50 of 65");
  await page.getByRole("combobox", { name: "Choose table" }).selectOption("empty_records");
  await expect(page.getByText("This table is empty", { exact: true })).toBeVisible();
  await expect(page.getByRole("status", { name: "Table rows" })).toHaveText("0 rows");
});

test("late table responses cannot replace the latest search", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const requested = new Promise<void>(resolve => { started = resolve; });
  await page.route("**/api/table?**", async route => {
    if (new URL(route.request().url()).searchParams.get("search") !== "Record") return route.continue();
    const response = await route.fetch();
    started();
    await held;
    await route.fulfill({ response });
  });
  await openDatabase(page);
  await page.getByRole("button", { name: "atlas_records", exact: true }).click();
  await page.getByRole("textbox", { name: "Search table rows" }).fill("Record");
  await requested;
  await page.getByRole("textbox", { name: "Search table rows" }).fill("does-not-exist");
  await expect(page.getByRole("status", { name: "Table rows" })).toHaveText("0 rows");
  release();
  await expect(page.getByText("No matching rows", { exact: true })).toBeVisible();
});

test("SQL results and drafts survive navigation and failed runs clear stale timing", async ({ page }) => {
  await openDatabase(page);
  await page.getByRole("button", { name: "Query lab", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "SQL query" });
  await editor.fill("SELECT 42 AS answer");
  await editor.press("Control+Enter");
  await expect(page.getByRole("cell", { name: "42", exact: true })).toBeVisible();
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.reject(new Error("Clipboard unavailable")) } }));
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Could not copy");
  await expect(page.getByRole("cell", { name: "42", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Schema", exact: true }).click();
  await page.getByRole("button", { name: "Query lab", exact: true }).click();
  await expect(editor).toHaveValue("SELECT 42 AS answer");
  await page.getByRole("button", { name: "Session archive", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Codex Sessions" })).toBeVisible();
  await page.getByRole("button", { name: "SQLite databases", exact: true }).click();
  await expect(editor).toHaveValue("SELECT 42 AS answer");
  await editor.fill("SELECT * FROM no_such_table");
  await editor.press("Meta+Enter");
  await expect(page.getByRole("main").getByRole("alert").filter({ hasText: "Query could not complete" })).toContainText("no such table");
  await expect(page.getByRole("cell", { name: "42", exact: true })).not.toBeVisible();
  await expect(page.getByRole("main").getByText(/^\d+\.\d ms$/)).not.toBeVisible();
  await editor.fill(" ");
  await expect(page.getByRole("button", { name: "Run query" })).toBeDisabled();
});

test("saved usage reports support filtering, keyboard details, chart recovery, and narrow screens", async ({ page }) => {
  const since = Date.parse("2026-09-01T00:00:00Z") / 1000;
  const report: UsageData = {
    since, until: since + 86400, generatedAt: since + 86400,
    sessions: ["A", "B"].map(id => ({ id, title: `Report session ${id}`, project: "fixture", parent: "", sources: [`${id}.jsonl`] })),
    events: ["A", "B"].map((id, index) => ({ t: since + (index + 1) * 3600, sessionId: id, turn: id, model: `model-${id}`, effort: "high", speed: "normal", source: `${id}.jsonl`, line: 1, usage: { input_tokens: 100, cached_input_tokens: 50, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 } })),
    intervals: [], snapshots: [],
    coverage: { files: 2, scanned: 2, skippedRecords: 0, invalidUsage: 0, missingTime: 0, duplicateEvents: 0, rewrittenSessions: 0, undatedUsage: 0 },
  };
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/usage**", async route => {
    if (route.request().method() === "POST") return route.fulfill({ status: 500, json: { error: "Scan interrupted" } });
    await held;
    await route.fulfill({ json: report });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Usage report", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Report from", exact: true })).toBeDisabled();
  release();
  await expect(page.getByTestId("usage-total")).toHaveText("240");
  await page.getByRole("combobox", { name: "Model", exact: true }).selectOption("model-A");
  await expect(page.getByTestId("usage-total")).toHaveText("120");
  await page.getByRole("button", { name: "Report session A", exact: true }).click();
  await expect(page.locator("#usage-session-details")).toBeFocused();
  await page.getByRole("button", { name: "Clear selection", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Search report sessions" })).toBeFocused();
  await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Tokens and remaining quota" });
  await expect(dialog.getByRole("button", { name: "Close dialog", exact: true })).toHaveCount(1);
  await dialog.getByRole("textbox", { name: "Chart from" }).fill("2027-01-01T00:00");
  await dialog.getByRole("button", { name: "Apply range" }).click();
  await expect(dialog.getByRole("alert")).toContainText("outside this report");
  await dialog.getByRole("button", { name: "Zoom in" }).click();
  await expect(dialog.getByRole("alert")).not.toBeVisible();
  const zoomedFrom = await dialog.getByRole("textbox", { name: "Chart from" }).inputValue();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Fullscreen", exact: true })).toBeFocused();
  await expect(page.getByRole("textbox", { name: "Chart from" })).toHaveValue(zoomedFrom);
  await page.getByRole("button", { name: "Regenerate report" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Scan interrupted");
  await expect(page.getByTestId("usage-total")).toHaveText("120");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("textbox", { name: "Search report sessions" }).fill("this-session-does-not-exist");
  await expect(page.getByRole("status")).toContainText("No sessions match");
  await expect.poll(() => page.getByRole("button", { name: "Clear search", exact: true }).evaluate(element => { const rect = element.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth; })).toBe(true);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Search report sessions" })).toBeFocused();
  await page.setViewportSize({ width: 320, height: 700 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("query templates work with older Memory database schemas", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "SQLite databases", exact: true }).click();
  await page.getByRole("button", { name: "Query lab", exact: true }).click();
  const response = page.waitForResponse(response => response.url().endsWith("/api/query"));
  await page.getByRole("button", { name: "Run query", exact: true }).click();
  expect((await response).ok()).toBe(true);
  await expect(page.getByRole("main").getByRole("alert")).not.toBeVisible();
});

test("fast search results are usable before sessions finish and cancellation keeps them", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/sessions/search?**", async route => {
    await held;
    await route.fulfill({ json: { results: [] } });
  });
  await page.goto("/");
  await search(page, "atlas");
  await expect(page.getByRole("button", { name: /Atlas search fixture/ })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Searching Sessions");
  await page.getByRole("button", { name: "Cancel search" }).click();
  await expect(page.getByRole("status")).toContainText("partial results");
  release();
  await page.getByRole("button", { name: /Atlas search fixture/ }).click();
  await expect(page.getByRole("heading", { name: "Atlas search fixture" })).toBeVisible();
});

test("search reports failed sources while successful results remain actionable", async ({ page }) => {
  await page.route("**/api/sessions/search?**", route => route.fulfill({ status: 500, json: { error: "Archive temporarily unavailable" } }));
  await page.goto("/");
  await search(page, "atlas");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Sessions: Archive temporarily unavailable");
  await expect(page.getByRole("button", { name: /Atlas search fixture/ })).toBeVisible();
});

test("Memory supports keyboard save and confirmed discard without losing a rejected edit", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Markdown memory", exact: true }).click();
  await page.getByRole("button", { name: /atlas\.md/ }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Memory Markdown" });
  const original = await editor.inputValue();
  await editor.fill(`${original}\nA disposable keyboard-save check.\n`);
  await editor.press("Meta+s");
  await expect(page.getByRole("status")).toContainText("Saved atlas.md");
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await editor.fill(original);
  await editor.press("Control+s");
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await page.route("**/api/memory/document", route => route.request().method() === "PUT" ? route.fulfill({ status: 409, json: { error: "This file changed on disk. Reopen it before saving." } }) : route.continue());
  await editor.fill(`${original}\nKeep this unsaved draft.`);
  await editor.press("Meta+s");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("changed on disk");
  await expect(editor).toHaveValue(`${original}\nKeep this unsaved draft.`);
  page.once("dialog", dialog => dialog.dismiss());
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(editor).toHaveValue(`${original}\nKeep this unsaved draft.`);
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(editor).toHaveValue(original);
});

test("session filters, transcript search, and raw viewing survive a workspace visit", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Session archive", exact: true }).click();
  await page.getByRole("combobox", { name: "Filter sessions by project" }).selectOption("atlas-project");
  await page.getByRole("button", { name: /^atlas-project User atlas-session/ }).click();
  await page.getByRole("textbox", { name: "Find in selected transcript" }).fill("atlas");
  await expect(page.getByText("1 of 2 visible matches")).toBeVisible();
  await page.getByRole("button", { name: "Next transcript match" }).click();
  await expect(page.getByText("2 of 2 visible matches")).toBeVisible();
  await page.getByRole("button", { name: "Raw JSONL", exact: true }).click();
  await expect(page.getByText(/Bytes 1–/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Previous raw page" })).toBeDisabled();
  await page.getByRole("button", { name: "Markdown memory", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Codex Memory" })).toBeVisible();
  await page.getByRole("button", { name: "Session archive", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Filter sessions by project" })).toHaveValue("atlas-project");
  await expect(page.getByRole("button", { name: "Raw JSONL", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Reset filters" }).click();
  await expect(page.getByRole("combobox", { name: "Filter sessions by project" })).toHaveValue("All");
});

test("mobile workspaces have named navigation, fit the viewport, and expose the database selector", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  for (const [workspace, heading] of [["Markdown memory", "Codex Memory"], ["Session archive", "Codex Sessions"], ["Usage report", "Usage report"], ["SQLite databases", "memories_1"], ["Search", "Search everything"]]) {
    await page.getByRole("button", { name: "Choose workspace" }).click();
    await expect(page.getByRole("navigation", { name: "Workspaces" }).getByRole("button")).toHaveCount(5);
    await page.getByRole("navigation", { name: "Workspaces" }).getByRole("button", { name: workspace, exact: true }).click();
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Choose workspace" })).toHaveAttribute("aria-expanded", "false");
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (workspace === "SQLite databases") await expect(page.getByRole("combobox", { name: "Choose database" })).toBeVisible();
  }
  await page.getByRole("button", { name: "Choose workspace" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Choose workspace" })).toHaveAttribute("aria-expanded", "false");
  await page.setViewportSize({ width: 320, height: 700 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
