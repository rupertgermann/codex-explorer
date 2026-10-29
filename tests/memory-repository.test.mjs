import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { atomicMemoryWrite, memoryHash, MemoryRepository } from "../lib/memory.ts";

const roots = [];

function memoryRoot() {
  const root = mkdtempSync(join(tmpdir(), "codex-memory-test-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

test("catalogs every Markdown file recursively and summarizes the corpus", () => {
  const root = memoryRoot();
  mkdirSync(join(root, "rollout_summaries"));
  writeFileSync(join(root, "MEMORY.md"), "# Memory\n\nAlpha beta beta.\n\n## Projects\n");
  writeFileSync(join(root, "rollout_summaries", "one.md"), "# First rollout\n\nAlpha gamma.\n");
  writeFileSync(join(root, "ignored.json"), "{}\n");

  const catalog = new MemoryRepository(root).catalog();

  assert.equal(catalog.files.length, 2);
  assert.deepEqual(catalog.files.map((file) => file.path), ["MEMORY.md", "rollout_summaries/one.md"]);
  assert.equal(catalog.files[0].title, "Memory");
  assert.equal(catalog.totals.files, 2);
  assert.equal(catalog.totals.headings, 3);
  assert.equal(catalog.totals.words, 9);
  assert.deepEqual(catalog.directories, ["Root", "rollout_summaries"]);
  assert.deepEqual(catalog.topTerms.slice(0, 4), [
    { term: "alpha", count: 2 },
    { term: "beta", count: 2 },
    { term: "first", count: 1 },
    { term: "gamma", count: 1 },
  ]);
});

test("reads a document and searches all Markdown with line-level matches", () => {
  const root = memoryRoot();
  mkdirSync(join(root, "notes"));
  writeFileSync(join(root, "MEMORY.md"), "# Memory\n\nAlpha appears here.\nNothing else.\nALPHA returns.\n");
  writeFileSync(join(root, "notes", "detail.md"), "# Detail\n\nA separate alpha note.\n");

  const repository = new MemoryRepository(root);
  const document = repository.read("MEMORY.md");
  const results = repository.search("alpha");

  assert.equal(document.title, "Memory");
  assert.equal(document.content, "# Memory\n\nAlpha appears here.\nNothing else.\nALPHA returns.\n");
  assert.match(document.hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(results, [
    {
      path: "MEMORY.md",
      title: "Memory",
      matchCount: 2,
      matches: [
        { line: 3, excerpt: "Alpha appears here." },
        { line: 5, excerpt: "ALPHA returns." },
      ],
    },
    {
      path: "notes/detail.md",
      title: "Detail",
      matchCount: 1,
      matches: [{ line: 3, excerpt: "A separate alpha note." }],
    },
  ]);
  assert.deepEqual(repository.search("   "), []);
});

test("keeps document paths relative to a logical root that resolves through a symlink", () => {
  const parent = memoryRoot();
  const actualRoot = join(parent, "actual");
  const linkedRoot = join(parent, "linked");
  mkdirSync(actualRoot);
  symlinkSync(actualRoot, linkedRoot, "dir");
  writeFileSync(join(actualRoot, "memory_summary.md"), "# Summary\n");

  const document = new MemoryRepository(linkedRoot).read("memory_summary.md");

  assert.equal(document.path, "memory_summary.md");
});

test("saves atomically only when the opened revision is still current", () => {
  const root = memoryRoot();
  const path = join(root, "MEMORY.md");
  writeFileSync(path, "# Memory\n\nOriginal.\n");
  const repository = new MemoryRepository(root);
  const opened = repository.read("MEMORY.md");

  const saved = repository.save({ path: "MEMORY.md", content: "# Memory\n\nUpdated.\n", expectedHash: opened.hash });

  assert.equal(readFileSync(path, "utf8"), "# Memory\n\nUpdated.\n");
  assert.notEqual(saved.hash, opened.hash);
  assert.equal(saved.content, "# Memory\n\nUpdated.\n");
  assert.deepEqual(readdirSync(root), ["MEMORY.md"]);
  assert.throws(
    () => repository.save({ path: "MEMORY.md", content: "stale", expectedHash: opened.hash }),
    { name: "MemoryConflictError" },
  );
  assert.throws(() => repository.read("../outside.md"), { name: "MemoryPathError" });
  assert.throws(() => repository.read("not-markdown.txt"), { name: "MemoryPathError" });
});

test("a rejected atomic replacement preserves newer content and removes its temporary file", () => {
  const root = memoryRoot();
  const path = join(root, "MEMORY.md");
  writeFileSync(path, "Newer content\n");

  assert.throws(
    () => atomicMemoryWrite(path, "Stale replacement\n", memoryHash("Old content\n")),
    { name: "MemoryConflictError" },
  );
  assert.equal(readFileSync(path, "utf8"), "Newer content\n");
  assert.deepEqual(readdirSync(root), ["MEMORY.md"]);
});

test("atomic writes create private UTF-8 files and keep them private after replacement", () => {
  const root = memoryRoot();
  const path = join(root, "notes", "private.md");
  const previousMask = process.umask(0o022);
  try {
    atomicMemoryWrite(path, "# Grüße\n");
    assert.equal(readFileSync(path, "utf8"), "# Grüße\n");
    assert.equal(statSync(path).mode & 0o777, 0o600);

    atomicMemoryWrite(path, "# Überarbeitet\n", memoryHash("# Grüße\n"));
    assert.equal(readFileSync(path, "utf8"), "# Überarbeitet\n");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(join(root, "notes")), ["private.md"]);
  } finally {
    process.umask(previousMask);
  }
});

test("existing non-Markdown files cannot be read or overwritten as Memory", () => {
  const root = memoryRoot();
  const path = join(root, "settings.json");
  writeFileSync(path, "Original settings\n");
  const repository = new MemoryRepository(root);

  assert.throws(() => repository.read("settings.json"), { name: "MemoryPathError" });
  assert.throws(
    () => repository.save({ path: "settings.json", content: "Replacement\n", expectedHash: memoryHash("Original settings\n") }),
    { name: "MemoryPathError" },
  );
  assert.equal(readFileSync(path, "utf8"), "Original settings\n");
});

test("Memory reads and saves reject a directory link escaping the corpus", () => {
  const parent = memoryRoot();
  const root = join(parent, "memories");
  const outside = join(parent, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  const path = join(outside, "private.md");
  writeFileSync(path, "Outside content\n");
  symlinkSync(outside, join(root, "linked"), "dir");
  const repository = new MemoryRepository(root);

  assert.throws(() => repository.read("linked/private.md"), { name: "MemoryPathError" });
  assert.throws(
    () => repository.save({ path: "linked/private.md", content: "Replacement\n", expectedHash: memoryHash("Outside content\n") }),
    { name: "MemoryPathError" },
  );
  assert.equal(readFileSync(path, "utf8"), "Outside content\n");
});
