// The Cloudflare entry. The app and the cron run stay free of Worker handler types.
import { app } from "./app";
import { runCron } from "./cron";
import { workersTelemetry } from "./runtime/workers/telemetry";
import { setTelemetry, startRequest } from "./telemetry";

export { AccountSync } from "./account-sync";

// At module load, so that the app and every Durable Object of this script log through it.
setTelemetry(workersTelemetry());

export default {
  fetch: app.fetch,
  scheduled: (controller, env) =>
    startRequest("cron", () => runCron(env, controller.scheduledTime)),
} satisfies ExportedHandler<Env>;
