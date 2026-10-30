const CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** A light-mode landing page. No scripts, no analytics, never indexed, never cached. */
export function page(status: number, title: string, body: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light">
<title>${escapeHtml(title)} - slotmirror</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;color:#1a1a1a;background:#fff;margin:0;padding:48px 16px}
main{max-width:30rem;margin:0 auto}
h1{font-size:1.5rem;margin:0 0 1rem}
button,a.button{font:inherit;background:#194481;color:#fff;border:0;border-radius:6px;padding:.6rem 1.1rem;cursor:pointer;text-decoration:none;display:inline-block}
a{color:#194481}
</style>
</head>
<body><main>
<h1>${escapeHtml(title)}</h1>
${body}
</main></body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex",
      "content-security-policy": CONTENT_SECURITY_POLICY,
      "x-content-type-options": "nosniff",
    },
  });
}

export type LinkKind = "confirm" | "unsubscribe";

/** The page with the button. A GET shows it and changes nothing. The button sends the POST. */
export function actionPage(kind: LinkKind, token: string): Response {
  const action = `/${kind}?t=${encodeURIComponent(token)}`;
  const text =
    kind === "confirm"
      ? ["Confirm your address", "Press the button to join the slotmirror waitlist.", "Confirm"]
      : [
          "Unsubscribe",
          "Press the button to leave the waitlist. We delete your address.",
          "Unsubscribe and delete my data",
        ];
  return page(
    200,
    text[0]!,
    `<p>${text[1]}</p>
<form method="post" action="${escapeHtml(action)}"><button type="submit">${text[2]}</button></form>`,
  );
}

function link(url: string, label: string): string {
  return `<p><a href="${escapeHtml(url)}">${escapeHtml(label)}</a></p>`;
}

export function confirmedPage(siteUrl: string): Response {
  return page(
    200,
    "Confirmed",
    `<p>You are on the waitlist. The hosted version does not exist yet. We write to you when it does.</p>
<p>You can host slotmirror yourself today.</p>
${link(`${siteUrl}/docs/quickstart/`, "Self-host slotmirror")}`,
  );
}

export function alreadyConfirmedPage(siteUrl: string): Response {
  return page(
    200,
    "Already confirmed",
    `<p>This address is already on the waitlist. Nothing more to do.</p>
${link(`${siteUrl}/docs/quickstart/`, "Self-host slotmirror")}`,
  );
}

export function expiredPage(siteUrl: string): Response {
  return page(
    410,
    "Link expired",
    `<p>This link is no longer valid. Sign up again to get a new mail.</p>
${link(siteUrl, "Back to slotmirror")}`,
  );
}

/**
 * An expired unsubscribe link. Signing up again does not help: a confirmed address gets no mail.
 * The operator deletes the entry on request. The contact comes from the DELETION_CONTACT variable.
 */
export function unsubscribeExpiredPage(siteUrl: string, contact?: string): Response {
  const value = contact?.trim();
  const who = !value
    ? "Contact the operator of this site"
    : /^[^\s@<>"]+@[^\s@<>"]+$/.test(value)
      ? `Write to <a href="mailto:${escapeHtml(value)}">${escapeHtml(value)}</a>`
      : `Contact ${escapeHtml(value)}`;
  return page(
    410,
    "Link expired",
    `<p>This unsubscribe link is no longer valid. ${who} to delete your address. Use the address you signed up with.</p>
${link(siteUrl, "Back to slotmirror")}`,
  );
}

export function errorPage(siteUrl: string): Response {
  return page(
    503,
    "Try again later",
    `<p>We cannot process this link now. Nothing was changed. Open the link again in a few minutes.</p>
${link(siteUrl, "Back to slotmirror")}`,
  );
}

export function invalidPage(siteUrl: string): Response {
  return page(
    400,
    "Link not valid",
    `<p>We do not know this link. It may have expired, or the address may be removed already.</p>
${link(siteUrl, "Back to slotmirror")}`,
  );
}

export function unsubscribedPage(): Response {
  return page(200, "Unsubscribed", `<p>Unsubscribed. Your data is deleted.</p>`);
}
