/**
 * English messages. This file defines the shape every other locale must match.
 * Plain strings for fixed text, functions for text with values.
 */
export const en = {
  nav: {
    accounts: "Accounts",
    rules: "Sync",
    activity: "Activity",
    admin: "Admin",
    accountMenu: "Account menu",
    signOut: "Sign out",
    deleteMyData: "Delete my data",
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
    syncPaused: "Sync paused",
    lastRunAt: (time: string) => `Last run ${time}`,
    changesFailed: (count: number) => (count === 1 ? "1 change failed" : `${count} changes failed`),
    disconnect: "Disconnect",
    rename: "Settings",
    workHoursLabel: "Working hours",
    workHoursHint: "Applies to everything copied into this account.",
    workHoursTitle:
      "You turn it on per calendar in the sync settings. Without working hours the whole day counts.",
    workHoursNone: "No working hours",
    colorLabel: "Colour",
    colorHint: "Only on these pages, not in your calendars.",
    colorAuto: "Automatic",
    colorNames: {
      green: "Green",
      vermilion: "Vermilion",
      purple: "Purple",
      orange: "Orange",
      blue: "Blue",
      sky: "Sky",
      indigo: "Indigo",
      slate: "Slate",
    },
    nameLabel: "Name",
    nameHint: "Leave empty for the name from the address.",
    save: "Save",
    connect: (provider: string) => `Connect ${provider}`,
    disconnectTitle: "Disconnect this account?",
    disconnectText: (email: string) =>
      `slotmirror removes the blocks it wrote into the calendars of ${email}, then deletes its tokens and stops reading and writing these calendars.`,
    disconnectRules: (count: number) =>
      count === 0
        ? "No rule uses this account."
        : count === 1
          ? "1 rule uses this account. It is deleted, and the blocks it wrote are removed."
          : `${count} rules use this account. They are deleted, and the blocks they wrote are removed.`,
    disconnectConfirm: "Disconnect account",
    cancel: "Cancel",
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
    enable: "Turn on",
    pause: "Pause",
    paused: "Paused · runs only after you turn it on",
    newRulesPaused: "New rules start paused. Check the preview, then turn them on.",
    preview: "Preview",
    runNow: "Run now",
    delete: "Delete",
    refreshCalendars: "Reload calendars",
    noCalendars: "Connect an account first; its calendars appear here.",
    previewResult: (create: number, update: number, remove: number, unchanged: number) =>
      `Preview: ${create} to create, ${update} to update, ${remove} to delete, ${unchanged} unchanged. Nothing was written.`,
    runResult: (applied: number, failed: number, remaining: number) =>
      `Run finished: ${applied === 1 ? "1 change" : `${applied} changes`} written, ${failed} failed, ${remaining} left for the next run.`,
    invalid: "Choose two different calendars. The target calendar must be writable.",
    lastRun: (blocks: number, time: string, changes: number) =>
      `${blocks === 1 ? "1 block" : `${blocks} blocks`} · last run ${time} · ${changes === 1 ? "1 change" : `${changes} changes`}`,
    lastRunFailed: (time: string, code: string) => `last run failed · ${time} · ${code}`,
    privateNote: "Events marked private in the source never carry more than Busy.",
    capped: (level: string) => `Limited to ${level} by this deployment's policy`,
    overviewEmpty: "No rules yet. Add the first one on the rules page.",
    active: "Active",
    pausedShort: "Paused",
  },
  editor: {
    title: "Where your events go",
    lead: "For each calendar: where its events go and how much shows there.",
    views: "View",
    viewList: "List",
    viewMatrix: "Overview",
    groupTitle: "Block each other",
    groupText: (count: number, markPrivate: boolean) =>
      `These ${count} calendars see each other only as busy${markPrivate ? ", marked private" : ""}.`,
    groupTooFew: "Choose at least two calendars.",
    groupAdd: "Add to the group",
    groupRemove: "Remove from the group",
    sourceTitle: (name: string) => `Events from ${name}`,
    to: "to",
    manage: "Edit",
    choices: { off: "Not", busy: "As busy", title: "With title", full: "Everything" },
    short: { off: "no", busy: "busy", title: "title", full: "all" },
    looksLike: "There:",
    notThere: "does not appear there",
    sampleWork: { title: "Discuss the Q4 offer", detail: "Teams · agenda, 3 attendees" },
    samplePrivate: { title: "Dentist", detail: "Main square practice · check-up" },
    fromGroup: "From the group “Block each other”",
    exception: "Exception",
    reset: "reset",
    checkReal: "Check with real events",
    capNote: (level: string) => `This deployment's policy allows at most “${level}” here.`,
    readOnly: "slotmirror cannot write to this calendar.",
    readOnlyTurnOff:
      "slotmirror cannot write to this calendar. You can only turn this direction off.",
    moreOptions: "More options",
    save: "Save",
    matrixCorner: "From ↓ · to →",
    matrixHint: "Click a cell to open that calendar on the left.",
    cellGroup: "group",
    cellException: "exception",
    manyTargets: (count: number) => `${count} calendars`,
    needTwo: "Connect at least two accounts. Then choose here where their events go.",
    firstStepsTitle: "Get started in three steps",
    stepConnectFirst: "Connect your first calendar account.",
    stepConnectSecond: "Connect a second one, for example your work or your private calendar.",
    stepChoose: "Choose here where the events of each calendar go.",
    quickStartTitle: "Quick start",
    quickStartText: (count: number) =>
      `All ${count} calendars block each other as busy. Add detail per direction later.`,
    quickStartButton: "Block each other",
    statusOk: (time: string) => `Everything in sync · ${time}`,
    changes: (count: number) => (count === 1 ? "1 change" : `${count} changes`),
    cancel: "Cancel",
    saveFailed: "Saving failed. Try again.",
    discard: "Discard",
    settingsTitle: "For all calendars",
    settingsLead: "These settings apply to every direction above.",
    window: "Time window",
    blockTitleLabel: "Title of busy blocks",
    blockTitleHint: "Copies at the level “As busy” carry this title.",
    defaultBlockTitle: "Busy",
    skipCategoriesLabel: "Skip events with these categories",
    skipCategoriesHint: "Outlook category names, separated by commas, for example Private, Focus.",
    skipCategoriesPlaceholder: "Private, Focus",
    skipColorsLabel: "Skip Google events with these colours",
    weekdays: ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"],
    weekdayNames: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
    workStart: "From",
    workEnd: "Until",
    workTimeZone: "Time zone",
    workUntilMidnight: "until midnight",
    workZoneUnknown: (zone: string) =>
      `This server does not know the time zone ${zone}. Until you choose another one, the hours are read in UTC.`,
    onlyWorkHours: (name: string, hours: string) =>
      `Only during the working hours of ${name} (${hours})`,
    onlyWorkHoursHint: "Only events that touch these hours are copied, with their full times.",
    setWorkHours: "Set working hours",
    workHoursMissing: (name: string) =>
      `${name} has no working hours. Set them in the account settings. Nothing was saved.`,
    everyDay: "every day",
    allDay: "all day",
    workHoursErrors: {
      days: "Working hours: choose at least one weekday. Nothing was saved.",
      time: "Working hours: enter a start and an end, for example 08:00 and 18:00, or leave both empty. Nothing was saved.",
      order:
        "Working hours: the end must be after the start. For the end of the day, choose “until midnight”. Nothing was saved.",
      zone: "Working hours: unknown time zone. Enter a name such as Europe/Vienna. Nothing was saved.",
    },
    saveConflict:
      "These rules changed in the meantime, for example in another tab. Reload the page and check them.",
    workHoursDirection:
      "These working hours belong to a direction that no longer exists. Reload the page. Nothing was saved.",
    googleColor: (id: string) =>
      [
        "Lavender",
        "Sage",
        "Grape",
        "Flamingo",
        "Banana",
        "Tangerine",
        "Peacock",
        "Graphite",
        "Blueberry",
        "Basil",
        "Tomato",
      ][Number(id) - 1] ?? `Google colour ${id}`,
    blockColorLabel: "Colour of the copies",
    blockColorNone: "No colour",
    blockCategoryLabel: "Outlook category of the copies",
    blockCategoryPlaceholder: "Category",
    blockCategoryHint:
      "Outlook shows a colour if a category with this name exists. Create it in Outlook first.",
    bufferLabel: "Buffer",
    bufferNone: "No buffer",
    bufferSummary: (before: number, after: number) =>
      before === after
        ? `${before} min. before and after`
        : [before > 0 ? `${before} min. before` : "", after > 0 ? `${after} min. after` : ""]
            .filter(Boolean)
            .join(", "),
    bufferMixed: "differs",
    bufferMixedHint:
      "The targets of this calendar have different buffers. A save sets one for all.",
    change: "change",
    bufferBefore: "min. before",
    bufferAfter: "min. after",
    bufferHint: "All-day events get no buffer.",
    blockCategoryComma:
      "A category name cannot contain a comma: Outlook reads the comma as the start of a second category. Nothing was saved.",
    blockCategoryTooLong: (max: number) =>
      `A category name can have at most ${max} characters. Nothing was saved.`,
    blockColorInvalid: "This colour does not fit the calendar. Reload the page. Nothing was saved.",
    choiceInvalid: "This choice is not available. Reload the page. Nothing was saved.",
    bufferInvalid: (max: number) =>
      `A buffer is a whole number of minutes from 0 to ${max}. Nothing was saved.`,
    reconnectTitle: (email: string, provider: string) =>
      `The ${provider} account ${email} is no longer connected.`,
    reconnectText: "Its calendars do not sync until you reconnect it.",
    reconnect: (email: string) => `Reconnect ${email}`,
    reconnectShort: "Reconnect",
    calendarsLabel: "Calendars",
    mainCalendar: "Main calendar",
    noSource: "No calendar chosen. Turn on at least one.",
    skipAllDayTitle: "Skip all-day events",
    skipAllDayHint: "Otherwise holidays and days off block whole days.",
    skipTentativeTitle: "Skip tentative events",
    skipTentativeHint: "“Maybe” answers and tentative events do not block.",
    markPrivateTitle: "Mark copies as private",
    markPrivateHint: "Others see “Private” instead of the title. You see everything.",
    days: (days: number) => `${days} days`,
    cellChanged: "changed",
    checking: "Checking…",
    checkFailed: "The check failed. Try again later.",
    checkStale: "This direction changed in the meantime. Reload the page.",
    checkNoTokens: "This account is no longer signed in. Connect it again on the accounts page.",
    checkResult: (create: number, update: number, remove: number, unchanged: number) =>
      create + update + remove === 0
        ? `Matches the calendar · ${unchanged === 1 ? "1 block" : `${unchanged} blocks`}`
        : `Next sync: ${create} new, ${update} changed, ${remove} removed`,
    othersTitle: "Other rules",
    othersLead:
      "Rules between calendars other than the main ones. The editor above does not change them.",
    statusFailed: (time: string, code: string) => `Sync failed ${time} · ${code}`,
  },
  privacy: {
    title: "Privacy",
    operator: (name: string, contact: string) =>
      `This deployment of slotmirror is operated by ${name}. Contact: ${contact}.`,
    operatorUnknown: "The operator of this deployment has not set a contact address.",
    intro:
      "slotmirror mirrors busy times between calendars. It is open-source software that each operator runs in their own Cloudflare account.",
    storedTitle: "What is stored",
    stored: [
      "Your email address and, for Microsoft accounts, the tenant ID, to identify you and your connected accounts.",
      "OAuth tokens for each connected account, encrypted with AES-256-GCM.",
      "The names of your calendars and the rules you create.",
      "An activity log with times, counts and error codes, without event content. It is deleted after 90 days.",
      "A session cookie and a language cookie in your browser.",
      "For each free/busy feed you create: its calendars, its settings and a hash of its secret address. Whoever has the address sees your busy times, without content. The last rendered feed, busy times only, is kept with the feed and in Cloudflare's cache to answer the next fetches.",
    ],
    notStoredTitle: "What is not stored",
    notStored:
      "Event titles, descriptions, locations and attendees are read during a sync and not stored. Blocks in a target calendar contain only what the rule's detail level allows; the default is Busy.",
    whereTitle: "Where data is processed",
    where:
      "On Cloudflare Workers, D1 and Durable Objects in the operator's Cloudflare account, and at Microsoft and Google when calendars are read and written.",
    deleteTitle: "How to delete your data",
    delete:
      "Disconnecting an account deletes the blocks slotmirror wrote for it, then its tokens. To delete your user and all its data, use “Delete my data” in the account menu.",
    googleTitle: "Google user data",
    google:
      "slotmirror's use and transfer of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements. Data is used only to show and mirror busy times as configured by you, and is never sold, used for advertising or read by humans.",
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
    deleteUser: "Delete",
    inactive: "deactivated",
    needsReconnect: (count: number) =>
      count === 1 ? "1 needs reconnecting" : `${count} need reconnecting`,
    reconnectSummary: (count: number) =>
      count === 1
        ? "1 user has an account that needs reconnecting. Its calendars do not sync until that user reconnects it on the Accounts page."
        : `${count} users have accounts that need reconnecting. Their calendars do not sync until each user reconnects them on the Accounts page.`,
    capsTitle: "Privacy limits",
    capsLead:
      "How much of an event may move between work calendars and private calendars. This applies to everyone on this deployment, also if someone sets more in their own sync settings.",
    orgAccounts: (list: string) =>
      `Work calendars are accounts at ${list}. Every other account counts as private.`,
    orgNone:
      "No work domain or Entra tenant is set (ALLOWED_DOMAINS, ALLOWED_TENANT_IDS), so there are no limits.",
    tenants: (count: number) => (count === 1 ? "1 Entra tenant" : `${count} Entra tenants`),
    capToExternal: "Work events in private calendars",
    capFromExternal: "Private events in work calendars",
    capNone: "No limit",
    capAtMost: (level: string) => `At most “${level}”`,
    capsHow:
      "Change with the Worker variables MAX_DETAIL_TO_EXTERNAL and MAX_DETAIL_FROM_EXTERNAL.",
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
      account_renamed: "Account renamed",
      token_refresh_failed: "Token refresh failed",
      rule_created: "Rule created",
      rule_deleted: "Rule deleted",
      rule_enabled: "Rule turned on",
      rule_paused: "Rule paused",
      rule_updated: "Rule changed",
      group_changed: "Block group changed",
      settings_changed: "Sync settings changed",
      user_provisioned: "User provisioned",
      user_deactivated: "User deactivated",
      user_reactivated: "User reactivated",
      user_deleted: "User deleted",
      sync_run: "Sync run",
      sync_failed: "Sync failed",
      feed_created: "Free/busy feed created",
      feed_rotated: "Free/busy feed address renewed",
      feed_deleted: "Free/busy feed deleted",
    },
    changes: (create: number, update: number, remove: number) =>
      `+${create} / ~${update} / −${remove}`,
    preview: (changes: string) => `Preview ${changes}`,
    failedCount: (count: number) => `${count} failed`,
    throttledCount: (count: number) => `${count} throttled, retried after the wait`,
    statuses: (list: string) => `HTTP ${list}`,
    remainingCount: (count: number) => `${count} left`,
  },
  feeds: {
    title: "Free/busy feed",
    lead: "A secret calendar address for people outside this deployment. It shows when you are busy, never what you do.",
    empty: "No feed yet.",
    noCalendars:
      "Your calendars are listed here once you open the sync settings after connecting an account.",
    feedTitle: (date: string) => `Feed from ${date}`,
    renewedOn: (date: string) => `new address ${date}`,
    daysAhead: (count: number) => `${count} days ahead`,
    withAllDay: "with all-day events",
    cut: (date: string) =>
      `Too many busy times: the feed ends before ${date}. Choose fewer days or calendars.`,
    calendarUnreadable: (name: string) =>
      `“${name}” cannot be read any more, so subscribers get no update. Remove it from the feed.`,
    removeCalendar: "Remove calendar",
    create: "New feed",
    calendarsLabel: (max: number) => `Calendars, at most ${max}`,
    daysLabel: "Days ahead",
    allDayLabel: "Include all-day events",
    shares:
      "Subscribers see when you are busy, from 7 days ago on: blocks titled “Busy”, marked private, where overlapping events form one block. Titles, places, notes and attendees stay out, and so do free and declined events. Only calendars your accounts own can be chosen.",
    submit: "Create feed",
    rotate: "New address",
    rotateText:
      "The current address stops working at once. Everyone who subscribed needs the new one.",
    rotateConfirm: "Make a new address",
    remove: "Delete",
    removeText: "The address stops working at once. Subscribers no longer see your busy times.",
    removeConfirm: "Delete feed",
    urlTitle: "Your feed address",
    urlLead: "Copy the address now. It is shown only once; slotmirror keeps only a hash of it.",
    urlHint:
      "Anyone with this address sees your busy times. Share it only with people who should. They subscribe to it by URL in their calendar app. A change shows within about 15 minutes, plus the refresh interval of their app.",
    copy: "Copy",
    copied: "Copied",
    back: "Back to the accounts",
    errorTitle: "Feed not created",
    noCalendar: "Choose at least one calendar.",
    tooManyCalendars: (max: number) => `Choose at most ${max} calendars.`,
    tooManyFeeds: (max: number) => `You already have ${max} feeds. Delete one first.`,
    calendarName: "Busy times",
    eventTitle: "Busy",
  },
  setup: {
    title: "Finish the setup",
    lead: "Set the missing values as variables or secrets in the Cloudflare dashboard (your Worker, Settings, Variables and Secrets), then reload this page.",
    set: "Set",
    accessHint:
      "Who may sign in. Your own address for a personal deployment, your email domain for a team.",
    sessionHint: "At least 32 characters. Generate with: openssl rand -base64 48",
    keyHint: "A base64-encoded 32-byte key. Generate with: openssl rand -base64 32",
    providerHint:
      "At least one provider that SIGN_IN_PROVIDERS allows for sign-in. See the README for the app registration steps.",
  },
  deleteUser: {
    titleSelf: "Delete my data",
    titleOther: (email: string) => `Delete ${email}`,
    intro: "This removes:",
    accounts: (count: number) =>
      count === 1
        ? "1 connected account, with its tokens"
        : `${count} connected accounts, with their tokens`,
    rules: "All sync settings and rules",
    blocks: "The blocks they wrote, from today on. Past blocks stay in the calendars.",
    userRow: "The user itself",
    activityStays:
      "Activity entries stay until the retention period ends, without event contents. This cannot be undone.",
    confirmSelf: "Delete my data",
    confirmOther: "Delete user",
    cancel: "Cancel",
    doneTitle: "Your data is deleted",
    doneText: "The blocks disappear from your calendars within a few minutes.",
  },
  messages: {
    back: "Back to the start page",
    notAllowed: "Not allowed",
    notAvailable: "Not available yet",
    errorTitle: "Something went wrong",
    errorText: "The request failed. Try again in a moment.",
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
    signInProviderOff: (provider: string) =>
      `This deployment does not offer sign-in with ${provider}. You can still connect ${provider} accounts after signing in.`,
    alreadyConnected: "Already connected",
    alreadyConnectedText: (email: string) =>
      `${email} is already connected by another user of this deployment.`,
  },
  /** Text that the sync writes into mirrored blocks, in the language of the rule's owner. */
  mirror: {
    origin: (account: string, provider: string) => `From: ${account} (${provider})`,
    /** For an account without a name: the provider only, never the address. */
    originAccount: (provider: string) => `From: ${provider} account`,
    microsoft: "Microsoft",
    google: "Google",
  },
  /** Texts for ALERT_WEBHOOK_URL. They go to the operator, in the first locale. */
  alerts: {
    reconnect: (provider: string, url: string) =>
      `slotmirror: a ${provider} account needs reconnecting. Its calendars do not sync until its user reconnects it. The admin page lists the affected users.${url ? ` ${url}` : ""}`,
  },
};

export type Messages = typeof en;
