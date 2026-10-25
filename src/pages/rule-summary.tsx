import type { RuleOutcome } from "../audit";
import type { CalendarRow } from "../calendars";
import { useI18n } from "../i18n";

export function calendarLabel(calendar: CalendarRow | undefined): string {
  return calendar ? `${calendar.accountEmail} · ${calendar.name}` : "?";
}

/** The last run of a rule with a relative time; the absolute time is in the tooltip. */
export function RuleLastRun(props: { outcome: RuleOutcome | undefined }) {
  const { t, formatTimestamp, formatRelative } = useI18n();
  const { outcome } = props;
  if (!outcome) return null;
  const time = formatRelative(outcome.createdAt);
  const title = formatTimestamp(outcome.createdAt);
  if (outcome.kind === "sync_failed") {
    return (
      <div class="item-meta error" title={title}>
        {t.rules.lastRunFailed(time, outcome.detail.code ?? "")}
      </div>
    );
  }
  const { create = 0, update = 0, unchanged = 0, applied = 0 } = outcome.detail;
  return (
    <div class="item-meta" title={title}>
      {t.rules.lastRun(create + update + unchanged, time, applied)}
    </div>
  );
}
