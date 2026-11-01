import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/compare-usage-reports.mjs", import.meta.url));

test("report comparison ignores generation time and detects changed records", () => {
  const directory = mkdtempSync(join(tmpdir(), "usage-report-compare-"));
  const before = join(directory, "before.json"), after = join(directory, "after.json");
  const report = { since: 1, until: 2, generatedAt: 3.5, events: [{ sessionId: "a", text: "x".repeat(65500) + "😀", total: 2 }] };
  const compare = () => spawnSync(process.execPath, [script, before, after], { encoding: "utf8" });
  try {
    writeFileSync(before, JSON.stringify(report));
    writeFileSync(after, JSON.stringify({ ...report, generatedAt: 4 }));
    assert.equal(compare().status, 0);
    writeFileSync(after, JSON.stringify({ ...report, events: [{ ...report.events[0], sessionId: "b" }] }));
    assert.equal(compare().status, 1);
    writeFileSync(after, JSON.stringify({ ...report, events: [{ ...report.events[0], total: 3 }] }));
    assert.equal(compare().status, 1);
    writeFileSync(after, "{}");
    assert.notEqual(compare().status, 0);
    rmSync(after);
    assert.notEqual(compare().status, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
