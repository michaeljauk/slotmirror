import type { CalendarCleanup, Cleanups } from "../cleanup";
import { useI18n } from "../i18n";
import type { CurrentUser } from "../users";
import { Layout } from "./layout";

function CalendarTitle(props: { calendar: CalendarCleanup }) {
  const { t } = useI18n();
  return (
    <>
      <div class="item-title">{props.calendar.name ?? t.cleanup.unnamedCalendar}</div>
      {props.calendar.account ? <div class="item-meta">{props.calendar.account}</div> : null}
    </>
  );
}

/** What a user deletes by hand: the count, the period and the marker of each calendar. */
function CalendarList(props: { calendars: CalendarCleanup[] }) {
  const { t, formatDate } = useI18n();
  return (
    <ul class="list">
      {props.calendars.map((calendar) => (
        <li>
          <div class="item-main">
            <CalendarTitle calendar={calendar} />
            <div class="item-meta">
              {calendar.blocks === null
                ? t.cleanup.unknownCount
                : calendar.estimated
                  ? t.cleanup.aboutCount(calendar.blocks)
                  : t.cleanup.count(calendar.blocks)}
            </div>
            {calendar.windowStart && calendar.windowEnd ? (
              <div class="item-meta">
                {t.cleanup.period(formatDate(calendar.windowStart), formatDate(calendar.windowEnd))}
              </div>
            ) : null}
            {calendar.markers.map(({ ruleTag, blockTitle }) => (
              <div class="item-meta">
                {blockTitle === null
                  ? t.cleanup.markerOnly(ruleTag)
                  : t.cleanup.marker(ruleTag, blockTitle)}
              </div>
            ))}
            {calendar.reasons.map((reason) => (
              <div class="item-meta">{t.cleanup.reasons[reason]}</div>
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Removals that still run. Nothing here asks the user to act, so no marker and no count. */
function RunningList(props: { calendars: CalendarCleanup[] }) {
  const { t, formatDate } = useI18n();
  // A throttled job on an account that works has no deadline, and can pass this date.
  const upcoming = (date: string | null) => date !== null && Date.parse(date) > Date.now();
  return (
    <ul class="list">
      {props.calendars.map((calendar) => (
        <li>
          <div class="item-main">
            <CalendarTitle calendar={calendar} />
            {calendar.waitsUntil && upcoming(calendar.waitsUntil) ? (
              <div class="item-meta">{t.cleanup.running(formatDate(calendar.waitsUntil))}</div>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * The blocks that an offboarding could not remove, per target calendar. The page names the calendar,
 * the count, the marker and the period. It knows no event content. A removal that still runs stands
 * apart: it is no rest, and asks nothing of the user.
 */
export function CleanupPage(props: {
  user: CurrentUser;
  own: Cleanups;
  /** Deactivated and deleted users, for an admin. */
  others: Cleanups;
}) {
  const { t } = useI18n();
  const running = [...props.own.running, ...props.others.running];
  const left = props.own.left.length > 0 || props.others.left.length > 0;
  const empty = !left && running.length === 0;
  const runningOnly = !left && running.length > 0;
  return (
    <Layout title={runningOnly ? t.cleanup.runningTitle : t.cleanup.title} user={props.user}>
      <section class="section">
        <div class="section-head">
          <div>
            <h1>{runningOnly ? t.cleanup.runningTitle : t.cleanup.title}</h1>
            {left ? <p class="lead">{t.cleanup.lead}</p> : null}
            {left ? <p class="lead">{t.cleanup.reconnectDoesNotHelp}</p> : null}
            {runningOnly ? <p class="lead">{t.cleanup.runningLead}</p> : null}
          </div>
        </div>
        {empty ? (
          <div class="card">
            <div class="empty">{t.cleanup.empty}</div>
          </div>
        ) : null}
        {props.own.left.length > 0 ? (
          <div class="card">
            <CalendarList calendars={props.own.left} />
          </div>
        ) : null}
        {runningOnly ? (
          <div class="card">
            <RunningList calendars={running} />
          </div>
        ) : null}
      </section>
      {props.others.left.length > 0 ? (
        <section class="section">
          <div class="section-head">
            <div>
              <h2>{t.cleanup.othersTitle}</h2>
              <p class="lead">{t.cleanup.othersLead}</p>
            </div>
          </div>
          <div class="card">
            <CalendarList calendars={props.others.left} />
          </div>
        </section>
      ) : null}
      {left && running.length > 0 ? (
        <section class="section">
          <div class="section-head">
            <div>
              <h2>{t.cleanup.runningTitle}</h2>
              <p class="lead">{t.cleanup.runningLead}</p>
            </div>
          </div>
          <div class="card">
            <RunningList calendars={running} />
          </div>
        </section>
      ) : null}
      {left ? <p class="fineprint">{t.cleanup.markerHelp}</p> : null}
    </Layout>
  );
}
