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

const home = await realpath(await mkdtemp(join(tmpdir(), "codex-query-limit-")));
const previousHome = process.env.CODEX_HOME;
const previousDirectory = process.env.CODEX_DB_DIRECTORY;
process.env.CODEX_HOME = home;
delete process.env.CODEX_DB_DIRECTORY;
const path = join(home, "query.sqlite");
const fixture = new DatabaseSync(path);
fixture.exec("CREATE TABLE numbers (value INTEGER PRIMARY KEY); WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM n WHERE value < 10000) INSERT INTO numbers SELECT value FROM n");
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

test("a large result returns 500 rows without evaluating beyond one lookahead row", async () => {
  // Row 502 would overflow if collection continued after the 501st-row lookahead.
  const response = await query("SELECT CASE WHEN value = 502 THEN abs(-9223372036854775808) ELSE value END AS value FROM numbers");
  const body = await response.json();
  assert.equal(response.status, 200, body.error);
  assert.equal(body.rows.length, 500);
  assert.deepEqual(body.rows[0], { value: 1 });
  assert.deepEqual(body.rows[499], { value: 500 });
  assert.deepEqual(body.columns, ["value"]);
  assert.equal(body.limited, true);
  assert.deepEqual(await readFile(path), original);
});

test("the limited flag distinguishes 499, 500, and 501 matching rows", async () => {
  for (const [count, limited] of [[499, false], [500, false], [501, true]]) {
    const response = await query(`SELECT value FROM numbers WHERE value <= ${count}`);
    const body = await response.json();
    assert.equal(response.status, 200, body.error);
    assert.equal(body.rows.length, Math.min(count, 500));
    assert.equal(body.limited, limited, `${count} matching rows`);
  }
  assert.deepEqual(await readFile(path), original);
});

test("query errors remain visible and a later request can still read the unchanged database", async () => {
  for (const sql of [
    "SELECT missing_column FROM numbers",
    "SELECT CASE WHEN value = 501 THEN abs(-9223372036854775808) ELSE value END AS value FROM numbers",
  ]) {
    const response = await query(sql);
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.match(body.error, /no such column|integer overflow/);
    assert.equal(typeof body.durationMs, "number");
  }
  const response = await query("SELECT count(*) AS total FROM numbers");
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).rows, [{ total: 10000 }]);
  assert.deepEqual(await readFile(path), original);
});
