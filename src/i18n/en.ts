/**
 * English messages. This file defines the shape every other locale must match.
 * Plain strings for fixed text, functions for text with values.
 */
export const en = {
  nav: {
    accounts: "Accounts",
    admin: "Admin",
    accountMenu: "Account menu",
    signOut: "Sign out",
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
    disconnect: "Disconnect",
    connect: (provider: string) => `+ Connect ${provider}`,
  },
  rules: {
    title: "Rules",
    lead: "Which calendar shows busy blocks for which other calendar.",
    emptyTitle: "No rules yet",
    emptyText:
      "Rules arrive with the sync engine. A rule will mirror busy times from one calendar into another, for example from your work calendar into your client calendar.",
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
    googleNotImplemented: "Google sign-in is not implemented yet.",
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
