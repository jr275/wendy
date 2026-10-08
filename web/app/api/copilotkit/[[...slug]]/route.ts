import { HttpAgent } from "@ag-ui/client";
import { CopilotRuntime, createCopilotRuntimeHandler, InMemoryAgentRunner } from "@copilotkit/runtime/v2";

/**
 * CopilotKit runtime. No model is configured here: the only agent is Wendy, reached server-to-server
 * over AG-UI with a shared bearer token that never reaches the browser.
 */
// Node.js is the default runtime; Next 16 with Cache Components rejects an explicit `runtime` export.

const runtimeInstance = new CopilotRuntime({
  agents: {
    wendy: new HttpAgent({
      url: process.env.WENDY_AGUI_URL ?? "http://127.0.0.1:3458/agui",
      headers: { Authorization: `Bearer ${process.env.WENDY_AGENT_TOKEN ?? ""}` },
    }),
  },
  runner: new InMemoryAgentRunner(),
});

const handler = createCopilotRuntimeHandler({ runtime: runtimeInstance, basePath: "/api/copilotkit" });

export { handler as GET, handler as POST, handler as PATCH, handler as DELETE };
