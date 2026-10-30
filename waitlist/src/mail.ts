import { escapeHtml } from "./pages";
import type { WaitlistEnv } from "./env";

/** Send the double opt-in mail through Resend. Returns false on any failure. */
export async function sendConfirmationMail(
  env: WaitlistEnv,
  to: string,
  confirmToken: string,
  unsubscribeToken: string,
): Promise<boolean> {
  const base = env.PUBLIC_URL.replace(/\/$/, "");
  const confirmUrl = `${base}/confirm?t=${confirmToken}`;
  const unsubscribeUrl = `${base}/unsubscribe?t=${unsubscribeToken}`;
  const text = [
    "Confirm your place on the slotmirror waitlist:",
    confirmUrl,
    "",
    "The link works for 7 days. If you did not sign up, ignore this mail. We delete the entry then.",
    "The hosted version does not exist yet. Joining the list is not a purchase.",
    "",
    `Unsubscribe and delete your data: ${unsubscribeUrl}`,
  ].join("\n");
  const html = `<p>Confirm your place on the slotmirror waitlist:</p>
<p><a href="${escapeHtml(confirmUrl)}">Confirm my address</a></p>
<p>The link works for 7 days. If you did not sign up, ignore this mail. We delete the entry then.</p>
<p>The hosted version does not exist yet. Joining the list is not a purchase.</p>
<p><a href="${escapeHtml(unsubscribeUrl)}">Unsubscribe and delete your data</a></p>`;
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to: [to],
        subject: "Confirm your slotmirror waitlist entry",
        text,
        html,
        headers: {
          "List-Unsubscribe": `<${unsubscribeUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) console.warn("resend status", response.status);
    return response.ok;
  } catch {
    console.warn("resend unreachable");
    return false;
  }
}
