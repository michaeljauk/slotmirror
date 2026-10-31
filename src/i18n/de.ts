import type { Messages } from "./en";

export const de: Messages = {
  nav: {
    accounts: "Konten",
    rules: "Regeln",
    activity: "Aktivität",
    admin: "Verwaltung",
    main: "Hauptnavigation",
    accountMenu: "Kontomenü",
    signOut: "Abmelden",
    deleteMyData: "Meine Daten löschen",
    privacy: "Datenschutz",
    version: "Version",
    language: "Sprache",
  },
  roles: {
    member: "Mitglied",
    admin: "Admin",
  },
  signIn: {
    title: "Anmelden",
    lead: "Halte deine Kalender synchron. Standardmäßig sehen andere nur, dass du belegt bist.",
    withProvider: (provider) => `Mit ${provider} anmelden`,
    googleNotice: "Google zeigt gleich, dass die App nicht überprüft ist.",
    googleNoticeSteps: "Öffne dort die erweiterten Optionen und gehe über den Link weiter zur App.",
    fineprint:
      "Teilnehmer werden nie kopiert. Titel, Orte und Notizen werden nur kopiert, wenn eine Regel das verlangt.",
  },
  accounts: {
    title: "Konten",
    lead: "Kalender, aus denen diese App liest und in die sie schreibt.",
    googleNotice: "Google zeigt gleich, dass die App nicht überprüft ist.",
    googleNoticeSteps: "Öffne dort die erweiterten Optionen und gehe über den Link weiter zur App.",
    kindGoogle: "Google Kalender",
    kindMicrosoftWork: "Microsoft 365 · Geschäftskonto",
    kindMicrosoftPersonal: "Microsoft 365 · privates Konto",
    operatorNoticeTitle: "Wer diese Installation betreibt",
    operatorNoticeLink: "Datenschutzerklärung",
    connectedOn: (date) => `verbunden am ${date}`,
    inSync: (time: string) => `Synchron · ${time}`,
    partlySynced: (time: string) => `Teilweise synchron · ${time}`,
    syncFailed: (code: string) => `Synchronisierung fehlgeschlagen: ${code}`,
    syncPaused: "Synchronisierung pausiert",
    lastRunAt: (time: string) => `Letzter Lauf ${time}`,
    changesFailed: (count: number) =>
      count === 1 ? "1 Änderung fehlgeschlagen" : `${count} Änderungen fehlgeschlagen`,
    notSynced: "Noch nicht synchronisiert",
    disconnect: "Trennen",
    rename: "Einstellungen",
    workHoursLabel: "Arbeitszeit",
    workHoursSwitch: "Nur während der Arbeitszeit kopieren",
    workHoursHint: "Lass beide Zeiten leer für ganze Tage.",
    workHoursApply: "Gilt für Kopien von",
    workHoursNoRules:
      "Noch kopiert nichts in dieses Konto. Sobald das so ist, schalte die Arbeitszeit in den Regeln ein.",
    workHoursInUse: (hours, used, total) =>
      `Arbeitszeit ${hours} · gilt für ${used} von ${total} ${total === 1 ? "Richtung" : "Richtungen"}`,
    workHoursUnused: (hours) => `Arbeitszeit ${hours} filtert noch nichts.`,
    workHoursChoose: "Richtungen wählen",
    workHoursIdle: (hours) => `Arbeitszeit ${hours} · noch kopiert nichts in dieses Konto`,
    colorLabel: "Farbe",
    colorHint: "Nur auf diesen Seiten, nicht in deinen Kalendern.",
    colorAuto: "Automatisch",
    colorNames: {
      green: "Grün",
      vermilion: "Zinnoberrot",
      purple: "Lila",
      orange: "Orange",
      blue: "Blau",
      sky: "Himmelblau",
      indigo: "Indigo",
      slate: "Schiefergrau",
    },
    nameLabel: "Name",
    nameHint: "Leer lassen für den Namen aus der Adresse.",
    save: "Speichern",
    connect: (provider) => `${provider} verbinden`,
    disconnectTitle: "Dieses Konto trennen?",
    disconnectText: (email) =>
      `slotmirror entfernt die Blöcke, die es in die Kalender von ${email} geschrieben hat, löscht danach seine Tokens und liest und schreibt diese Kalender nicht mehr.`,
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
      `Lauf beendet: ${applied === 1 ? "1 Änderung" : `${applied} Änderungen`} geschrieben, ${failed} fehlgeschlagen, ${remaining} für den nächsten Lauf.`,
    invalid:
      "Wähle zwei verschiedene Kalender. In den Zielkalender muss geschrieben werden dürfen.",
    lastRun: (blocks: number, time: string, changes: number) =>
      `${blocks === 1 ? "1 Block" : `${blocks} Blöcke`} · letzter Lauf ${time} · ${changes === 1 ? "1 Änderung" : `${changes} Änderungen`}`,
    lastRunFailed: (time: string, code: string) =>
      `letzter Lauf fehlgeschlagen · ${time} · ${code}`,
    capped: (level: string) => `Durch die Richtlinie dieser Installation begrenzt auf: ${level}`,
    privateNote: "Termine, die im Quellkalender privat sind, tragen nie mehr als „Belegt“.",
    overviewEmpty: "Noch keine Regeln. Lege die erste auf der Regelseite an.",
    active: "Aktiv",
    pausedShort: "Pausiert",
  },
  editor: {
    title: "Regeln",
    lead: "Pro Kalender: wohin seine Termine gehen und wie viel man dort sieht.",
    views: "Ansicht",
    viewList: "Liste",
    viewMatrix: "Übersicht",
    groupTitle: "Blocken sich gegenseitig",
    groupText: (count: number, markPrivate: boolean) =>
      `Diese ${count} Kalender sehen voneinander nur „Belegt“${markPrivate ? ", als privat markiert" : ""}.`,
    groupTooFew: "Wähle mindestens zwei Kalender.",
    groupAdd: "Zur Gruppe hinzufügen",
    groupRemove: "Aus der Gruppe nehmen",
    sourceTitle: (name: string) => `Termine aus ${name}`,
    to: "nach",
    manage: "Bearbeiten",
    choices: { off: "Nicht", busy: "Als belegt", title: "Mit Titel", full: "Alles" },
    short: { off: "nicht", busy: "belegt", title: "Titel", full: "alles" },
    looksLike: "Dort:",
    notThere: "taucht dort nicht auf",
    sampleWork: { title: "Angebot Q4 besprechen", detail: "Teams · Agenda, 3 Teilnehmer" },
    samplePrivate: { title: "Zahnarzt", detail: "Praxis Hauptplatz · Kontrolle" },
    fromGroup: "Aus der Gruppe „Blocken sich gegenseitig“",
    exception: "Ausnahme",
    reset: "zurücksetzen",
    checkReal: "Mit echten Terminen prüfen",
    checkShort: "Prüfen",
    capNote: (level: string) =>
      `Die Richtlinie dieser Installation erlaubt hier höchstens „${level}“.`,
    readOnly: "slotmirror kann in diesen Kalender nicht schreiben.",
    readOnlyTurnOff:
      "slotmirror kann in diesen Kalender nicht schreiben. Du kannst diese Richtung nur ausschalten.",
    moreOptions: "Mehr Optionen",
    save: "Speichern",
    matrixCorner: "Von ↓ · nach →",
    matrixHint: "Klick auf ein Feld öffnet diesen Kalender.",
    cellGroup: "Gruppe",
    cellException: "Ausnahme",
    manyTargets: (count: number) => `${count} Kalender`,
    needTwo: "Verbinde mindestens zwei Konten. Dann legst du hier fest, wohin ihre Termine gehen.",
    firstStepsTitle: "In drei Schritten loslegen",
    stepConnectFirst: "Verbinde dein erstes Kalenderkonto.",
    stepConnectSecond: "Verbinde ein zweites, zum Beispiel deinen Arbeits- oder Privatkalender.",
    stepChoose: "Lege hier fest, wohin die Termine jedes Kalenders gehen.",
    stepChooseRules: "Lege in den Regeln fest, wohin die Termine jedes Kalenders gehen.",
    openRules: "Regeln öffnen",
    activeDirections: (count) =>
      count === 1 ? "1 Richtung ist aktiv." : `${count} Richtungen sind aktiv.`,
    quickStartTitle: "Schnellstart",
    quickStartText: (count: number) =>
      `Alle ${count} Kalender blocken sich gegenseitig als „Belegt“. Details stellst du danach ein.`,
    quickStartButton: "Gegenseitig blocken",
    statusOk: (time: string) => `Alles synchron · ${time}`,
    changes: (count: number) => (count === 1 ? "1 Änderung" : `${count} Änderungen`),
    cancel: "Abbrechen",
    saveFailed: "Speichern fehlgeschlagen. Bitte noch einmal.",
    discard: "Verwerfen",
    settingsTitle: "Für alle Kalender",
    settingsLead: "Diese Einstellungen gelten für alle Richtungen oben.",
    window: "Zeitraum",
    blockTitleLabel: "Titel belegter Blöcke",
    blockTitleHint: "Diesen Titel tragen Kopien mit der Stufe „Als belegt“.",
    defaultBlockTitle: "Belegt",
    skipCategoriesLabel: "Termine mit diesen Kategorien auslassen",
    skipCategoriesHint:
      "Termine mit einer dieser Outlook-Kategorien werden nicht kopiert. Gross- und Kleinschreibung zählt nicht.",
    skipCategoriesCommas: "Trenne Namen durch Kommas.",
    skipCategoriesPlaceholder: "Privat, Fokus",
    skipCategoriesAdd: "Kategorie eingeben, dann Enter",
    skipCategoriesRemove: (name) => `${name} entfernen`,
    skipGroupTitle: "Nicht kopieren",
    skipColorsLabel: "Google-Termine mit diesen Farben auslassen",
    weekdays: ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"],
    weekdayNames: ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"],
    workStart: "Von",
    workEnd: "Bis",
    workTimeZone: "Zeitzone",
    workUntilMidnight: "bis Mitternacht",
    workZoneUnknown: (zone: string) =>
      `Dieser Server kennt die Zeitzone ${zone} nicht. Bis du eine andere wählst, gelten die Zeiten in UTC.`,
    onlyWorkHours: (name: string, hours: string) => `Nur in der Arbeitszeit von ${name} (${hours})`,
    onlyWorkHoursHint:
      "Nur Termine, die diese Zeiten berühren, werden kopiert, mit ihren vollen Zeiten.",
    setWorkHours: "Arbeitszeit festlegen",
    workHoursMissing: (name: string) =>
      `${name} hat keine Arbeitszeit. Lege sie in den Kontoeinstellungen fest. Es wurde nichts gespeichert.`,
    everyDay: "jeden Tag",
    allDay: "ganztags",
    workHoursErrors: {
      days: "Arbeitszeit: Wähle mindestens einen Wochentag. Es wurde nichts gespeichert.",
      time: "Arbeitszeit: Gib Beginn und Ende an, zum Beispiel 08:00 und 18:00, oder lass beide leer. Es wurde nichts gespeichert.",
      order:
        "Arbeitszeit: Das Ende muss nach dem Beginn liegen. Für das Tagesende wähle „bis Mitternacht“. Es wurde nichts gespeichert.",
      zone: "Arbeitszeit: Unbekannte Zeitzone. Gib einen Namen wie Europe/Vienna ein. Es wurde nichts gespeichert.",
    },
    saveConflict:
      "Diese Regeln wurden inzwischen geändert, zum Beispiel in einem anderen Tab. Lade die Seite neu und prüf sie.",
    workHoursDirection:
      "Diese Arbeitszeit gehört zu einer Richtung, die es nicht mehr gibt. Lade die Seite neu. Es wurde nichts gespeichert.",
    googleColor: (id: string) =>
      [
        "Lavendel",
        "Salbei",
        "Weintraube",
        "Flamingo",
        "Banane",
        "Mandarine",
        "Pfau",
        "Graphit",
        "Heidelbeere",
        "Basilikum",
        "Tomate",
      ][Number(id) - 1] ?? `Google-Farbe ${id}`,
    blockColorLabel: "Farbe der Kopien",
    blockColorNone: "Keine Farbe",
    blockCategoryLabel: "Outlook-Kategorie der Kopien",
    blockCategoryPlaceholder: "Kategorie",
    blockCategoryHint:
      "Outlook zeigt eine Farbe, wenn es eine Kategorie mit diesem Namen gibt. Lege sie zuerst in Outlook an.",
    bufferLabel: "Puffer",
    bufferNone: "Kein Puffer",
    bufferSummary: (before: number, after: number) =>
      before === after
        ? `${before} Min. davor und danach`
        : [before > 0 ? `${before} Min. davor` : "", after > 0 ? `${after} Min. danach` : ""]
            .filter(Boolean)
            .join(", "),
    bufferMixed: "unterschiedlich",
    bufferMixedHint:
      "Die Ziele dieses Kalenders haben verschiedene Puffer. Speichern setzt einen für alle.",
    change: "ändern",
    bufferBefore: "Min. davor",
    bufferAfter: "Min. danach",
    bufferHint: "Ganztägige Termine bekommen keinen Puffer.",
    blockCategoryComma:
      "Ein Kategoriename darf kein Komma enthalten: Outlook liest das Komma als Beginn einer zweiten Kategorie. Es wurde nichts gespeichert.",
    blockCategoryTooLong: (max: number) =>
      `Ein Kategoriename darf höchstens ${max} Zeichen haben. Es wurde nichts gespeichert.`,
    blockColorInvalid:
      "Diese Farbe passt nicht zum Kalender. Lade die Seite neu. Es wurde nichts gespeichert.",
    choiceInvalid: "Diese Auswahl gibt es nicht. Lade die Seite neu. Es wurde nichts gespeichert.",
    bufferInvalid: (max: number) =>
      `Ein Puffer ist eine ganze Zahl von Minuten zwischen 0 und ${max}. Es wurde nichts gespeichert.`,
    reconnectTitle: (email: string, provider: string) =>
      `Das ${provider}-Konto ${email} ist nicht mehr verbunden.`,
    reconnectText: "Bis du es neu verbindest, werden seine Kalender nicht synchronisiert.",
    reconnect: (email: string) => `${email} neu verbinden`,
    reconnectShort: "Neu verbinden",
    calendarsLabel: "Kalender",
    mainCalendar: "Hauptkalender",
    noSource: "Kein Kalender gewählt. Schalte mindestens einen ein.",
    skipAllDayTitle: "Ganztägige Termine auslassen",
    skipAllDayHint:
      "Sonst blocken Urlaub und Feiertage ganze Tage, außer sie sind als frei markiert.",
    skipTentativeTitle: "Termine mit Vorbehalt auslassen",
    skipTentativeHint: "„Vielleicht“-Antworten und vorläufige Termine blocken nicht.",
    markPrivateTitle: "Kopien als privat markieren",
    markPrivateHint: "Andere sehen „Privat“ statt des Titels. Du siehst alles.",
    days: (days: number) => `${days} Tage`,
    cellChanged: "geändert",
    checking: "Wird geprüft …",
    checkFailed: "Die Prüfung ist fehlgeschlagen. Bitte später noch einmal.",
    checkStale: "Diese Richtung hat sich inzwischen geändert. Lade die Seite neu.",
    checkNoTokens: "Dieses Konto ist nicht mehr angemeldet. Verbinde es auf der Kontenseite neu.",
    checkResult: (create: number, update: number, remove: number, unchanged: number) =>
      create + update + remove === 0
        ? `Stimmt mit dem Kalender überein · ${unchanged === 1 ? "1 Block" : `${unchanged} Blöcke`}`
        : `Beim nächsten Sync: ${create} neu, ${update} geändert, ${remove} entfernt`,
    othersTitle: "Weitere Regeln",
    othersLead:
      "Regeln zwischen anderen Kalendern als den Hauptkalendern. Der Editor oben ändert sie nicht.",
    statusFailed: (time: string, code: string) => `Sync fehlgeschlagen ${time} · ${code}`,
  },
  privacy: {
    title: "Datenschutz",
    operator: (name, contact) =>
      `Diese Installation von slotmirror betreibt ${name}. Kontakt: ${contact}.`,
    noticeTitle: "Hinweis des Betreibers",
    operatorUnknown: "Der Betreiber dieser Installation hat keine Kontaktadresse hinterlegt.",
    intro:
      "slotmirror spiegelt Belegt-Zeiten zwischen Kalendern. Es ist Open-Source-Software, die jeder Betreiber in seinem eigenen Cloudflare-Konto betreibt.",
    storedTitle: "Was gespeichert wird",
    stored: [
      "Deine E-Mail-Adresse und bei Microsoft-Konten die Tenant-ID und Objekt-ID, um dich und deine verbundenen Konten zu erkennen.",
      "OAuth-Tokens je verbundenem Konto, verschlüsselt mit AES-256-GCM.",
      "Die Namen deiner Kalender und die Regeln, die du anlegst.",
      "Ein Aktivitätsprotokoll mit Zeiten, Zahlen und Fehlercodes, ohne Termininhalte. Es wird nach 90 Tagen gelöscht.",
      "Ein Session-Cookie und ein Sprach-Cookie in deinem Browser.",
      "Für jeden Frei/Belegt-Feed, den du anlegst: seine Kalender, seine Einstellungen und ein Hash seiner geheimen Adresse. Wer die Adresse hat, sieht deine Belegt-Zeiten, ohne Inhalte. Der zuletzt erzeugte Feed, nur Belegt-Zeiten, wird beim Feed und im Cache von Cloudflare gehalten, um die nächsten Abrufe zu beantworten.",
    ],
    notStoredTitle: "Was nicht gespeichert wird",
    notStored:
      "Titel, Beschreibungen, Orte und Teilnehmer von Terminen werden beim Sync gelesen und nicht gespeichert. Blöcke im Zielkalender enthalten nur, was die Detailstufe der Regel erlaubt; Standard ist „Belegt“.",
    whereTitle: "Wo Daten verarbeitet werden",
    where:
      "In Cloudflare Workers, D1 und Durable Objects im Cloudflare-Konto des Betreibers sowie bei Microsoft und Google, wenn Kalender gelesen und geschrieben werden.",
    deleteTitle: "Wie du deine Daten löschst",
    delete:
      "Trennst du ein Konto, löscht slotmirror die dafür geschriebenen Blöcke und danach seine Tokens. Um deinen Nutzer mit allen Daten zu löschen, nutze „Meine Daten löschen“ im Kontomenü.",
    googleTitle: "Nutzerdaten von Google",
    google:
      "Die Nutzung und Weitergabe von Informationen aus Google APIs durch slotmirror entspricht der Google API Services User Data Policy, einschließlich der Anforderungen zur eingeschränkten Nutzung (Limited Use). Daten werden nur genutzt, um Belegt-Zeiten nach deinen Regeln anzuzeigen und zu spiegeln, und werden nie verkauft, für Werbung genutzt oder von Menschen gelesen.",
    noTracking: "Es gibt kein Tracking, keine Analyse und keine Werbung.",
  },
  admin: {
    activityLead: (count) =>
      `Die letzten ${count} Ereignisse aller Nutzer dieser Instanz. Nur Metadaten.`,
    activityAll: "Alle anzeigen",
    title: "Nutzer",
    lead: "Alle, die sich bei dieser Installation angemeldet haben. Kalenderinhalte bleiben privat.",
    email: "E-Mail",
    role: "Rolle",
    accounts: "Konten",
    lastSignIn: "Letzte Anmeldung",
    never: "nie",
    onlyAdmins: "Nur Admins können diese Seite öffnen.",
    deleteUser: "Löschen",
    resetSignIn: "Anmeldung zurücksetzen",
    resetSignInHint:
      "Löst die Bindung an das Microsoft- oder Google-Konto und beendet die Sitzungen. 24 Stunden lang bindet eine Anmeldung unter einer bestätigten Adresse die Person an ein neues Konto; das bisherige Konto bleibt gesperrt. Danach ist ein neuer Reset nötig.",
    inactive: "deaktiviert",
    needsReconnect: (count) =>
      count === 1 ? "1 muss neu verbunden werden" : `${count} müssen neu verbunden werden`,
    reconnectSummary: (count) =>
      count === 1
        ? "1 Nutzer hat ein Konto, das neu verbunden werden muss. Seine Kalender werden erst wieder synchronisiert, wenn der Nutzer es auf der Seite Konten neu verbindet."
        : `${count} Nutzer haben Konten, die neu verbunden werden müssen. Ihre Kalender werden erst wieder synchronisiert, wenn die Nutzer sie auf der Seite Konten neu verbinden.`,
    capsTitle: "Datenschutz-Grenzen",
    capsLead:
      "Wie viel von einem Termin höchstens zwischen Firmenkalendern und privaten Kalendern wandert. Das gilt für alle in dieser Installation, auch wenn jemand in seinen Sync-Einstellungen mehr wählt.",
    orgAccounts: (list: string) =>
      `Als Firmenkalender zählen Konten bei ${list}. Alle anderen Konten gelten als privat.`,
    orgNone:
      "Es ist keine Firmen-Domain und kein Entra-Tenant gesetzt (ALLOWED_DOMAINS, ALLOWED_TENANT_IDS). Damit gibt es keine Grenzen.",
    tenants: (count: number) => (count === 1 ? "1 Entra-Tenant" : `${count} Entra-Tenants`),
    capToExternal: "Firmentermine in privaten Kalendern",
    capFromExternal: "Private Termine in Firmenkalendern",
    capNone: "Keine Grenze",
    capAtMost: (level: string) => `Höchstens „${level}“`,
    capsHow:
      "Ändern über die Worker-Variablen MAX_DETAIL_TO_EXTERNAL und MAX_DETAIL_FROM_EXTERNAL.",
    compareTitle: "Vergleich",
    compareLead:
      "Prüft jeden Zielkalender gegen seine Quellen: Blöcke, die fehlen, übrig sind, abweichen oder doppelt vorkommen.",
    alertsTitle: "Alarme",
    alertsLead: "Sende eine Testnachricht an den Webhook dieser Installation. Eine pro Minute.",
    alertsOff: "Diese Installation hat keinen Alarm-Webhook und sendet deshalb keine Alarme.",
    testAlertSend: "Test-Alarm senden",
    testAlertResults: {
      sent: "Der Webhook hat den Test-Alarm angenommen.",
      off: "Diese Installation hat keinen Alarm-Webhook. Es wurde nichts gesendet.",
      failed: "Der Webhook hat den Test-Alarm nicht angenommen. Das Worker-Log nennt den Grund.",
      limited:
        "Ein Test-Alarm wurde vor weniger als einer Minute angefordert. Versuche es in einer Minute wieder.",
    },
    compareStart: "Vergleich starten",
    compareCounts: (started: number, open: number, failed: number) =>
      `${started} gestartet, ${open} noch offen, ${failed} fehlgeschlagen. Ein Kalender bleibt offen, bis sein Vergleich endet. Ergebnisse erscheinen in wenigen Minuten hier.`,
    compareEmpty: "Noch kein Vergleich.",
    compareHorizon:
      "Ein Vergleich lässt die ganztägigen Blöcke von heute und den letzten Tag jedes Sync-Fensters aus. Ein Treffer zählt erst, wenn er nach einem erfolgreichen Sync-Lauf bleibt. Ein Vergleich des ganzen Fensters liest auch beschreibbare Kalender ohne Regel: Jeder slotmirror-Block dort ist übrig.",
    compareModes: {
      full: "Ganzes Fenster",
      near: "Nächste 7 Tage",
      leftover: "Kalender ohne Regel",
    },
  },
  activity: {
    title: "Aktivität",
    lead: "Deine letzten 100 Ereignisse: Anmeldungen, Änderungen und Synchronisierungen. Inhalte von Terminen werden nie protokolliert.",
    orgLead: "Die letzten 100 Ereignisse aller Personen dieser Installation. Nur Metadaten.",
    time: "Zeit",
    account: "Konto",
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
      account_disconnect_failed: "Trennen fehlgeschlagen",
      cleanup_finished: "Entfernen der Blöcke beendet",
      account_renamed: "Konto umbenannt",
      token_refresh_failed: "Token-Erneuerung fehlgeschlagen",
      rule_created: "Regel erstellt",
      rule_deleted: "Regel gelöscht",
      rule_enabled: "Regel aktiviert",
      rule_paused: "Regel pausiert",
      rule_updated: "Regel geändert",
      group_changed: "Gruppe geändert",
      settings_changed: "Sync-Einstellungen geändert",
      user_provisioned: "Nutzer angelegt",
      user_deactivated: "Nutzer deaktiviert",
      user_reactivated: "Nutzer reaktiviert",
      user_deleted: "Nutzer gelöscht",
      sign_in_reset: "Anmeldebindung zurückgesetzt",
      sync_run: "Synchronisierung",
      sync_failed: "Synchronisierung fehlgeschlagen",
      sync_run_aborted: "Sync-Lauf abgebrochen",
      account_paused: "Konto pausiert",
      account_resumed: "Konto wieder aktiv",
      alert_sent: "Alarm an den Betreiber gesendet",
      alert_test: "Test-Alarm angefordert",
      compare_run: "Vergleich abgeschlossen",
      compare_failed: "Vergleich fehlgeschlagen",
      feed_created: "Frei/Belegt-Feed erstellt",
      feed_rotated: "Adresse des Frei/Belegt-Feeds erneuert",
      feed_deleted: "Frei/Belegt-Feed gelöscht",
    },
    changes: (create: number, update: number, remove: number) =>
      `${create} neu, ${update} geändert, ${remove} entfernt`,
    preview: (changes: string) => `Vorschau ${changes}`,
    failedCount: (count: number) => `${count} fehlgeschlagen`,
    throttledCount: (count: number) => `${count} gedrosselt, neuer Versuch nach der Wartezeit`,
    statuses: (list: string) => `HTTP ${list}`,
    remainingCount: (count: number) => `${count} offen`,
    abortedDetail: "Ohne erfasstes Ergebnis beendet",
    alertDetails: {
      rule_silent: "Eine Regel hatte keinen erfolgreichen Lauf",
      run_aborted: "Ein Lauf endete ohne Ergebnis",
      check_blind: "Die stündliche Prüfung konnte die Regeln nicht ansehen",
      compare_deviation: "Ein Vergleich hat Abweichungen bestätigt",
    },
    disconnectFailedDetail:
      "Die Blöcke konnten nicht zum Entfernen vorgemerkt werden. Nichts wurde geändert.",
    cleanupRemoved: (count: number) =>
      count === 1 ? "1 Block entfernt" : `${count} Blöcke entfernt`,
    cleanupLeft: (count: number) => (count === 1 ? "1 Block übrig" : `${count} Blöcke übrig`),
    cleanupReasons: {
      incomplete: "der Anbieter antwortet weiter mit Fehlern, lösche den Rest von Hand",
      token_refused: "der Anbieter lehnt die Tokens ab, lösche den Rest von Hand",
      no_tokens: "das Konto hat keine Tokens, lösche den Rest von Hand",
    },
    pausedDetail: (code: string) => `Wartet auf neue Verbindung (${code})`,
    resumedDetail: "Synchronisiert wieder",
    compareClean: (count: number) =>
      count === 1 ? "Keine Abweichung in 1 Block" : `Keine Abweichung in ${count} Blöcken`,
    compareFound: (missing: number, surplus: number, mismatched: number, duplicates: number) =>
      `${missing} fehlen, ${surplus} übrig, ${mismatched} abweichend, ${duplicates} doppelt`,
    compareCleared: (count: number, found: string) =>
      `${count} gefunden, nach einem Sync-Lauf nicht mehr da (${found})`,
    compareUnconfirmed: (count: number) => `${count} einmal gefunden, nicht bestätigt`,
    compareCapped: "Liste gekürzt",
    compareNothing: "Nichts zu vergleichen: kein Block gewünscht, keiner gefunden",
    compareNoLeftovers: "Kein Block übrig",
    compareReasons: {
      removal_queue: "Aus diesem Kalender werden noch Blöcke entfernt",
      token_lost: "Ein Konto hat sein Token verloren",
      paused: "Ein Konto wartet auf neue Verbindung",
      throttled: "Der Anbieter hat das Lesen gedrosselt",
      config_changed: "Eine Regel hat sich während des Vergleichs geändert",
      source_unavailable: "Ein Quellkalender ist nicht mehr lesbar",
      read_failed: "Ein Kalender konnte nicht gelesen werden",
      slice_too_large: "Ein Tag enthält zu viele Termine für den Vergleich",
      empty_horizon: "Die Sync-Fenster sind für einen Vergleich zu kurz",
      timeout: "Der Vergleich endete nicht innerhalb eines Tages",
      superseded: "Ein Vergleich des ganzen Fensters hat diesen abgelöst",
    },
  },
  feeds: {
    title: "Frei/Belegt-Feed",
    lead: "Eine geheime Kalenderadresse für Personen außerhalb dieser Installation. Sie zeigt, wann du belegt bist, nie, was du tust.",
    empty: "Noch kein Feed.",
    noCalendars:
      "Deine Kalender erscheinen hier, sobald du nach dem Verbinden eines Kontos die Regeln öffnest.",
    feedTitle: (date) => `Feed vom ${date}`,
    renewedOn: (date) => `neue Adresse ${date}`,
    daysAhead: (count) => `${count} Tage voraus`,
    withAllDay: "mit ganztägigen Terminen",
    cut: (date) =>
      `Zu viele Belegt-Zeiten: Der Feed endet vor dem ${date}. Wähle weniger Tage oder Kalender.`,
    calendarUnreadable: (name) =>
      `„${name}“ lässt sich nicht mehr lesen, Abonnenten bekommen keine Aktualisierung. Entferne den Kalender aus dem Feed.`,
    removeCalendar: "Kalender entfernen",
    create: "Neuer Feed",
    calendarsLabel: (max) => `Kalender, höchstens ${max}`,
    daysLabel: "Tage voraus",
    allDayLabel: "Ganztägige Termine einschließen",
    shares:
      "Abonnenten sehen, wann du belegt bist, ab 7 Tagen in der Vergangenheit: Blöcke mit dem Titel „Belegt“, als privat markiert, wobei überlappende Termine einen Block bilden. Titel, Orte, Notizen und Teilnehmer bleiben draußen, ebenso freie und abgelehnte Termine. Wählbar sind nur Kalender, die deinen Konten gehören.",
    submit: "Feed erstellen",
    rotate: "Neue Adresse",
    rotateText:
      "Die bisherige Adresse funktioniert sofort nicht mehr. Wer sie abonniert hat, braucht die neue.",
    rotateConfirm: "Neue Adresse erstellen",
    remove: "Löschen",
    removeText:
      "Die Adresse funktioniert sofort nicht mehr. Abonnenten sehen deine Belegt-Zeiten nicht mehr.",
    removeConfirm: "Feed löschen",
    urlTitle: "Deine Feed-Adresse",
    urlLead:
      "Kopiere die Adresse jetzt. Sie wird nur einmal angezeigt; slotmirror speichert nur einen Hash davon.",
    urlHint:
      "Wer diese Adresse hat, sieht deine Belegt-Zeiten. Gib sie nur Personen, die sie sehen sollen. Sie abonnieren sie per URL in ihrer Kalender-App. Eine Änderung erscheint nach etwa 15 Minuten, plus dem Aktualisierungsintervall ihrer App.",
    copy: "Kopieren",
    copied: "Kopiert",
    back: "Zurück zu den Konten",
    errorTitle: "Feed nicht erstellt",
    noCalendar: "Wähle mindestens einen Kalender.",
    tooManyCalendars: (max) => `Wähle höchstens ${max} Kalender.`,
    tooManyFeeds: (max) => `Du hast bereits ${max} Feeds. Lösche zuerst einen.`,
    calendarName: "Belegt-Zeiten",
    eventTitle: "Belegt",
  },
  setup: {
    title: "Einrichtung abschließen",
    lead: "Setze die fehlenden Werte als Variablen oder Secrets im Cloudflare-Dashboard (dein Worker, Settings, Variables and Secrets) und lade die Seite neu.",
    set: "Gesetzt",
    accessHint:
      "Wer sich anmelden darf. Deine eigene Adresse für eine persönliche Installation, deine E-Mail-Domain für ein Team.",
    sessionHint:
      "Mindestens 32 Zeichen. Mit openssl: openssl rand -base64 48. Ohne openssl zeigt der Quickstart einen Weg für Windows.",
    keyHint:
      "Ein Base64-kodierter 32-Byte-Schlüssel. Mit openssl: openssl rand -base64 32. Ohne openssl zeigt der Quickstart einen Weg für Windows.",
    providerHint:
      "Mindestens ein Anbieter, den SIGN_IN_PROVIDERS für die Anmeldung erlaubt. Der Quickstart zeigt die Schritte zur App-Registrierung.",
    providerInvalidHint: (value: string) =>
      `SIGN_IN_PROVIDERS steht auf „${value}“. Gültige Einträge sind microsoft und google. Beide schreibst du so: microsoft,google. Oder entferne die Variable, dann gilt jeder eingerichtete Anbieter.`,
    jurisdictionNote:
      "Wenn die Daten in der EU bleiben sollen, setze jetzt DATA_JURISDICTION auf eu, bevor du das erste Konto verbindest. Eine spätere Änderung trennt alle Konten. Setze außerdem PUBLIC_URL auf die Adresse dieses Workers, damit Änderungen schnell ankommen.",
    docsLink: "Quickstart öffnen",
  },
  deleteUser: {
    titleSelf: "Meine Daten löschen",
    titleOther: (email: string) => `${email} löschen`,
    intro: "Damit wird entfernt:",
    accounts: (count: number) =>
      count === 1
        ? "1 verbundenes Konto mit seinen Tokens"
        : `${count} verbundene Konten mit ihren Tokens`,
    rules: "Alle Sync-Einstellungen und Regeln",
    blocks: "Die geschriebenen Blöcke ab heute. Vergangene Blöcke bleiben in den Kalendern.",
    userRow: "Der Nutzer selbst",
    activityStays:
      "Einträge im Aktivitätslog bleiben bis zum Ende der Aufbewahrungsfrist, ohne Termininhalte. Das lässt sich nicht rückgängig machen.",
    confirmSelf: "Meine Daten löschen",
    confirmOther: "Nutzer löschen",
    cancel: "Abbrechen",
    doneTitle: "Deine Daten sind gelöscht",
    doneText: "Die Blöcke verschwinden in den nächsten Minuten aus deinen Kalendern.",
  },
  oauthError: {
    codeLabel: "Fehlercode",
    referenceLabel: "Referenz",
    help: "Was dieser Code bedeutet",
    tryAgain: "Erneut versuchen",
    back: "Zurück",
    consentTitle: (provider) => `${provider} braucht zuerst eine Freigabe`,
    consentLead: (provider) =>
      `${provider} hat slotmirror nicht weitermachen lassen. Vielleicht hast du abgebrochen, oder deine Organisation erlaubt es nicht, Apps selbst freizugeben.`,
    consentSteps:
      "Wenn du abgebrochen hast, versuche es noch einmal. Wenn deine Organisation die Freigabe sperrt, schicke die Anfrage unten an deine IT-Administration. Versuche es erneut, sobald sie freigegeben hat.",
    googleConsentSteps:
      "Wenn du abgebrochen hast, versuche es noch einmal und gib den Zugriff frei, um den Google bittet.",
    requestTitle: "Anfrage an deine Administration",
    copy: "Kopieren",
    copied: "Kopiert",
    adminRequest: (params) =>
      `Bitte gebt die App "${params.appName}" für unsere Microsoft-365-Organisation frei.\n\n` +
      `Anwendungs-ID (Client-ID): ${params.clientId}\n` +
      `Berechtigungen (delegiert): ${params.permissions}\n` +
      `Zweck: Die App liest die Belegtzeiten von Kalendern und schreibt "Busy"-Blöcke in andere Kalender. Teilnehmer werden nie kopiert. Titel, Orte und Notizen werden nur kopiert, wenn eine Regel das verlangt.\n\n` +
      `Für die ganze Organisation freigeben: ${params.link}\n` +
      `Dafür ist die Rolle Globaler Administrator, Administrator für privilegierte Rollen oder Cloudanwendungsadministrator nötig.`,
    adminConsentTitle: "Zurück von Microsoft",
    adminConsentText:
      "Wenn du die App freigegeben hast, können es Personen deiner Organisation jetzt erneut versuchen. Diese Seite bestätigt die Freigabe nicht und meldet dich nicht an.",
    tenantTitle: "Dieses Konto gehört nicht zur Organisation",
    tenantLead:
      "Microsoft meldet, dass das Konto im Verzeichnis dieser App nicht existiert. Melde dich mit einem Konto dieser Organisation an, oder lass dich von der Administration als Gast einladen.",
  },
  messages: {
    back: "Zurück zur Startseite",
    notAllowed: "Nicht erlaubt",
    crossSiteRequest:
      "Diese Anfrage kam von einer anderen Website. Öffne slotmirror direkt und versuche es noch einmal.",
    notAvailable: "Noch nicht verfügbar",
    errorTitle: "Etwas ist schiefgelaufen",
    errorText: "Die Anfrage ist fehlgeschlagen. Bitte gleich noch einmal versuchen.",
    providerNotConfigured: (provider) =>
      `${provider} ist für diese Installation nicht eingerichtet. Die Verwaltung muss die Client-ID hinterlegen.`,
    signInExpired: "Anmeldung abgelaufen",
    signInExpiredText:
      "Die Anmeldung hat zu lange gedauert oder wurde woanders gestartet. Bitte neu beginnen.",
    providerRefused: (provider) => `${provider} hat die Anmeldung abgelehnt`,
    signInFailed: "Anmeldung fehlgeschlagen",
    noCode: (provider) => `${provider} hat keinen Autorisierungscode geliefert.`,
    exchangeFailed: (provider) =>
      `Der Token-Austausch mit ${provider} ist fehlgeschlagen. Nenne bei einer Rückfrage den Code und die Referenz unten.`,
    providerRefusedText: (provider) =>
      `${provider} hat einen Fehler gemeldet. Diese Seite zeigt nur den Code, nicht den Text. Nenne bei einer Rückfrage den Code und die Referenz unten.`,
    notAllowedToSignIn: (email) => `${email} darf sich bei dieser Installation nicht anmelden.`,
    otherIdentity: (email, provider) =>
      `${email} gehört in dieser Installation zu einem anderen ${provider}-Konto. Melde dich mit dem Konto an, das du bisher verwendet hast, oder frag die Verwaltung.`,
    useOtherProvider: (email, provider) =>
      `${email} meldet sich bei dieser Installation mit ${provider} an. Nutze die Anmeldung mit ${provider}, oder frag die Verwaltung.`,
    connectFailed: "Verbinden fehlgeschlagen",
    noRefreshToken: (provider) =>
      `${provider} hat kein Refresh-Token geliefert (offline_access fehlt).`,
    signInProviderOff: (provider: string) =>
      `Diese Installation bietet keine Anmeldung mit ${provider} an. Nach der Anmeldung kannst du ${provider}-Konten trotzdem verbinden.`,
    alreadyConnected: "Bereits verbunden",
    alreadyConnectedText: (email) =>
      `${email} ist bereits von einem anderen Nutzer dieser Installation verbunden.`,
  },
  mirror: {
    origin: (account, provider) => `Aus: ${account} (${provider})`,
    originAccount: (provider) => `Aus: ${provider}-Konto`,
    microsoft: "Microsoft",
    google: "Google",
  },
  alerts: {
    test: (url) =>
      `slotmirror: Dies ist ein Test-Alarm von der Verwaltungsseite. Der Webhook funktioniert.${url ? ` ${url}` : ""}`,
    reconnect: (provider, url) =>
      `slotmirror: Ein ${provider}-Konto muss neu verbunden werden. Bis sein Nutzer es neu verbindet, werden seine Kalender nicht synchronisiert. Die Verwaltungsseite zeigt die betroffenen Nutzer.${url ? ` ${url}` : ""}`,
    silentRules: (count, hours, idle, failing, url) =>
      `slotmirror: ${count} aktive ${count === 1 ? "Sync-Regel hatte" : "Sync-Regeln hatten"} seit ${hours} Stunden keinen erfolgreichen Lauf. Sie sollten stündlich laufen, und ihre Konten sind verbunden.${idle ? ` Kein Lauf: ${idle}.` : ""}${failing ? ` Läufe mit Fehlern: ${failing}.` : ""} Das Aktivitätsprotokoll auf der Verwaltungsseite zeigt jeden Lauf.${url ? ` ${url}` : ""}`,
    checkBlind: (reason, url) =>
      `slotmirror: Die stündliche Prüfung der Sync-Regeln kann nicht arbeiten. ${reason} Bis das endet, kann eine Regel ohne Alarm stehen bleiben.${url ? ` ${url}` : ""}`,
    blindCauses: {
      scanLimit: "Das Aktivitätsprotokoll enthält zu viele neue Zeilen für eine Prüfung.",
      database: "Ein Lesezugriff auf die Datenbank schlug fehl.",
      access: "Die Zugriffseinstellungen lassen keinen Besitzer einer aktiven Regel zu.",
    },
    abortedRuns: (count, ruleIds, url) =>
      `slotmirror: Ein Sync-Lauf von ${count} ${count === 1 ? "Regel" : "Regeln"} hat vor seinem Ende gestoppt, zum Beispiel an einem Plattform-Limit. Der nächste Lauf kann das selbst beheben. Regel-IDs: ${ruleIds}. Das Aktivitätsprotokoll auf der Verwaltungsseite zeigt jeden Lauf.${url ? ` ${url}` : ""}`,
    compareDeviations: (count, withRules, leftover, url) =>
      `slotmirror: Ein Vergleich hat Abweichungen in ${count} ${count === 1 ? "Kalender" : "Kalendern"} bestätigt.${withRules ? ` Diese blieben nach einem erfolgreichen Lauf bestehen: ${withRules}.` : ""}${leftover ? ` Zwei Scans fanden Blöcke in Kalendern ohne aktive Regel: ${leftover}.` : ""} Die Verwaltungsseite zeigt jeden Vergleich.${url ? ` ${url}` : ""}`,
  },
};
