import { MacAgentClient } from "./client";
import { loadMacAgentConfig } from "./config";
import {
  loadPromptOverrides,
  watchPromptOverrides,
} from "./prompts/overrides";

const config = await loadMacAgentConfig();
loadPromptOverrides(config.promptOverridesDirectory);
watchPromptOverrides(config.promptOverridesDirectory);
const client = new MacAgentClient(config);
const healthServer = Bun.serve({
  hostname: "0.0.0.0",
  port: Number(process.env.MINISAGO_WORKER_HEALTH_PORT || 8081),
  fetch(request) {
    if (
      request.method !== "GET" ||
      new URL(request.url).pathname !== "/health"
    ) {
      return new Response("Not found.", { status: 404 });
    }
    const health = client.health();
    return Response.json(health, { status: health.ok ? 200 : 503 });
  },
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    healthServer.stop();
    client.stop();
    process.exit(0);
  });
}

client.start();
