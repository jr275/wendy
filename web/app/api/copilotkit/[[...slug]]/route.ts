import { EventType, HttpAgent, type BaseEvent } from "@ag-ui/client";
import { CopilotRuntime, createCopilotRuntimeHandler, InMemoryAgentRunner } from "@copilotkit/runtime/v2";
import { Observable } from "rxjs";
import { chatHistory, principal } from "@/lib/wendy";

/**
 * CopilotKit runtime. No model is configured here: the only agent is Wendy, reached server-to-server
 * over AG-UI with a shared bearer token that never reaches the browser.
 */
// Node.js is the default runtime; Next 16 with Cache Components rejects an explicit `runtime` export.

/**
 * Runs go through the in-memory runner as before. Connecting (what the chat does when it opens)
 * replays the conversation Wendy keeps in her database — one continuous thread — so it survives
 * reloads and restarts.
 */
class WendyRunner extends InMemoryAgentRunner {
  // One continuous thread per principal: the requested thread id does not change what is replayed.
  connect(): Observable<BaseEvent> {
    return new Observable<BaseEvent>((sub) => {
      (async () => {
        const p = await principal();
        const messages = p ? await chatHistory(p.id) : [];
        sub.next({ type: EventType.MESSAGES_SNAPSHOT, messages } as BaseEvent);
        sub.complete();
      })().catch((e) => sub.error(e));
    });
  }
}

const runtimeInstance = new CopilotRuntime({
  agents: {
    wendy: new HttpAgent({
      url: process.env.WENDY_AGUI_URL ?? "http://127.0.0.1:3458/agui",
      headers: { Authorization: `Bearer ${process.env.WENDY_AGENT_TOKEN ?? ""}` },
    }),
  },
  runner: new WendyRunner(),
});

const handler = createCopilotRuntimeHandler({ runtime: runtimeInstance, basePath: "/api/copilotkit" });

export { handler as GET, handler as POST, handler as PATCH, handler as DELETE };
