import { expect, test, type Locator } from "@playwright/test";

test.use({ timezoneId: "UTC" });

test("table and query cells distinguish durations and ordinals from timestamps", async ({ page }) => {
  const seconds = Date.parse("2026-09-22T12:00:00Z") / 1000;
  const row = { execution_time: 250000, updated_at_ordinal: 42, ts: seconds, generated_at: seconds, created_at_ms: seconds * 1000 };
  const columns = Object.keys(row);
  const database = {
    id: "formatting", name: "formatting-fixture", filename: "formatting.sqlite", path: "/fixture/formatting.sqlite", relativePath: "formatting.sqlite",
    group: "Custom store", size: 4096, modifiedAt: seconds * 1000, journalMode: "delete",
    tables: [{ name: "timing", sql: "", columns: columns.map((name, cid) => ({ cid, name, type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 })), foreignKeys: [], indexes: [], rowEstimate: 1, allocatedBytes: 4096 }],
  };
  await page.route("**/api/catalog", route => route.fulfill({ json: { databases: [database] } }));
  await page.route("**/api/analysis?**", route => route.fulfill({ json: { metrics: { size: 4096, tables: 1, rows: 1, modifiedAt: seconds * 1000 }, activity: [], breakdown: [], insight: "Fixture" } }));
  await page.route("**/api/table?**", route => route.fulfill({ json: { rows: [row], total: 1 } }));
  await page.route("**/api/query", route => route.fulfill({ json: { rows: [row], columns, durationMs: 1, limited: false } }));
  const checkCells = async (table: Locator) => {
    await expect(table.getByRole("cell", { name: "250000", exact: true })).toBeVisible();
    await expect(table.getByRole("cell", { name: "42", exact: true })).toBeVisible();
    await expect(table.getByRole("cell", { name: /Sep 22, 2026/ })).toHaveCount(3);
  };
  await page.goto("/");
  await page.getByRole("button", { name: "SQLite databases", exact: true }).click();
  await page.getByRole("button", { name: "Table browser", exact: true }).click();
  await checkCells(page.getByRole("region", { name: "timing records", exact: true }));
  await page.getByRole("button", { name: "Query lab", exact: true }).click();
  await page.getByRole("button", { name: "Run query", exact: true }).click();
  await checkCells(page.getByRole("region", { name: "Query results", exact: true }));
});
