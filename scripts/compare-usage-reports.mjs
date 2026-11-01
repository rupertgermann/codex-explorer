import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

async function reportDigest(path) {
  const hash = createHash("sha256");
  const marker = Buffer.from('"generatedAt":');
  let first = true;
  for await (const chunk of createReadStream(path)) {
    if (!first) { hash.update(chunk); continue; }
    const start = chunk.indexOf(marker);
    assert.ok(start >= 0 && start < 256, "Report generation timestamp is missing");
    let end = start + marker.length;
    while (end < chunk.length && ((chunk[end] >= 48 && chunk[end] <= 57) || chunk[end] === 46)) end++;
    assert.ok(end > start + marker.length, "Report generation timestamp is invalid");
    hash.update(chunk.subarray(0, start));
    hash.update('"generatedAt":0');
    hash.update(chunk.subarray(end));
    first = false;
  }
  assert.equal(first, false, "Report is empty");
  return hash.digest("hex");
}

const [before, after] = process.argv.slice(2);
assert.ok(before && after, "Provide both saved usage report paths");
const equal = await reportDigest(before) === await reportDigest(after);
console.log(JSON.stringify({ reportsEqualExceptGeneratedAt: equal }));
if (!equal) process.exitCode = 1;
