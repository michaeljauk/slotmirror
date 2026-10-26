import { PROVIDER_LABEL, type Provider } from "./config";
import { i18nFor, LOCALES } from "./i18n";

/** A slow webhook must not hold the alarm that found the refused token. */
const ALERT_TIMEOUT_MS = 5_000;

/**
 * Tell the operator that an account needs to be connected again, through the optional
 * ALERT_WEBHOOK_URL. The JSON body `{"text": ...}` is the Slack incoming webhook format. The text
 * names the provider and the deployment, never an address, a calendar or an event. Best effort:
 * a failure is logged without the URL, which is a secret.
 */
export async function sendReconnectAlert(env: Env, provider: Provider): Promise<void> {
  const url = env.ALERT_WEBHOOK_URL?.trim();
  if (!url) return;
  if (!url.startsWith("https://")) {
    console.error("ALERT_WEBHOOK_URL must start with https://");
    return;
  }
  const { t } = i18nFor(LOCALES[0]);
  const text = t.alerts.reconnect(PROVIDER_LABEL[provider], env.PUBLIC_URL?.trim() ?? "");
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
    });
    if (!response.ok) console.error("Alert webhook answered", response.status);
  } catch (error) {
    console.error("Alert webhook failed", error instanceof Error ? error.name : "unknown");
  }
}
