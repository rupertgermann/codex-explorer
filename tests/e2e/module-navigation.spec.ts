import { expect, test } from "@playwright/test";

test("keeps all five main modules above module navigation", async ({ page }) => {
  await page.setViewportSize({ width: 1115, height: 700 });
  await page.goto("/");
  const sidebar = page.getByRole("complementary");

  for (const [module, ready] of [
    ["Markdown memory", "Search all contents…"],
    ["Session archive", "Search session contents…"],
    ["SQLite databases", "Find a store…"],
  ]) {
    await sidebar.getByRole("button", { name: module, exact: true }).click();
    await expect(sidebar.getByPlaceholder(ready)).toBeVisible();
    await expect.poll(() => sidebar.evaluate((element) => {
      const menu = element.children[1];
      const buttons = [...menu.querySelectorAll("button")];
      return buttons.length === 5 && buttons.every((button) => {
        const rect = button.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= innerHeight
          && button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      }) && element.children[2].getBoundingClientRect().top >= menu.getBoundingClientRect().bottom;
    })).toBe(true);
  }

  await sidebar.getByRole("button", { name: "Markdown memory", exact: true }).click();
  await expect(sidebar.getByPlaceholder("Search all contents…")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("main").getByPlaceholder("Search all contents…")).toBeVisible();
  await page.setViewportSize({ width: 1115, height: 700 });
  await expect(sidebar.getByPlaceholder("Search all contents…")).toBeVisible();
});
