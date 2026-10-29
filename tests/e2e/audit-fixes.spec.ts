import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

test.use({ timezoneId: "UTC" });

test("real table, row details, query and CSV retain unsafe SQLite integers", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "SQLite databases", exact: true }).click();
  await page.getByRole("button", { name: /^search-fixture / }).click();
  await page.getByRole("button", { name: "Table browser", exact: true }).click();
  await page.getByRole("combobox", { name: "Choose table", exact: true }).selectOption("exact_integers");
  const records = page.getByRole("region", { name: "exact_integers records" });
  await expect(records.getByRole("cell", { name: "9007199254740993", exact: true })).toBeVisible();
  await records.getByRole("row").filter({ has: page.getByRole("cell", { name: "9007199254740993", exact: true }) }).getByRole("button").click();
  await expect(page.getByRole("dialog", { name: "Row details" })).toContainText("9007199254740993");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Query lab", exact: true }).click();
  await page.getByRole("textbox", { name: "SQL query", exact: true }).fill("SELECT value FROM exact_integers");
  await page.getByRole("button", { name: "Run query", exact: true }).click();
  await expect(page.getByRole("region", { name: "Query results" }).getByRole("cell", { name: "9007199254740993", exact: true })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV", exact: true }).click();
  const file = await (await download).path();
  expect(file).not.toBeNull();
  const csv = await readFile(file!, "utf8");
  for (const value of ["9007199254740993", "-9007199254740993", "-9223372036854775808"]) expect(csv).toContain(`"${value}"`);
});

test("real Usage report regenerates, filters and restores equivalent fixture totals", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Usage report", exact: true }).click();
  await page.getByLabel("Report from", { exact: true }).fill("2026-09-04T00:00");
  await page.getByLabel("Report to", { exact: true }).fill("2026-09-05T00:00");
  for (let iteration = 0; iteration < 2; iteration++) {
    await page.getByRole("button", { name: /^(Generate|Regenerate) report$/ }).click();
    await expect(page.getByTestId("usage-total")).toHaveText("150");
    await page.getByRole("combobox", { name: "Model", exact: true }).selectOption("fixture-fast");
    await expect(page.getByTestId("usage-total")).toHaveText("100");
    await page.getByRole("combobox", { name: "Model", exact: true }).selectOption("");
    await page.getByRole("combobox", { name: "Effort", exact: true }).selectOption("low");
    await expect(page.getByTestId("usage-total")).toHaveText("50");
    await page.getByRole("combobox", { name: "Effort", exact: true }).selectOption("");
    await page.getByRole("combobox", { name: "Speed", exact: true }).selectOption("fast");
    await expect(page.getByTestId("usage-total")).toHaveText("100");
    await page.getByRole("combobox", { name: "Speed", exact: true }).selectOption("");
  }
  await page.reload();
  await page.getByRole("button", { name: "Usage report", exact: true }).click();
  await expect(page.getByTestId("usage-total")).toHaveText("150");
});
