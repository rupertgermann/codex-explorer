import { type NextRequest, NextResponse } from "next/server";
import { SessionPathError, SessionRepository } from "@/lib/sessions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: NextRequest) {
  const path = request.nextUrl.searchParams.get("path") ?? "";
  const repository = new SessionRepository();
  try {
    repository.resolveSessionPath(path);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not scan session transcript." },
      { status: error instanceof SessionPathError ? 404 : 400 },
    );
  }

  const encoder = new TextEncoder();
  const abortController = new AbortController();
  request.signal.addEventListener("abort", () => abortController.abort(), { once: true });
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (value: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
      try {
        const detail = await repository.scanFull(path, send, abortController.signal);
        send({ type: "complete", session: { ...detail, entries: undefined } });
      } catch (error) {
        if (!abortController.signal.aborted) send({ type: "error", error: error instanceof Error ? error.message : "Could not scan complete transcript." });
      } finally {
        try {
          controller.close();
        } catch {
          // The consumer may already have closed the controller while cancelling the response.
        }
      }
    },
    cancel() {
      abortController.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-store, no-transform",
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  });
}
