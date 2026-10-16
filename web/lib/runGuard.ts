/**
 * Server-side gate for the conversation's run request (POST /api/copilotkit/agent/<id>/run), the web's boundary to the
 * agent. Pure, with `next` injected, so it can be tested without a runtime or an agent. The conversation UI already
 * disables itself; this makes the server refuse too, so a request that does not come from the UI cannot reach the agent
 * while this environment says it is off. Connect (history, read-only), info and stop are not runs and pass through.
 *
 * The refusal answers the way the runtime itself answers a failed run (HTTP 200, an event stream, one RUN_ERROR), with
 * a message and NO `code`: the client reads that as "the agent said so" (lib/conversation.ts describeRunFailure), not as
 * a transport failure and never as success.
 */
export function isRunRequest(method: string, pathname: string): boolean {
  return method === "POST" && /\/agent\/[^/]+\/run\/?$/.test(pathname);
}

export function refuseRun(reason: string): Response {
  return new Response(`data: ${JSON.stringify({ type: "RUN_ERROR", message: reason })}\n\n`, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}

export async function guardRun(req: Request, reason: string | undefined, next: () => Promise<Response>): Promise<Response> {
  if (reason && isRunRequest(req.method, new URL(req.url).pathname)) return refuseRun(reason);
  return next();
}
