import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) return nextResolve(new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href, context);
    return nextResolve(specifier === "next/server" ? "next/server.js" : specifier, context);
  },
});

const home = await realpath(await mkdtemp(join(tmpdir(), "codex-query-empty-")));
const previousHome = process.env.CODEX_HOME;
const previousDirectory = process.env.CODEX_DB_DIRECTORY;
process.env.CODEX_HOME = home;
delete process.env.CODEX_DB_DIRECTORY;
const path = join(home, "query.sqlite");
const fixture = new DatabaseSync(path);
fixture.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, note TEXT)");
fixture.close();
const original = await readFile(path);
const databaseId = createHash("sha256").update(path).digest("base64url").slice(0, 16);
const { POST } = await import("../app/api/query/route.ts");

after(async () => {
  if (previousHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousHome;
  if (previousDirectory === undefined) delete process.env.CODEX_DB_DIRECTORY;
  else process.env.CODEX_DB_DIRECTORY = previousDirectory;
  await rm(home, { recursive: true, force: true });
});

async function query(sql) {
  return POST(new Request("http://localhost/api/query", {
    method: "POST",
    body: JSON.stringify({ databaseId, sql }),
    headers: { "Content-Type": "application/json" },
  }));
}

test("empty results retain selected names and aliases with a completed duration", async () => {
  for (const [sql, columns] of [
    ["SELECT * FROM records", ["id", "note"]],
    ['SELECT note AS "Selected note", id AS record_id FROM records', ["Selected note", "record_id"]],
  ]) {
    const response = await query(sql);
    const body = await response.json();
    assert.equal(response.status, 200, body.error);
    assert.deepEqual(body.rows, []);
    assert.deepEqual(body.columns, columns);
    assert.equal(typeof body.durationMs, "number");
    assert.ok(body.durationMs >= 0);
    assert.equal(body.limited, false);
  }
  assert.deepEqual(await readFile(path), original);
});

test("duplicate selected names preserve object-row and export columns", async () => {
  const response = await query("SELECT 1 AS x, 2 AS x");
  const body = await response.json();
  assert.equal(response.status, 200, body.error);
  assert.deepEqual(body.columns, ["x"]);
  assert.deepEqual(body.rows, [{ x: 2 }]);
});
