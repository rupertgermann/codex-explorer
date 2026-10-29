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

const home = await realpath(await mkdtemp(join(tmpdir(), "codex-query-integers-")));
const previousHome = process.env.CODEX_HOME;
const previousDirectory = process.env.CODEX_DB_DIRECTORY;
process.env.CODEX_HOME = home;
delete process.env.CODEX_DB_DIRECTORY;
const path = join(home, "query.sqlite");
const fixture = new DatabaseSync(path);
fixture.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, value INTEGER, note TEXT, bytes BLOB)");
const values = [0n, 9007199254740991n, -9007199254740991n, 9007199254740993n, -9007199254740993n, 9223372036854775807n, -9223372036854775808n];
const insert = fixture.prepare("INSERT INTO records VALUES (?, ?, ?, ?)");
values.forEach((value, i) => insert.run(i + 1, value, null, Buffer.from([1, 2])));
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

const { GET } = await import("../app/api/table/route.ts");
const { NextRequest } = await import("next/server");
const { inspectDatabase } = await import("../lib/database.ts");

test("table and query APIs preserve signed SQLite integers exactly and keep metadata numeric", async () => {
  const expected = values.map((value, i) => ({ id: i + 1, value: value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : String(value), note: null, bytes: "<BLOB 2 bytes>" }));
  for (const response of [await query("SELECT * FROM records ORDER BY id"), GET(new NextRequest(`http://localhost/api/table?database=${databaseId}&table=records&sort=id&direction=asc`))]) {
    const body = await response.json();
    assert.equal(response.status, 200, body.error);
    assert.deepEqual(body.rows, expected);
  }
  const table = inspectDatabase(path).tables[0];
  assert.equal(table.rowEstimate, values.length);
  assert.equal(typeof table.columns[0].cid, "number");
  assert.equal(typeof table.columns[0].pk, "number");
  assert.deepEqual(await readFile(path), original);
});
