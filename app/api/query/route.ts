import { NextResponse } from "next/server";
import { assertReadOnlySql, jsonRows, openReadonly, resolveDatabase } from "@/lib/database";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const startedAt = performance.now();
  try {
    const body = (await request.json()) as { databaseId?: string; sql?: string };
    if (!body.databaseId || !body.sql) throw new Error("databaseId and sql are required.");
    const sql = assertReadOnlySql(body.sql);
    const db = openReadonly(resolveDatabase(body.databaseId));
    try {
      const statement = db.prepare(sql);
      statement.setAllowBareNamedParameters(true);
      const columns = [...new Set(statement.columns().map((column) => column.name))];
      const collected: Record<string, unknown>[] = [];
      let limited = false;
      for (const row of statement.iterate()) {
        if (collected.length === 500) {
          limited = true;
          break;
        }
        collected.push(row);
      }
      const rows = jsonRows(collected);
      return NextResponse.json({ rows, columns, durationMs: performance.now() - startedAt, limited });
    } finally {
      db.close();
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Query failed.", durationMs: performance.now() - startedAt }, { status: 400 });
  }
}
