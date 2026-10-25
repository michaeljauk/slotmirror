import type { RuleOutcome } from "../audit";
import type { CalendarRow } from "../calendars";
import type { RuleOptions } from "../config";
import { useI18n } from "../i18n";
import type { CurrentUser } from "../users";
import { Layout } from "./layout";

export interface RuleRow {
  id: string;
  enabled: boolean;
  sourceCalendarId: string;
  targetCalendarId: string;
  options: RuleOptions;
}

export type Notice = { kind: "info" | "error"; text: string };

const DETAIL_LEVELS = ["busy", "title", "title_location", "full"] as const;
const DAYS_AHEAD = [30, 90, 180, 365] as const;

function calendarLabel(calendar: CalendarRow | undefined): string {
  return calendar ? `${calendar.accountEmail} · ${calendar.name}` : "?";
}

export function RulesPage(props: {
  user: CurrentUser;
  calendars: CalendarRow[];
  rules: RuleRow[];
  /** Rules whose detail level an org cap lowers, with the level they run with. */
  capped: Map<string, RuleOptions["detailLevel"]>;
  /** Latest finished run or failure per rule ID. */
  outcomes: Map<string, RuleOutcome>;
  notice?: Notice;
}) {
  const { t, formatTimestamp } = useI18n();
  const byId = new Map(props.calendars.map((calendar) => [calendar.id, calendar]));
  const writable = props.calendars.filter((calendar) => calendar.canEdit);

  function lastRun(outcome: RuleOutcome | undefined) {
    if (!outcome) return null;
    const time = formatTimestamp(outcome.createdAt);
    if (outcome.kind === "sync_failed") {
      return <div class="item-meta">{t.rules.lastRunFailed(time, outcome.detail.code ?? "")}</div>;
    }
    const { create = 0, update = 0, unchanged = 0, applied = 0 } = outcome.detail;
    return (
      <div class="item-meta">{t.rules.lastRun(create + update + unchanged, time, applied)}</div>
    );
  }

  return (
    <Layout title={t.rules.title} user={props.user} active="rules">
      <section class="section">
        <div class="section-head">
          <div>
            <h1>{t.rules.title}</h1>
            <p class="lead">{t.rules.lead}</p>
          </div>
        </div>

        {props.notice ? <p class={`notice ${props.notice.kind}`}>{props.notice.text}</p> : null}

        <div class="card">
          {props.rules.length === 0 ? (
            <div class="empty">
              <strong>{t.rules.emptyTitle}</strong>
              {t.rules.emptyText}
            </div>
          ) : (
            <ul class="list">
              {props.rules.map((rule) => (
                <li>
                  <div class="item-main">
                    <div class="item-title">
                      {`${calendarLabel(byId.get(rule.sourceCalendarId))} → ${calendarLabel(byId.get(rule.targetCalendarId))}`}
                    </div>
                    <div class="item-meta">
                      {`${t.rules.detailLevels[rule.options.detailLevel]} · ${t.rules.days(rule.options.daysAhead)}`}
                      {rule.options.markPrivate ? ` · ${t.rules.markPrivate}` : ""}
                    </div>
                    {props.capped.has(rule.id) ? (
                      <div class="item-meta">
                        {t.rules.capped(t.rules.detailLevels[props.capped.get(rule.id) ?? "busy"])}
                      </div>
                    ) : null}
                    {rule.enabled ? (
                      lastRun(props.outcomes.get(rule.id))
                    ) : (
                      <div class="item-meta paused">{t.rules.paused}</div>
                    )}
                  </div>
                  <form method="post" action={`/rules/${rule.id}/preview`}>
                    <button type="submit" class="button small">
                      {t.rules.preview}
                    </button>
                  </form>
                  {rule.enabled ? (
                    <form method="post" action={`/rules/${rule.id}/run`}>
                      <button type="submit" class="button small primary">
                        {t.rules.runNow}
                      </button>
                    </form>
                  ) : null}
                  <form
                    method="post"
                    action={`/rules/${rule.id}/${rule.enabled ? "pause" : "enable"}`}
                  >
                    <button
                      type="submit"
                      class={rule.enabled ? "button small" : "button small primary"}
                    >
                      {rule.enabled ? t.rules.pause : t.rules.enable}
                    </button>
                  </form>
                  <form method="post" action={`/rules/${rule.id}/delete`}>
                    <button type="submit" class="link-button danger">
                      {t.rules.delete}
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section class="section">
        <div class="section-head">
          <div>
            <h2>{t.rules.newRule}</h2>
            <p class="lead">{`${t.rules.privateNote} ${t.rules.newRulesPaused}`}</p>
          </div>
          <form method="post" action="/rules/calendars/refresh">
            <button type="submit" class="link-button">
              {t.rules.refreshCalendars}
            </button>
          </form>
        </div>

        {props.calendars.length === 0 ? (
          <div class="card">
            <div class="empty">{t.rules.noCalendars}</div>
          </div>
        ) : (
          <form method="post" action="/rules" class="card form">
            <label>
              <span>{t.rules.from}</span>
              <select name="source" required>
                <option value="" selected disabled>
                  {t.rules.choose}
                </option>
                {props.calendars.map((calendar) => (
                  <option value={calendar.id}>{calendarLabel(calendar)}</option>
                ))}
              </select>
            </label>
            <label>
              <span>{t.rules.to}</span>
              <select name="target" required>
                <option value="" selected disabled>
                  {t.rules.choose}
                </option>
                {writable.map((calendar) => (
                  <option value={calendar.id}>{calendarLabel(calendar)}</option>
                ))}
              </select>
            </label>
            <label>
              <span>{t.rules.detail}</span>
              <select name="detailLevel">
                {DETAIL_LEVELS.map((level) => (
                  <option value={level}>{t.rules.detailLevels[level]}</option>
                ))}
              </select>
            </label>
            <label>
              <span>{t.rules.daysAhead}</span>
              <select name="daysAhead">
                {DAYS_AHEAD.map((days) => (
                  <option value={String(days)} selected={days === 90}>
                    {t.rules.days(days)}
                  </option>
                ))}
              </select>
            </label>
            <label class="check-row">
              <input type="checkbox" name="markPrivate" checked />
              <span>{t.rules.markPrivate}</span>
            </label>
            <label class="check-row">
              <input type="checkbox" name="skipAllDay" checked />
              <span>{t.rules.skipAllDay}</span>
            </label>
            <label class="check-row">
              <input type="checkbox" name="skipTentative" />
              <span>{t.rules.skipTentative}</span>
            </label>
            <div class="actions">
              <button type="submit" class="button primary">
                {t.rules.create}
              </button>
            </div>
          </form>
        )}
      </section>
    </Layout>
  );
}
