/**
 * English messages. This file defines the shape every other locale must match.
 * Plain strings for fixed text, functions for text with values.
 */
export const en = {
  nav: {
    accounts: "Accounts",
    rules: "Rules",
    activity: "Activity",
    admin: "Admin",
    accountMenu: "Account menu",
    signOut: "Sign out",
    privacy: "Privacy",
    language: "Language",
  },
  roles: {
    member: "member",
    admin: "admin",
  },
  signIn: {
    title: "Sign in",
    lead: "Keep your calendars in sync. Others only see that you are busy.",
    withProvider: (provider: string) => `Sign in with ${provider}`,
    fineprint: "Titles, attendees and notes never leave the source calendar.",
  },
  accounts: {
    title: "Accounts",
    lead: "Calendars that this app reads from and writes to.",
    emptyTitle: "No account connected yet",
    emptyText: "Connect at least two calendars to mirror busy times between them.",
    kindGoogle: "Google Calendar",
    kindMicrosoftWork: "Microsoft 365 · work account",
    kindMicrosoftPersonal: "Microsoft 365 · personal account",
    connectedOn: (date: string) => `connected ${date}`,
    notSynced: "Not synced yet",
    inSync: (time: string) => `In sync · ${time}`,
    partlySynced: (time: string) => `Partly synced · ${time}`,
    syncFailed: (code: string) => `Sync failed: ${code}`,
    changesFailed: (count: number) => `${count} changes failed`,
    disconnect: "Disconnect",
    connect: (provider: string) => `+ Connect ${provider}`,
  },
  rules: {
    title: "Rules",
    lead: "Each rule copies events from one calendar into another, in one direction.",
    emptyTitle: "No rules yet",
    emptyText:
      "Add a rule below. For two-way sync, add one rule per direction, each with its own detail level.",
    manage: "Manage rules",
    newRule: "New rule",
    from: "From",
    to: "To",
    detail: "Detail",
    detailLevels: {
      busy: "Busy only",
      title: "Title",
      title_location: "Title and location",
      full: "All details",
    },
    markPrivate: "Mark blocks as private",
    skipAllDay: "Skip all-day events",
    skipTentative: "Skip tentative events",
    daysAhead: "Days ahead",
    days: (days: number) => `${days} days ahead`,
    choose: "Choose a calendar",
    create: "Add rule",
    preview: "Preview",
    runNow: "Run now",
    delete: "Delete",
    refreshCalendars: "Reload calendars",
    noCalendars: "Connect an account first; its calendars appear here.",
    previewResult: (create: number, update: number, remove: number, unchanged: number) =>
      `Preview: ${create} to create, ${update} to update, ${remove} to delete, ${unchanged} unchanged. Nothing was written.`,
    runResult: (applied: number, failed: number, remaining: number) =>
      `Run finished: ${applied} changes written, ${failed} failed, ${remaining} left for the next run.`,
    invalid: "Choose two different calendars. The target calendar must be writable.",
    lastRun: (blocks: number, time: string, changes: number) =>
      `${blocks} blocks · last run ${time} · ${changes} changes`,
    lastRunFailed: (time: string, code: string) => `last run failed · ${time} · ${code}`,
    privateNote: "Events marked private in the source never carry more than Busy.",
  },
  privacy: {
    title: "Privacy",
    operator: (name: string, contact: string) =>
      `This deployment of freebusy-sync is operated by ${name}. Contact: ${contact}.`,
    operatorUnknown: "The operator of this deployment has not set a contact address.",
    intro:
      "freebusy-sync mirrors busy times between calendars. It is open-source software that each operator runs in their own Cloudflare account.",
    storedTitle: "What is stored",
    stored: [
      "Your email address and, for Microsoft accounts, the tenant ID, to identify you and your connected accounts.",
      "OAuth tokens for each connected account, encrypted with AES-256-GCM.",
      "The names of your calendars and the rules you create.",
      "An activity log with times, counts and error codes, without event content. It is deleted after 90 days.",
      "A session cookie and a language cookie in your browser.",
    ],
    notStoredTitle: "What is not stored",
    notStored:
      "Event titles, descriptions, locations and attendees are read during a sync and not stored. Blocks in a target calendar contain only what the rule's detail level allows; the default is Busy.",
    whereTitle: "Where data is processed",
    where:
      "On Cloudflare Workers, D1 and Durable Objects in the operator's Cloudflare account, and at Microsoft and Google when calendars are read and written.",
    deleteTitle: "How to delete your data",
    delete:
      "Disconnecting an account deletes its tokens and the blocks freebusy-sync wrote for it. To delete your user, contact the operator.",
    googleTitle: "Google user data",
    google:
      "freebusy-sync's use and transfer of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements. Data is used only to show and mirror busy times as configured by you, and is never sold, used for advertising or read by humans.",
    noTracking: "There is no tracking, no analytics and no advertising.",
  },
  admin: {
    title: "Users",
    lead: "Everyone who signed in to this deployment. Calendar contents stay private to each user.",
    email: "Email",
    role: "Role",
    accounts: "Accounts",
    lastSignIn: "Last sign-in",
    never: "never",
    onlyAdmins: "Only admins can open this page.",
  },
  activity: {
    title: "Activity",
    lead: "Your last 100 events: sign-ins, changes and sync runs. Event contents are never logged.",
    orgLead: "The last 100 events of everyone in this deployment. Metadata only.",
    time: "Time",
    event: "Event",
    details: "Details",
    empty: "Nothing happened yet.",
    retention: (days: number) => `Events are deleted after ${days} days.`,
    kinds: {
      sign_in: "Signed in",
      sign_in_refused: "Sign-in refused",
      sign_out: "Signed out",
      account_connected: "Account connected",
      account_disconnected: "Account disconnected",
      token_refresh_failed: "Token refresh failed",
      rule_created: "Rule created",
      rule_deleted: "Rule deleted",
      sync_run: "Sync run",
      sync_failed: "Sync failed",
    },
    changes: (create: number, update: number, remove: number) =>
      `+${create} / ~${update} / −${remove}`,
    preview: (changes: string) => `Preview ${changes}`,
    failedCount: (count: number) => `${count} failed`,
    remainingCount: (count: number) => `${count} left`,
  },
  setup: {
    title: "Finish the setup",
    lead: "Set the missing values as Worker variables or secrets or in the Cloudflare dashboard, then reload this page.",
    set: "Set",
    accessHint:
      "Who may sign in. Your own address for a personal deployment, your email domain for a team.",
    sessionHint: "At least 32 characters. Generate with: openssl rand -base64 48",
    keyHint: "A base64-encoded 32-byte key. Generate with: openssl rand -base64 32",
    providerHint: "At least one provider. See the README for the app registration steps.",
  },
  messages: {
    back: "Back to the start page",
    notAllowed: "Not allowed",
    notAvailable: "Not available yet",
    providerNotConfigured: (provider: string) =>
      `${provider} is not set up for this deployment. Ask the administrator to add its client ID.`,
    signInExpired: "Sign-in expired",
    signInExpiredText: "The sign-in took too long or was started elsewhere. Start again.",
    providerRefused: (provider: string) => `${provider} refused the sign-in`,
    signInFailed: "Sign-in failed",
    noCode: (provider: string) => `${provider} returned no authorization code.`,
    exchangeFailed: (provider: string) =>
      `The token exchange with ${provider} failed. See the Worker logs.`,
    notAllowedToSignIn: (email: string) => `${email} may not sign in to this deployment.`,
    connectFailed: "Connect failed",
    noRefreshToken: (provider: string) =>
      `${provider} returned no refresh token (offline_access missing).`,
    alreadyConnected: "Already connected",
    alreadyConnectedText: (email: string) =>
      `${email} is already connected by another user of this deployment.`,
  },
};

export type Messages = typeof en;
