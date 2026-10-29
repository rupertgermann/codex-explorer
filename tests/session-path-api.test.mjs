import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { zstdCompressSync } from "node:zlib";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) return nextResolve(new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href, context);
    return nextResolve(specifier === "next/server" ? "next/server.js" : specifier, context);
  },
});

const { NextRequest } = await import("next/server.js");
const routes = await Promise.all(["document", "transcript", "raw"].map(async (name) => ({
  name, GET: (await import(`../app/api/sessions/${name}/route.ts`)).GET,
})));

function archive(t) {
  const directory = mkdtempSync(join(tmpdir(), "session-path-api-"));
  const root = join(directory, "archive");
  mkdirSync(root);
  const previous = process.env.CODEX_SESSIONS_DIRECTORY;
  process.env.CODEX_SESSIONS_DIRECTORY = root;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_SESSIONS_DIRECTORY;
    else process.env.CODEX_SESSIONS_DIRECTORY = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, root };
}

function writeSession(directory, filename, message) {
  const content = `${JSON.stringify({ type: "session_meta", payload: { id: "fixture-session", cwd: "/fixture" } })}\n${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message } })}\n`;
  writeFileSync(join(directory, filename), filename.endsWith(".zst") ? zstdCompressSync(content) : content);
}

async function request(route, path) {
  return route.GET(new NextRequest(`http://localhost/api/sessions/${route.name}?${new URLSearchParams({ path })}`));
}

test("session content endpoints reject ancestor links escaping to a sibling with the archive prefix", async (t) => {
  const { directory, root } = archive(t);
  const outside = join(directory, "archive-outside");
  mkdirSync(outside);
  writeSession(outside, "secret.jsonl", "OUTSIDE_SESSION_CONTENT");
  symlinkSync(outside, join(root, "linked"), "dir");
  for (const route of routes) {
    await t.test(route.name, async () => {
      const response = await request(route, "linked/secret.jsonl");
      const body = await response.text();
      assert.equal(response.status, 404);
      assert.ok(!body.includes("OUTSIDE_SESSION_CONTENT"));
    });
  }
});

for (const linkedRoot of [false, true]) {
  test(`session content endpoints read plain and compressed files from a ${linkedRoot ? "linked" : "regular"} archive root`, async (t) => {
    const { directory, root } = archive(t);
    if (linkedRoot) {
      const link = join(directory, "archive-link");
      symlinkSync(root, link, "dir");
      process.env.CODEX_SESSIONS_DIRECTORY = link;
    }
    const nested = join(root, "2026");
    mkdirSync(nested);
    for (const filename of ["valid.jsonl", "valid.jsonl.zst"]) {
      writeSession(nested, filename, "IN_ROOT_SESSION_CONTENT");
      const path = `2026/${filename}`;
      for (const route of routes) {
        await t.test(`${route.name}: ${filename}`, async () => {
          const response = await request(route, path);
          const body = await response.text();
          assert.equal(response.status, 200);
          assert.ok(body.includes("IN_ROOT_SESSION_CONTENT"));
          if (route.name === "transcript") {
            const records = body.trim().split("\n").map((line) => JSON.parse(line));
            assert.equal(records.at(-1).type, "complete");
            assert.equal(records.at(-1).session.path, path);
          } else {
            assert.equal(JSON.parse(body).path, path);
          }
        });
      }
    }
  });
}
