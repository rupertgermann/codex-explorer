/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  mutate: ["lib/memory-backup.ts", "lib/memory-forget.ts", "lib/memory.ts:74-111"],
  testRunner: "command",
  commandRunner: { command: "node --test tests/memory-forget.test.mjs tests/memory-orphan.test.mjs tests/memory-repository.test.mjs tests/project-forget.test.mjs" },
  checkers: ["typescript"],
  coverageAnalysis: "off",
  concurrency: 4,
  reporters: ["clear-text", "progress", "html"],
  thresholds: { high: 80, low: 70, break: 60 },
  timeoutMS: 10_000,
};

export default config;
