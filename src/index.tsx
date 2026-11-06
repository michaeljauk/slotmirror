// The Cloudflare entry. The app and the cron run stay free of Worker handler types.
import { app } from "./app";
import { runCron } from "./cron";

export { AccountSync } from "./account-sync";

export default {
  fetch: app.fetch,
  scheduled: (controller, env) => runCron(env, controller.scheduledTime),
} satisfies ExportedHandler<Env>;
