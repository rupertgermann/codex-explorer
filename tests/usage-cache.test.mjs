import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildUsageReport } from "../lib/usage-report.ts";
import { generateUsageData, readCachedUsageData } from "../lib/usage-repository.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) return nextResolve(new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href, context);
    return nextResolve(specifier === "next/server" ? "next/server.js" : specifier, context);
  },
});

test("usage API restores the last successful report without scanning and replaces it only on explicit success", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-usage-cache-"));
  const home = join(directory, "home"), root = join(home, "sessions"), path = join(root, "usage.jsonl");
  const environment = { CODEX_HOME: home, CODEX_SESSIONS_DIRECTORY: root, CODEX_ARCHIVED_SESSIONS_DIRECTORY: join(home, "archived_sessions") };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  const cwd = process.cwd();
  const since = Date.parse("2026-09-04T00:00:00Z") / 1000, until = since + 3600;
  const rows = [
    { timestamp: new Date(since * 1000).toISOString(), type: "session_meta", payload: { id: "usage", cwd: "/work/project" } },
    { timestamp: new Date((since + 1) * 1000).toISOString(), type: "turn_context", payload: { turn_id: "turn", model: "test-model", effort: "high", service_tier: "priority" } },
    { timestamp: new Date((since + 10) * 1000).toISOString(), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 90, output_tokens: 10, total_tokens: 100 } } } },
    { timestamp: new Date((since + 11) * 1000).toISOString(), type: "response_item", payload: { text: "private conversation content" } },
  ];
  const request = (signal, start = since, end = until) => new NextRequest(`http://localhost/api/usage?since=${new Date(start * 1000).toISOString()}&until=${new Date(end * 1000).toISOString()}`, { method: "POST", signal });
  const { NextRequest } = await import("next/server");
  const { GET, POST } = await import("../app/api/usage/route.ts");
  try {
    process.chdir(directory);
    Object.assign(process.env, environment);
    mkdirSync(root, { recursive: true });
    writeFileSync(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    const source = readFileSync(path, "utf8");

    const missing = await GET();
    assert.equal(missing.status, 200);
    assert.equal(missing.headers.get("cache-control"), "no-store");
    assert.equal(await missing.json(), null);

    const first = await POST(request());
    assert.equal(first.status, 200);
    const saved = await first.json();
    assert.equal(buildUsageReport(saved).summary.total_tokens, 100);
    assert.equal(buildUsageReport(saved, { speed: "fast" }).summary.total_tokens, 100);
    assert.equal(readFileSync(path, "utf8"), source);
    assert.ok(!JSON.stringify(saved).includes("private conversation content"));

    // Changing the source must not affect opening the module or a fresh process.
    rows[2].payload.info.total_token_usage = { input_tokens: 190, output_tokens: 10, total_tokens: 200 };
    writeFileSync(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    assert.deepEqual(await (await GET()).json(), saved);
    const moduleUrl = new URL("../lib/usage-repository.ts", import.meta.url).href;
    const restored = execFileSync(process.execPath, ["--input-type=module", "-e", `import { readCachedUsageData } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(readCachedUsageData()));`], { cwd: directory, env: process.env, encoding: "utf8" });
    assert.deepEqual(JSON.parse(restored), saved);

    assert.equal((await POST(request(undefined, until, since))).status, 400);
    assert.equal((await POST(request(AbortSignal.abort()))).status, 500);
    mkdirSync(join(home, "session_index.jsonl")); // A real read failure, not a stubbed generator.
    assert.equal((await POST(request())).status, 500);
    assert.deepEqual(await (await GET()).json(), saved);
    rmSync(join(home, "session_index.jsonl"), { recursive: true });

    const updated = await POST(request(undefined, since, until + 3600));
    assert.equal(updated.status, 200);
    const latest = await updated.json();
    assert.equal(buildUsageReport(latest).summary.total_tokens, 200);
    assert.equal(latest.until, until + 3600);
    assert.deepEqual(await (await GET()).json(), latest);
    assert.equal(readCachedUsageData({ home: join(directory, "other-home") }), null);
    assert.equal(readCachedUsageData({ roots: [join(directory, "other-sessions")] }), null);

    await assert.rejects(generateUsageData(since, until, { roots: [], signal: AbortSignal.abort() }), { name: "AbortError" });
    assert.deepEqual(await (await GET()).json(), latest);
  } finally {
    process.chdir(cwd);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
