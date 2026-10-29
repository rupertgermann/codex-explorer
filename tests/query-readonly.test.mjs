import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
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

const home = mkdtempSync(join(tmpdir(), "query-readonly-"));
const path = join(home, "fixture.sqlite");
const fixture = new DatabaseSync(path);
fixture.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT); INSERT INTO notes VALUES (1, 'original')");
fixture.close();
process.env.CODEX_HOME = home;
delete process.env.CODEX_DB_DIRECTORY;
const { POST } = await import("../app/api/query/route.ts");
const databaseId = createHash("sha256").update(realpathSync(path)).digest("base64url").slice(0, 16);
after(() => rmSync(home, { recursive: true, force: true }));

async function query(sql) {
  const response = await POST(new Request("http://localhost/api/query", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ databaseId, sql }),
  }));
  return { status: response.status, body: await response.json() };
}

test("Query lab returns quoted write-keyword text", async () => {
  const result = await query("SELECT 'update' AS value");
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.rows, [{ value: "update" }]);
});

test("Query lab runs read-only replacement functions", async () => {
  const result = await query("SELECT replace(text, 'original', 'changed') AS value FROM notes");
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.rows, [{ value: "changed" }]);
});

test("Query lab keeps carriage returns inside SQLite line comments", async () => {
  const result = await query("SELECT 1 -- comment\r delete;");
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.rows, [{ "1 -- comment\r delete;": 1 }]);
});

test("Query lab rejects statements after a line comment ending at a newline", async () => {
  const result = await query("SELECT 1 -- comment\r '\n; SELECT 2; -- '");
  assert.equal(result.status, 400, JSON.stringify(result.body));
  assert.equal(result.body.error, "Run one statement at a time.");
});

test("Query lab accepts quoted punctuation, escaped quotes, comments, identifiers and supported query forms", async () => {
  const cases = [
    ["SELECT '; update' AS value", [{ value: "; update" }]],
    ["SELECT 'it''s; delete' AS value", [{ value: "it's; delete" }]],
    ['SELECT 1 AS "update;"', [{ "update;": 1 }]],
    ['SELECT 1 AS "a""delete;"', [{ 'a"delete;': 1 }]],
    ['SELECT 1 AS `drop;`', [{ "drop;": 1 }]],
    ['SELECT 1 AS [attach;]', [{ "attach;": 1 }]],
    ["/* update; */ SELECT id AS value FROM notes -- delete;\n; /* drop; */", [{ value: 1 }]],
    ["WITH selected AS (SELECT id FROM notes) SELECT id AS value FROM selected;", [{ value: 1 }]],
    ["SELECT replace /* delete; */ (text, 'original', 'ok') AS value FROM notes", [{ value: "ok" }]],
  ];
  for (const [sql, rows] of cases) {
    const result = await query(sql);
    assert.equal(result.status, 200, `${sql}: ${JSON.stringify(result.body)}`);
    assert.deepEqual(result.body.rows, rows, sql);
  }
  const plan = await query("EXPLAIN /* update; */ QUERY PLAN SELECT * FROM notes");
  assert.equal(plan.status, 200, JSON.stringify(plan.body));
  assert.ok(plan.body.rows.some((row) => row.detail.includes("notes")));
});

test("Query lab rejects mutations and extra executable statements without changing data or schema", async () => {
  const statements = [
    "UPDATE notes SET text = 'changed' RETURNING *",
    "DELETE FROM notes RETURNING *",
    "INSERT INTO notes VALUES (2, 'added')",
    "REPLACE INTO notes VALUES (1, 'changed')",
    "CREATE TABLE added (id INTEGER)",
    "ALTER TABLE notes ADD COLUMN extra TEXT",
    "DROP TABLE notes",
    "ATTACH DATABASE ':memory:' AS extra",
    "DETACH DATABASE main",
    "VACUUM",
    "REINDEX",
    "PRAGMA user_version = 42",
    "WITH chosen AS (SELECT 1) UPDATE notes SET text = 'changed' RETURNING *",
    "WITH chosen AS (SELECT 1) DELETE FROM notes RETURNING *",
    "EXPLAIN QUERY PLAN DELETE FROM notes",
    "SELECT id FROM notes; SELECT text FROM notes",
    "SELECT id FROM notes; -- harmless\nDELETE FROM notes",
    "SELECT ';' AS value; /* ; */ SELECT 2",
  ];
  for (const sql of statements) {
    const result = await query(sql);
    assert.equal(result.status, 400, sql);
    assert.equal(typeof result.body.error, "string", sql);
  }
  const rows = await query("SELECT * FROM notes");
  assert.deepEqual(rows.body.rows, [{ id: 1, text: "original" }]);
  const schema = await query("SELECT name, sql FROM sqlite_schema WHERE type = 'table'");
  assert.deepEqual(schema.body.rows, [{ name: "notes", sql: "CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT)" }]);
});

test("Database connections reject writes independently of Query lab validation", async () => {
  const { openReadonly } = await import("../lib/database.ts");
  const db = openReadonly(path);
  try {
    assert.throws(() => db.exec("UPDATE notes SET text = 'changed'"), /readonly/);
  } finally {
    db.close();
  }
});
