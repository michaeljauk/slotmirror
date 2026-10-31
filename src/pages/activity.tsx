import { AUDIT_RETENTION_DAYS, parseDetail, type ActivityRow, type CleanupDetail } from "../audit";
import { useI18n, type Messages } from "../i18n";
import { tally, type CompareFailedDetail, type CompareRunDetail } from "../sync/compare";
import type { CurrentUser } from "../users";
import { Layout } from "./layout";

/** "429:13,400:2" as "429 ×13, 400 ×2". */
function formatStatusList(statuses: string): string {
  return statuses
    .split(",")
    .map((pair) => pair.replace(":", " ×"))
    .join(", ");
}

/** The outcome of a comparison: counts or the reason of its failure. Hashes stay in the log. */
export function describeCompare(row: ActivityRow, t: Messages): string {
  const detail = parseDetail(row.detail) as Partial<CompareRunDetail & CompareFailedDetail>;
  if (row.kind === "compare_failed") {
    const reason = detail.reason ? t.activity.compareReasons[detail.reason] : "";
    return detail.code ? `${reason} (${detail.code})` : reason;
  }
  const parts: string[] = [];
  if (detail.deviations) {
    parts.push(
      t.activity.compareFound(
        detail.missing ?? 0,
        detail.surplus ?? 0,
        detail.mismatched ?? 0,
        detail.duplicates ?? 0,
      ),
    );
  } else if (detail.clean) {
    parts.push(t.activity.compareClean(detail.expected ?? 0));
  }
  if (detail.cleared) {
    const found = tally(detail.clearedHits?.split(",") ?? []);
    parts.push(
      t.activity.compareCleared(
        detail.cleared,
        t.activity.compareFound(found.missing, found.surplus, found.mismatched, found.duplicates),
      ),
    );
  }
  if (detail.unconfirmed) parts.push(t.activity.compareUnconfirmed(detail.unconfirmed));
  if (detail.hitsCapped) parts.push(t.activity.compareCapped);
  if (parts.length > 0) return parts.join(", ");
  return detail.mode === "leftover" ? t.activity.compareNoLeftovers : t.activity.compareNothing;
}

/** The outcome of an offboarding's removal: what went, what stayed, and why. */
function describeCleanup(row: ActivityRow, t: Messages): string {
  const { result, removed, left } = parseDetail(row.detail) as Partial<CleanupDetail>;
  const parts = [t.activity.cleanupRemoved(removed ?? 0)];
  if (left) parts.push(t.activity.cleanupLeft(left));
  if (result && result !== "removed") parts.push(t.activity.cleanupReasons[result]);
  return parts.join(", ");
}

/** A short, content-free description of an event: counts and codes from its detail. */
function describe(row: ActivityRow, t: Messages): string {
  const detail = parseDetail(row.detail);
  if (row.kind === "sync_run") {
    const changes = t.activity.changes(detail.create ?? 0, detail.update ?? 0, detail.delete ?? 0);
    if (detail.dryRun) return t.activity.preview(changes);
    const parts = [changes];
    if (detail.failed) parts.push(t.activity.failedCount(detail.failed));
    if (detail.throttled) parts.push(t.activity.throttledCount(detail.throttled));
    if (detail.remaining) parts.push(t.activity.remainingCount(detail.remaining));
    if (detail.statuses) parts.push(t.activity.statuses(formatStatusList(detail.statuses)));
    return parts.join(", ");
  }
  if (row.kind === "sync_run_aborted") return t.activity.abortedDetail;
  if (row.kind === "account_paused") return t.activity.pausedDetail(detail.code ?? "");
  if (row.kind === "account_resumed") return t.activity.resumedDetail;
  if (row.kind === "alert_sent") {
    const details: Record<string, string> = t.activity.alertDetails;
    return details[detail.code ?? ""] ?? detail.code ?? "";
  }
  if (row.kind === "compare_run" || row.kind === "compare_failed") return describeCompare(row, t);
  if (row.kind === "cleanup_finished") return describeCleanup(row, t);
  if (row.kind === "account_disconnect_failed") return t.activity.disconnectFailedDetail;
  return detail.code ?? "";
}

/** Rows in order of their first appearance, with rows that read the same joined into one. */
function joinRepeats<T>(rows: T[], key: (row: T) => string): { row: T; count: number }[] {
  const joined = new Map<string, { row: T; count: number }>();
  for (const row of rows) {
    const known = joined.get(key(row));
    if (known) known.count++;
    else joined.set(key(row), { row, count: 1 });
  }
  return [...joined.values()];
}

/**
 * Events with time, translated kind and short details. The org view adds the user column, the view
 * of a user the account column. A sync of several rules writes rows that read the same in the
 * same minute, and these join.
 */
export function ActivityTable(props: {
  rows: ActivityRow[];
  showUser?: boolean;
  showAccount?: boolean;
}) {
  const { t, formatTimestamp } = useI18n();
  if (props.rows.length === 0) {
    return <div class="empty">{t.activity.empty}</div>;
  }
  const rows = joinRepeats(props.rows, (row) =>
    [formatTimestamp(row.createdAt), row.kind, row.email, row.accountEmail, describe(row, t)].join(
      "|",
    ),
  );
  return (
    <table class="table stack">
      <thead>
        <tr>
          <th>{t.activity.time}</th>
          {props.showUser ? <th>{t.admin.email}</th> : null}
          {props.showAccount ? <th>{t.activity.account}</th> : null}
          <th>{t.activity.event}</th>
          <th>{t.activity.details}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ row, count }) => (
          <tr>
            <td class="muted" data-label={t.activity.time}>
              {formatTimestamp(row.createdAt)}
            </td>
            {props.showUser ? <td data-label={t.admin.email}>{row.email ?? "–"}</td> : null}
            {props.showAccount ? (
              <td data-label={t.activity.account}>{row.accountEmail ?? "–"}</td>
            ) : null}
            <td data-label={t.activity.event}>
              <span>
                {t.activity.kinds[row.kind] ?? row.kind}
                {count > 1 ? <span class="badge repeat">{`× ${count}`}</span> : null}
              </span>
            </td>
            <td class="muted" data-label={t.activity.details}>
              {describe(row, t)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ActivityPage(props: { user: CurrentUser; rows: ActivityRow[] }) {
  const { t } = useI18n();
  return (
    <Layout title={t.activity.title} user={props.user} active="activity">
      <section class="section">
        <div class="section-head">
          <div>
            <h1>{t.activity.title}</h1>
            <p class="lead">{t.activity.lead}</p>
          </div>
        </div>
        <div class="card">
          <ActivityTable rows={props.rows} showAccount />
        </div>
        <p class="fineprint">{t.activity.retention(AUDIT_RETENTION_DAYS)}</p>
      </section>
    </Layout>
  );
}

/** The full log of the org, behind the excerpt on the admin page. */
export function OrgActivityPage(props: { user: CurrentUser; rows: ActivityRow[] }) {
  const { t } = useI18n();
  return (
    <Layout title={t.activity.title} user={props.user} active="admin">
      <section class="section">
        <div class="section-head">
          <div>
            <h1>{t.activity.title}</h1>
            <p class="lead">{t.activity.orgLead}</p>
          </div>
          <a class="button" href="/admin">
            {t.nav.admin}
          </a>
        </div>
        <div class="card">
          <ActivityTable rows={props.rows} showUser />
        </div>
        <p class="fineprint">{t.activity.retention(AUDIT_RETENTION_DAYS)}</p>
      </section>
    </Layout>
  );
}
