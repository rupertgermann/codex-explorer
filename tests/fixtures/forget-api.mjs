import { registerHooks } from "node:module";
import { join } from "node:path";

// Load the real Next route in Node acceptance checks without starting an app server.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) return nextResolve(new URL(`../../${specifier.slice(2)}.ts`, import.meta.url).href, context);
    return nextResolve(specifier === "next/server" ? "next/server.js" : specifier, context);
  },
});

export async function forgetRequest({ home, root }, body) {
  const environment = { CODEX_HOME: home, CODEX_MEMORY_DIRECTORY: root, CODEX_SESSIONS_DIRECTORY: join(home, "sessions"), CODEX_ARCHIVED_SESSIONS_DIRECTORY: join(home, "archived_sessions") };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  try {
    const { POST } = await import("../../app/api/memory/forget/route.ts");
    return await POST(new Request("http://localhost/api/memory/forget", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
