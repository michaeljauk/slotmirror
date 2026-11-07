// Copy for the setup and trust blocks of the home page. Every claim here must hold for the current
// release. Sources: docs/privacy.md, docs/quickstart.md, src/providers/microsoft.ts and google.ts.

export const setup = {
  needs: [
    "A Cloudflare account. The free plan is enough.",
    "An OAuth app at Microsoft (Entra) or Google (Cloud console). The quickstart shows each field.",
    "For a work account: a tenant that lets you approve apps, or an admin who approves it once.",
    "Two random secrets, one command each.",
  ],
  effort:
    "The OAuth app takes the most effort. After the deploy button you set who may sign in, " +
    "the Worker address and the provider secrets in the Cloudflare dashboard.",
};

export const permissions = [
  {
    provider: "Microsoft",
    scope: "Calendars.ReadWrite",
    why: "Read your events and write the busy blocks.",
  },
  {
    provider: "Google",
    scope: "calendar.events",
    why: "Read your events and write the busy blocks.",
  },
  {
    provider: "Google",
    scope: "calendar.calendarlist.readonly",
    why: "List your calendars. Read only.",
  },
];

export const signInScopes =
  "Plus the sign-in scopes openid, email, profile (and User.Read, offline_access at Microsoft).";

export const stored = [
  "The email address of each user and the ID of the account they signed in with.",
  "OAuth tokens, encrypted with AES-256-GCM under a key that you set.",
  "Calendar names and your rules.",
  "An activity log with times, counts and error codes. Entries go after 90 days.",
  "If you turn on the MCP server: hashes of API tokens and the records of connected apps.",
];

export const storedNote = "The docs list what is stored.";

export const neverStored = ["Event titles", "Descriptions", "Locations", "Attendees"];

export const neverStoredNote =
  "slotmirror reads them during a sync and keeps them only in memory. A copy shows only what the level of its rule allows. The default is “Busy”.";

export const blocks =
  "Each block that slotmirror writes carries a marker. That is how it finds its own blocks again to move or remove them.";

export const where =
  "Everything runs in your own Cloudflare account. The database and the sync can stay in Cloudflare's EU jurisdiction. There is no slotmirror server in between.";

export const hosted = {
  title: "Hosted slotmirror",
  status: "Not available yet",
  text: "No Cloudflare account, no OAuth app.",
  join: "Leave your address and we tell you when it opens. Joining the list is not a purchase.",
};
