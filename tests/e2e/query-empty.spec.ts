import { expect, test } from "@playwright/test";

test("Query lab distinguishes ready, empty, populated and failed queries", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "SQLite databases", exact: true }).click();
  await page.getByRole("button", { name: /^search-fixture / }).click();
  await expect(page.getByRole("heading", { name: "search-fixture", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Query lab", exact: true }).click();
  await expect(page.getByText("Ready for a query", { exact: true })).toBeVisible();
  await expect(page.getByText(/^\d+\.\d ms$/)).toHaveCount(0);

  const editor = page.getByRole("textbox", { name: "SQL query", exact: true });
  await editor.fill('SELECT note AS "Selected note", id AS record_id FROM empty_records');
  await page.getByRole("button", { name: "Run query", exact: true }).click();
  await expect(page.getByText("No rows returned", { exact: true })).toBeVisible();
  await expect(page.getByText("The query completed successfully but the result set is empty.")).toBeVisible();
  await expect(page.getByText(/^\d+\.\d ms$/)).toBeVisible();
  await expect(page.getByText("Ready for a query", { exact: true })).toHaveCount(0);

  await editor.fill('SELECT atlas_note AS "Selected note" FROM atlas_records WHERE id = 1');
  await page.getByRole("button", { name: "Run query", exact: true }).click();
  const results = page.getByRole("region", { name: "Query results", exact: true });
  await expect(results.getByRole("columnheader", { name: "Selected note", exact: true })).toBeVisible();
  await expect(results.getByRole("cell", { name: "Record 1", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "CSV", exact: true })).toBeVisible();

  await editor.fill("SELECT missing_column FROM empty_records");
  await page.getByRole("button", { name: "Run query", exact: true }).click();
  const error = page.getByRole("alert").filter({ hasText: "Query could not complete" });
  await expect(error).toBeVisible();
  await expect(error).toContainText("no such column: missing_column");
  await expect(results).toHaveCount(0);
  await expect(page.getByText("No rows returned", { exact: true })).toHaveCount(0);
});
