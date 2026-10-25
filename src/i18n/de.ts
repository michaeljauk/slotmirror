import type { Messages } from "./en";

export const de: Messages = {
  nav: {
    accounts: "Konten",
    admin: "Verwaltung",
    accountMenu: "Kontomenü",
    signOut: "Abmelden",
    language: "Sprache",
  },
  roles: {
    member: "Mitglied",
    admin: "Admin",
  },
  signIn: {
    title: "Anmelden",
    lead: "Halte deine Kalender synchron. Andere sehen nur, dass du belegt bist.",
    withProvider: (provider) => `Mit ${provider} anmelden`,
    fineprint: "Titel, Teilnehmer und Notizen verlassen nie den Quellkalender.",
  },
  accounts: {
    title: "Konten",
    lead: "Kalender, aus denen diese App liest und in die sie schreibt.",
    emptyTitle: "Noch kein Konto verbunden",
    emptyText: "Verbinde mindestens zwei Kalender, um Belegt-Zeiten zwischen ihnen zu spiegeln.",
    kindGoogle: "Google Kalender",
    kindMicrosoftWork: "Microsoft 365 · Geschäftskonto",
    kindMicrosoftPersonal: "Microsoft 365 · privates Konto",
    connectedOn: (date) => `verbunden am ${date}`,
    notSynced: "Noch nicht synchronisiert",
    disconnect: "Trennen",
    connect: (provider) => `+ ${provider} verbinden`,
  },
  rules: {
    title: "Regeln",
    lead: "Welcher Kalender für welchen anderen Kalender Belegt-Blöcke zeigt.",
    emptyTitle: "Noch keine Regeln",
    emptyText:
      "Regeln kommen mit dem Sync. Eine Regel spiegelt Belegt-Zeiten aus einem Kalender in einen anderen, zum Beispiel aus deinem Arbeitskalender in deinen Kundenkalender.",
  },
  admin: {
    title: "Nutzer",
    lead: "Alle, die sich bei dieser Installation angemeldet haben. Kalenderinhalte bleiben privat.",
    email: "E-Mail",
    role: "Rolle",
    accounts: "Konten",
    lastSignIn: "Letzte Anmeldung",
    never: "nie",
    onlyAdmins: "Nur Admins können diese Seite öffnen.",
  },
  setup: {
    title: "Einrichtung abschließen",
    lead: "Setze die fehlenden Werte als Worker-Variablen oder Secrets oder im Cloudflare-Dashboard und lade die Seite neu.",
    set: "Gesetzt",
    accessHint:
      "Wer sich anmelden darf. Deine eigene Adresse für eine persönliche Installation, deine E-Mail-Domain für ein Team.",
    sessionHint: "Mindestens 32 Zeichen. Erzeugen mit: openssl rand -base64 48",
    keyHint: "Ein Base64-kodierter 32-Byte-Schlüssel. Erzeugen mit: openssl rand -base64 32",
    providerHint:
      "Mindestens ein Anbieter. Die Schritte zur App-Registrierung stehen in der README.",
  },
  messages: {
    back: "Zurück zur Startseite",
    notAllowed: "Nicht erlaubt",
    notAvailable: "Noch nicht verfügbar",
    googleNotImplemented: "Die Anmeldung mit Google gibt es noch nicht.",
    signInExpired: "Anmeldung abgelaufen",
    signInExpiredText:
      "Die Anmeldung hat zu lange gedauert oder wurde woanders gestartet. Bitte neu beginnen.",
    providerRefused: (provider) => `${provider} hat die Anmeldung abgelehnt`,
    signInFailed: "Anmeldung fehlgeschlagen",
    noCode: (provider) => `${provider} hat keinen Autorisierungscode geliefert.`,
    exchangeFailed: (provider) =>
      `Der Token-Austausch mit ${provider} ist fehlgeschlagen. Details stehen in den Worker-Logs.`,
    notAllowedToSignIn: (email) => `${email} darf sich bei dieser Installation nicht anmelden.`,
    connectFailed: "Verbinden fehlgeschlagen",
    noRefreshToken: (provider) =>
      `${provider} hat kein Refresh-Token geliefert (offline_access fehlt).`,
    alreadyConnected: "Bereits verbunden",
    alreadyConnectedText: (email) =>
      `${email} ist bereits von einem anderen Nutzer dieser Installation verbunden.`,
  },
};
