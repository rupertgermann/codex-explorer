import { NextRequest, NextResponse } from "next/server";
import { inspectDatabase, jsonRows, openReadonly, quoteIdentifier, resolveDatabase } from "@/lib/database";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: NextRequest) {
  try {
    const id = request.nextUrl.searchParams.get("database") ?? "";
    const tableName = request.nextUrl.searchParams.get("table") ?? "";
    const search = request.nextUrl.searchParams.get("search")?.trim() ?? "";
    const page = Math.max(1, Number(request.nextUrl.searchParams.get("page")) || 1);
    const pageSize = Math.min(100, Math.max(10, Number(request.nextUrl.searchParams.get("pageSize")) || 50));
    const direction = request.nextUrl.searchParams.get("direction") === "asc" ? "ASC" : "DESC";

    const path = resolveDatabase(id);
    const database = inspectDatabase(path);
    const table = database.tables.find((candidate) => candidate.name === tableName);
    if (!table) throw new Error("Unknown table.");
    const requestedSort = request.nextUrl.searchParams.get("sort");
    const primaryKey = table.columns.find((column) => column.pk)?.name;
    const sort = table.columns.find((column) => column.name === requestedSort)?.name ?? primaryKey ?? table.columns[0]?.name;
    if (!sort) throw new Error("This table has no readable columns.");

    const searchable = table.columns.filter((column) => !/BLOB/i.test(column.type));
    const where = search && searchable.length
      ? `WHERE ${searchable.map((column) => `CAST(${quoteIdentifier(column.name)} AS TEXT) LIKE ?`).join(" OR ")}`
      : "";
    const parameters = search && searchable.length ? searchable.map(() => `%${search}%`) : [];
    const sql = `SELECT * FROM ${quoteIdentifier(table.name)} ${where} ORDER BY ${quoteIdentifier(sort)} ${direction} LIMIT ? OFFSET ?`;

    const db = openReadonly(path);
    try {
      const statement = db.prepare(sql);
      statement.setReadBigInts(true);
      const rows = jsonRows(statement.all(...parameters, pageSize, (page - 1) * pageSize));
      let total = table.rowEstimate;
      if (search) {
        const count = db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table.name)} ${where}`).get(...parameters) as { count: number | bigint };
        total = Number(count.count);
      }
      return NextResponse.json({ rows, columns: table.columns, total, page, pageSize, sort, direction: direction.toLowerCase() });
    } finally {
      db.close();
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not read table." }, { status: 400 });
  }
}
