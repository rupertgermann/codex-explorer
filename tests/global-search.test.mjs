import assert from "node:assert/strict";
import test from "node:test";
import { searchDatabaseCatalog } from "../lib/global-search.ts";
import { isWorkspace } from "../lib/workspace.ts";

const databases = [{
  id: "codex-state",
  name: "state",
  filename: "state.sqlite",
  relativePath: "state.sqlite",
  group: "Current stores",
  tables: [{
    name: "thread_metadata",
    columns: [{ name: "thread_id", type: "TEXT" }, { name: "created_at", type: "INTEGER" }],
    indexes: ["idx_thread_created"],
  }],
}];

test("searches database, table, column, and index metadata", () => {
  assert.equal(searchDatabaseCatalog(databases, "state")[0].matches[0], "Database · state.sqlite");
  assert.equal(searchDatabaseCatalog(databases, "metadata")[0].matches[0], "Table · thread_metadata");
  assert.equal(searchDatabaseCatalog(databases, "thread_id")[0].matches[0], "Column · thread_metadata.thread_id (TEXT)");
  assert.equal(searchDatabaseCatalog(databases, "idx_thread")[0].matches[0], "Index · thread_metadata.idx_thread_created");
  assert.deepEqual(searchDatabaseCatalog(databases, "missing"), []);
});

test("recognizes unified search as a persisted workspace", () => {
  assert.equal(isWorkspace("search"), true);
  assert.equal(isWorkspace("unknown"), false);
});
