import { expect, test } from "@playwright/test";

test("discards the previous Forget plan when the next preview fails", async ({ page }) => {
  const content = "# Summary\n\n- First remembered decision.\n- Second remembered decision.\n";
  const summary = {
    path: "memory_summary.md", name: "memory_summary.md", directory: "Root", title: "Summary",
    size: content.length, modifiedAt: 1, words: 8, headings: 1, hash: "fixture-revision", content,
  };
  await page.route("**/api/memory", route => route.fulfill({ json: {
    root: "/fixture/memory", files: [summary], directories: ["Root"],
    totals: { files: 1, bytes: content.length, words: 8, headings: 1 }, topTerms: [],
  } }));
  await page.route("**/api/memory/document?*", route => route.fulfill({ json: summary }));
  let previews = 0;
  await page.route("**/api/memory/forget", async route => {
    const request = route.request().postDataJSON();
    expect(request.action).toBe("preview");
    previews += 1;
    if (request.selection.summaryLine === 3) {
      await route.fulfill({ json: {
        fingerprint: "first-plan", target: "First remembered decision.", targets: ["First remembered decision."],
        actionable: true, reason: null, selection: request.selection, durableCandidates: [], sections: [],
      } });
    } else {
      await route.fulfill({ status: 503, json: { error: "Preview temporarily unavailable. Try again." } });
    }
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Markdown memory" }).click();
  await page.getByRole("button", { name: "Forget…", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Forget this Memory?" });
  await expect(dialog.getByRole("button", { name: "Apply Forget plan" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();

  await page.getByRole("button", { name: "Forget…", exact: true }).nth(1).click();
  await expect(dialog.getByRole("alert")).toHaveText("Preview temporarily unavailable. Try again.");
  await expect(dialog.getByRole("button", { name: "Apply Forget plan" })).toHaveCount(0);
  await expect(dialog.getByText("First remembered decision.", { exact: true })).toHaveCount(0);
  expect(previews).toBe(2);
});
