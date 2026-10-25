import type { Messages } from "./en";

export const de: Messages = {
  nav: {
    accounts: "Konten",
    rules: "Regeln",
    activity: "Aktivität",
    admin: "Verwaltung",
    accountMenu: "Kontomenü",
    signOut: "Abmelden",
    privacy: "Datenschutz",
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
    inSync: (time: string) => `Synchron · ${time}`,
    partlySynced: (time: string) => `Teilweise synchron · ${time}`,
    syncFailed: (code: string) => `Synchronisierung fehlgeschlagen: ${code}`,
    changesFailed: (count: number) => `${count} Änderungen fehlgeschlagen`,
    notSynced: "Noch nicht synchronisiert",
    disconnect: "Trennen",
    connect: (provider) => `${provider} verbinden`,
    disconnectTitle: "Dieses Konto trennen?",
    disconnectText: (email) =>
      `freebusy-sync löscht seine Tokens für ${email} und liest und schreibt dessen Kalender nicht mehr.`,
    disconnectRules: (count) =>
      count === 0
        ? "Keine Regel nutzt dieses Konto."
        : count === 1
          ? "1 Regel nutzt dieses Konto. Sie wird gelöscht, und die Blöcke, die sie geschrieben hat, werden entfernt."
          : `${count} Regeln nutzen dieses Konto. Sie werden gelöscht, und die Blöcke, die sie geschrieben haben, werden entfernt.`,
    disconnectConfirm: "Konto trennen",
    cancel: "Abbrechen",
  },
  rules: {
    title: "Regeln",
    lead: "Jede Regel kopiert Termine aus einem Kalender in einen anderen, in eine Richtung.",
    emptyTitle: "Noch keine Regeln",
    emptyText:
      "Lege unten eine Regel an. Für beide Richtungen braucht es zwei Regeln, jede mit eigener Detailstufe.",
    manage: "Regeln verwalten",
    newRule: "Neue Regel",
    from: "Von",
    to: "Nach",
    detail: "Details",
    detailLevels: {
      busy: "Nur belegt",
      title: "Titel",
      title_location: "Titel und Ort",
      full: "Alle Details",
    },
    markPrivate: "Blöcke als privat markieren",
    skipAllDay: "Ganztägige Termine auslassen",
    skipTentative: "Vorläufige Termine auslassen",
    daysAhead: "Tage voraus",
    days: (days) => `${days} Tage voraus`,
    choose: "Kalender wählen",
    create: "Regel anlegen",
    enable: "Aktivieren",
    pause: "Pausieren",
    paused: "Pausiert · läuft erst nach dem Aktivieren",
    newRulesPaused: "Neue Regeln starten pausiert. Prüfe die Vorschau, dann aktiviere sie.",
    preview: "Vorschau",
    runNow: "Jetzt ausführen",
    delete: "Löschen",
    refreshCalendars: "Kalender neu laden",
    noCalendars: "Verbinde zuerst ein Konto, dann erscheinen hier seine Kalender.",
    previewResult: (create, update, remove, unchanged) =>
      `Vorschau: ${create} anlegen, ${update} ändern, ${remove} löschen, ${unchanged} unverändert. Es wurde nichts geschrieben.`,
    runResult: (applied, failed, remaining) =>
      `Lauf beendet: ${applied} Änderungen geschrieben, ${failed} fehlgeschlagen, ${remaining} für den nächsten Lauf.`,
    invalid:
      "Wähle zwei verschiedene Kalender. In den Zielkalender muss geschrieben werden dürfen.",
    lastRun: (blocks: number, time: string, changes: number) =>
      `${blocks} Blöcke · letzter Lauf ${time} · ${changes} Änderungen`,
    lastRunFailed: (time: string, code: string) =>
      `letzter Lauf fehlgeschlagen · ${time} · ${code}`,
    capped: (level: string) => `Durch die Richtlinie dieser Installation begrenzt auf: ${level}`,
    privateNote: "Termine, die im Quellkalender privat sind, tragen nie mehr als „Belegt“.",
    overviewEmpty: "Noch keine Regeln. Lege die erste auf der Regelseite an.",
    active: "Aktiv",
    pausedShort: "Pausiert",
  },
  privacy: {
    title: "Datenschutz",
    operator: (name, contact) =>
      `Diese Installation von freebusy-sync betreibt ${name}. Kontakt: ${contact}.`,
    operatorUnknown: "Der Betreiber dieser Installation hat keine Kontaktadresse hinterlegt.",
    intro:
      "freebusy-sync spiegelt Belegt-Zeiten zwischen Kalendern. Es ist Open-Source-Software, die jeder Betreiber in seinem eigenen Cloudflare-Konto betreibt.",
    storedTitle: "Was gespeichert wird",
    stored: [
      "Deine E-Mail-Adresse und bei Microsoft-Konten die Tenant-ID, um dich und deine verbundenen Konten zu erkennen.",
      "OAuth-Tokens je verbundenem Konto, verschlüsselt mit AES-256-GCM.",
      "Die Namen deiner Kalender und die Regeln, die du anlegst.",
      "Ein Aktivitätsprotokoll mit Zeiten, Zahlen und Fehlercodes, ohne Termininhalte. Es wird nach 90 Tagen gelöscht.",
      "Ein Session-Cookie und ein Sprach-Cookie in deinem Browser.",
    ],
    notStoredTitle: "Was nicht gespeichert wird",
    notStored:
      "Titel, Beschreibungen, Orte und Teilnehmer von Terminen werden beim Sync gelesen und nicht gespeichert. Blöcke im Zielkalender enthalten nur, was die Detailstufe der Regel erlaubt; Standard ist „Belegt“.",
    whereTitle: "Wo Daten verarbeitet werden",
    where:
      "In Cloudflare Workers, D1 und Durable Objects im Cloudflare-Konto des Betreibers sowie bei Microsoft und Google, wenn Kalender gelesen und geschrieben werden.",
    deleteTitle: "Wie du deine Daten löschst",
    delete:
      "Trennst du ein Konto, werden seine Tokens und die von freebusy-sync dafür geschriebenen Blöcke gelöscht. Um deinen Nutzer zu löschen, wende dich an den Betreiber.",
    googleTitle: "Nutzerdaten von Google",
    google:
      "Die Nutzung und Weitergabe von Informationen aus Google APIs durch freebusy-sync entspricht der Google API Services User Data Policy, einschließlich der Anforderungen zur eingeschränkten Nutzung (Limited Use). Daten werden nur genutzt, um Belegt-Zeiten nach deinen Regeln anzuzeigen und zu spiegeln, und werden nie verkauft, für Werbung genutzt oder von Menschen gelesen.",
    noTracking: "Es gibt kein Tracking, keine Analyse und keine Werbung.",
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
    capsTitle: "Detail-Grenzen",
    capsLead:
      "Wie viel Detail eine Regel höchstens zwischen Konten der Organisation und anderen Konten kopiert. Gesetzt über MAX_DETAIL_TO_EXTERNAL und MAX_DETAIL_FROM_EXTERNAL; Konten der Organisation passen zu ALLOWED_TENANT_IDS oder ALLOWED_DOMAINS.",
    capToExternal: "Vom Konto der Organisation in ein anderes Konto",
    capFromExternal: "Von einem anderen Konto in ein Konto der Organisation",
  },
  activity: {
    title: "Aktivität",
    lead: "Deine letzten 100 Ereignisse: Anmeldungen, Änderungen und Synchronisierungen. Inhalte von Terminen werden nie protokolliert.",
    orgLead: "Die letzten 100 Ereignisse aller Personen dieser Installation. Nur Metadaten.",
    time: "Zeit",
    event: "Ereignis",
    details: "Details",
    empty: "Noch nichts passiert.",
    retention: (days: number) => `Ereignisse werden nach ${days} Tagen gelöscht.`,
    kinds: {
      sign_in: "Angemeldet",
      sign_in_refused: "Anmeldung abgelehnt",
      sign_out: "Abgemeldet",
      account_connected: "Konto verbunden",
      account_disconnected: "Konto getrennt",
      token_refresh_failed: "Token-Erneuerung fehlgeschlagen",
      rule_created: "Regel erstellt",
      rule_deleted: "Regel gelöscht",
      rule_enabled: "Regel aktiviert",
      rule_paused: "Regel pausiert",
      sync_run: "Synchronisierung",
      sync_failed: "Synchronisierung fehlgeschlagen",
    },
    changes: (create: number, update: number, remove: number) =>
      `+${create} / ~${update} / −${remove}`,
    preview: (changes: string) => `Vorschau ${changes}`,
    failedCount: (count: number) => `${count} fehlgeschlagen`,
    throttledCount: (count: number) => `${count} gedrosselt, neuer Versuch nach der Wartezeit`,
    statuses: (list: string) => `HTTP ${list}`,
    remainingCount: (count: number) => `${count} offen`,
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
      "Mindestens ein Anbieter, den SIGN_IN_PROVIDERS für die Anmeldung erlaubt. Die Schritte zur App-Registrierung stehen in der README.",
  },
  messages: {
    back: "Zurück zur Startseite",
    notAllowed: "Nicht erlaubt",
    notAvailable: "Noch nicht verfügbar",
    providerNotConfigured: (provider) =>
      `${provider} ist für diese Installation nicht eingerichtet. Die Verwaltung muss die Client-ID hinterlegen.`,
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
    signInProviderOff: (provider: string) =>
      `Diese Installation bietet keine Anmeldung mit ${provider} an. Nach der Anmeldung kannst du ${provider}-Konten trotzdem verbinden.`,
    alreadyConnected: "Bereits verbunden",
    alreadyConnectedText: (email) =>
      `${email} ist bereits von einem anderen Nutzer dieser Installation verbunden.`,
  },
};
