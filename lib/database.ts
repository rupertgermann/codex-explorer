import { createHash } from "node:crypto";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export type JsonValue = string | number | boolean | null;

export type ColumnInfo = {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: JsonValue;
  pk: number;
};

export type ForeignKeyInfo = {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
  match: string;
};

export type TableInfo = {
  name: string;
  sql: string;
  columns: ColumnInfo[];
  foreignKeys: ForeignKeyInfo[];
  indexes: string[];
  rowEstimate: number | null;
  allocatedBytes: number | null;
};

export type DatabaseInfo = {
  id: string;
  name: string;
  filename: string;
  path: string;
  relativePath: string;
  group: "Current stores" | "Development & snapshots" | "Custom store";
  size: number;
  modifiedAt: number;
  journalMode: string;
  tables: TableInfo[];
};

const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), ".codex");
const CUSTOM_DIRECTORY = process.env.CODEX_DB_DIRECTORY;
const DATABASE_EXTENSIONS = new Set([".sqlite", ".sqlite3", ".db"]);

function databaseId(path: string) {
  return createHash("sha256").update(path).digest("base64url").slice(0, 16);
}

function listFiles(directory: string) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && DATABASE_EXTENSIONS.has(extname(entry.name).toLowerCase()))
    .map((entry) => join(directory, entry.name));
}

export function discoverDatabasePaths() {
  const paths = [
    ...listFiles(CODEX_HOME),
    ...listFiles(join(CODEX_HOME, "sqlite")),
    ...(CUSTOM_DIRECTORY ? listFiles(CUSTOM_DIRECTORY) : []),
  ];

  return [...new Set(paths.map((path) => realpathSync(path)))].sort((a, b) => {
    const aIsCurrent = dirname(a) === CODEX_HOME ? 0 : 1;
    const bIsCurrent = dirname(b) === CODEX_HOME ? 0 : 1;
    return aIsCurrent - bIsCurrent || basename(a).localeCompare(basename(b));
  });
}

export function resolveDatabase(id: string) {
  const path = discoverDatabasePaths().find((candidate) => databaseId(candidate) === id);
  if (!path) throw new Error("Unknown database. Refresh the catalog and try again.");
  return path;
}

export function openReadonly(path: string) {
  return new DatabaseSync(path, { readOnly: true });
}

export function quoteIdentifier(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function safeRows<T>(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): T[] {
  try {
    return db.prepare(sql).all(...params) as T[];
  } catch {
    return [];
  }
}

function safeScalar(db: DatabaseSync, sql: string): number | null {
  try {
    const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
    const value = row ? Object.values(row)[0] : null;
    return typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : null;
  } catch {
    return null;
  }
}

function tableEstimate(db: DatabaseSync, table: string, fileSize: number) {
  if (fileSize < 200 * 1024 * 1024) {
    return safeScalar(db, `SELECT COUNT(*) FROM ${quoteIdentifier(table)}`);
  }

  const stat = safeRows<{ stat: string }>(
    db,
    "SELECT stat FROM sqlite_stat1 WHERE tbl = ? ORDER BY idx IS NULL DESC LIMIT 1",
    table,
  )[0];
  if (stat?.stat) {
    const estimate = Number.parseInt(stat.stat.split(" ")[0], 10);
    if (Number.isFinite(estimate)) return estimate;
  }
  return safeScalar(db, `SELECT MAX(rowid) FROM ${quoteIdentifier(table)}`);
}

function databaseGroup(path: string): DatabaseInfo["group"] {
  if (dirname(path) === CODEX_HOME) return "Current stores";
  if (path.startsWith(join(CODEX_HOME, "sqlite"))) return "Development & snapshots";
  return "Custom store";
}

export function inspectDatabase(path: string): DatabaseInfo {
  const file = statSync(path);
  const db = openReadonly(path);
  try {
    // dbstat visits every page. Skip that scan for large live stores so opening
    // the dashboard never competes with Codex just to draw allocation bars.
    const allocations = new Map(
      (file.size <= 64 * 1024 * 1024
        ? safeRows<{ name: string; bytes: number | bigint }>(db, "SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name")
        : []
      ).map((row) => [row.name, Number(row.bytes)]),
    );
    const schemas = safeRows<{ name: string; sql: string | null }>(
      db,
      "SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    const journal = safeRows<{ journal_mode: string }>(db, "PRAGMA journal_mode")[0]?.journal_mode ?? "unknown";

    const tables = schemas.map((schema) => {
      const columns = safeRows<ColumnInfo>(db, `PRAGMA table_info(${quoteIdentifier(schema.name)})`);
      const foreignKeys = safeRows<ForeignKeyInfo>(db, `PRAGMA foreign_key_list(${quoteIdentifier(schema.name)})`);
      const indexes = safeRows<{ name: string }>(db, `PRAGMA index_list(${quoteIdentifier(schema.name)})`).map((index) => index.name);
      return {
        name: schema.name,
        sql: schema.sql ?? "",
        columns,
        foreignKeys,
        indexes,
        rowEstimate: tableEstimate(db, schema.name, file.size),
        allocatedBytes: allocations.get(schema.name) ?? null,
      };
    });

    return {
      id: databaseId(path),
      name: basename(path).replace(/\.(sqlite3?|db)$/i, ""),
      filename: basename(path),
      path,
      relativePath: relative(CODEX_HOME, path),
      group: databaseGroup(path),
      size: file.size,
      modifiedAt: file.mtimeMs,
      journalMode: journal,
      tables,
    };
  } finally {
    db.close();
  }
}

export function catalog() {
  return discoverDatabasePaths().flatMap((path) => {
    try {
      return [inspectDatabase(path)];
    } catch (error) {
      console.warn(`Could not inspect ${path}`, error);
      return [];
    }
  });
}

export function jsonValue(value: unknown): JsonValue {
  if (value == null) return null;
  if (typeof value === "bigint") return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Uint8Array) return `<BLOB ${value.byteLength} bytes>`;
  const text = String(value);
  return text.length > 100_000 ? `${text.slice(0, 100_000)}\n… [truncated]` : text;
}

export function jsonRows(rows: Record<string, unknown>[]) {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, jsonValue(value)])));
}

export function assertReadOnlySql(input: string) {
  const sql = input.trim();
  // Keep quoted values/identifiers as whole tokens so only executable SQL is checked.
  const tokens = (sql.match(/--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[a-z_][a-z0-9_$]*|[^\s]/gi) ?? [])
    .filter((token) => !token.startsWith("--") && !token.startsWith("/*"))
    .map((token) => token.toLowerCase());
  while (tokens.at(-1) === ";") tokens.pop();
  if (!tokens.length) throw new Error("Enter a SQL query first.");
  if (tokens.includes(";")) throw new Error("Run one statement at a time.");
  if (tokens[0] !== "select" && tokens[0] !== "with" && tokens.slice(0, 3).join(" ") !== "explain query plan") {
    throw new Error("Only SELECT, WITH, and EXPLAIN QUERY PLAN statements are allowed.");
  }
  if (tokens.some((token, index) =>
    /^(insert|update|delete|drop|alter|create|attach|detach|vacuum|reindex)$/.test(token) ||
    (token === "replace" && tokens[index + 1] !== "("),
  )) {
    throw new Error("This query contains a write or schema-changing keyword.");
  }
  return sql;
}
