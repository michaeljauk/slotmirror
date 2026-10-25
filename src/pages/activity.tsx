import { AUDIT_RETENTION_DAYS, parseDetail, type ActivityRow } from "../audit";
import { useI18n, type Messages } from "../i18n";
import type { CurrentUser } from "../users";
import { Layout } from "./layout";

/** A short, content-free description of an event: counts and codes from its detail. */
function describe(row: ActivityRow, t: Messages): string {
  const detail = parseDetail(row.detail);
  if (row.kind === "sync_run") {
    const changes = t.activity.changes(detail.create ?? 0, detail.update ?? 0, detail.delete ?? 0);
    if (detail.dryRun) return t.activity.preview(changes);
    const parts = [changes];
    if (detail.failed) parts.push(t.activity.failedCount(detail.failed));
    if (detail.remaining) parts.push(t.activity.remainingCount(detail.remaining));
    return parts.join(", ");
  }
  return detail.code ?? "";
}

/** Events with time, translated kind and short details. The org view adds the user column. */
export function ActivityTable(props: { rows: ActivityRow[]; showUser?: boolean }) {
  const { t, formatTimestamp } = useI18n();
  if (props.rows.length === 0) {
    return <div class="empty">{t.activity.empty}</div>;
  }
  return (
    <table class="table">
      <thead>
        <tr>
          <th>{t.activity.time}</th>
          {props.showUser ? <th>{t.admin.email}</th> : null}
          <th>{t.activity.event}</th>
          <th>{t.activity.details}</th>
        </tr>
      </thead>
      <tbody>
        {props.rows.map((row) => (
          <tr>
            <td class="muted">{formatTimestamp(row.createdAt)}</td>
            {props.showUser ? <td>{row.email ?? "–"}</td> : null}
            <td>{t.activity.kinds[row.kind] ?? row.kind}</td>
            <td class="muted">{describe(row, t)}</td>
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
          <ActivityTable rows={props.rows} />
        </div>
        <p class="fineprint">{t.activity.retention(AUDIT_RETENTION_DAYS)}</p>
      </section>
    </Layout>
  );
}
