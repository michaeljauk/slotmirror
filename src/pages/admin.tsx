import type { Role } from "../access";
import type { TestAlertOutcome } from "../alerts";
import { parseDetail, type ActivityRow } from "../audit";
import type { DetailCaps } from "../detail-policy";
import { useI18n } from "../i18n";
import type { CompareRunDetail } from "../sync/compare";
import type { CurrentUser } from "../users";
import { ActivityTable, describeCompare } from "./activity";
import { Layout } from "./layout";

/** Rows of the log on the admin page; `/admin/activity` shows all of them. */
const ADMIN_ACTIVITY_ROWS = 10;

export interface AdminUserRow {
  id: string;
  email: string;
  /** 0 if Entra deactivated the user over SCIM. */
  active: number;
  role: Role;
  lastSignInAt: string | null;
  accounts: number;
  /** Accounts of the user whose refresh token the provider refused. */
  needsReconnect: number;
}

/** Users of the admin's org with their number of connected accounts. No calendar data. */
export function AdminPage(props: {
  user: CurrentUser;
  users: AdminUserRow[];
  activity: ActivityRow[];
  /** The latest comparison per calendar and mode. */
  compares: ActivityRow[];
  /** The admin just started comparisons. */
  /** What the last click on "Start comparison" did, if the page follows one. */
  compareStart: { started: number; open: number; failed: number } | null;
  /** True if a webhook is set. Its URL is a secret and never reaches this page. */
  alertsConfigured: boolean;
  /** What the last click on "Send test alert" did, if the page follows one. */
  testAlert: TestAlertOutcome | null;
  caps: DetailCaps;
  /** Domains and Entra tenants whose accounts count as work calendars. */
  org: { domains: string[]; tenantCount: number };
}) {
  const { t, formatTimestamp } = useI18n();
  const orgList = [
    ...props.org.domains.map((domain) => `@${domain}`),
    ...(props.org.tenantCount > 0 ? [t.admin.tenants(props.org.tenantCount)] : []),
  ];
  const affected = props.users.filter((row) => row.needsReconnect > 0).length;
  const capText = (level: DetailCaps["toExternal"]) =>
    level === "full" ? t.admin.capNone : t.admin.capAtMost(t.rules.detailLevels[level]);
  return (
    <Layout title={t.admin.title} user={props.user} active="admin">
      <section class="section">
        <div class="section-head">
          <div>
            <h1>{t.admin.title}</h1>
            <p class="lead">{t.admin.lead}</p>
          </div>
        </div>
        {affected > 0 ? (
          <div class="reconnect-notice" role="status">
            <p>
              <span>{t.admin.reconnectSummary(affected)}</span>
            </p>
          </div>
        ) : null}
        <div class="card">
          <table class="table stack">
            <thead>
              <tr>
                <th>{t.admin.email}</th>
                <th>{t.admin.role}</th>
                <th>{t.admin.accounts}</th>
                <th>{t.admin.lastSignIn}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {props.users.map((row) => (
                <tr>
                  <td data-label={t.admin.email}>{row.email}</td>
                  <td data-label={t.admin.role}>
                    <span>
                      <span class={row.role === "admin" ? "badge admin" : "badge"}>
                        {t.roles[row.role]}
                      </span>
                      {row.active === 0 ? <span class="badge">{t.admin.inactive}</span> : null}
                    </span>
                  </td>
                  <td data-label={t.admin.accounts}>
                    <span>
                      {row.accounts}
                      {row.needsReconnect > 0 ? (
                        <span class="badge error">
                          {t.admin.needsReconnect(row.needsReconnect)}
                        </span>
                      ) : null}
                    </span>
                  </td>
                  <td class="muted" data-label={t.admin.lastSignIn}>
                    {row.lastSignInAt ? formatTimestamp(row.lastSignInAt) : t.admin.never}
                  </td>
                  <td>
                    {row.id === props.user.id ? null : (
                      <>
                        <form
                          method="post"
                          action={`/admin/users/${row.id}/reset-sign-in`}
                          class="inline-form"
                        >
                          <button
                            type="submit"
                            class="link-button quiet"
                            title={t.admin.resetSignInHint}
                          >
                            {t.admin.resetSignIn}
                          </button>
                        </form>
                        <a class="link-button quiet" href={`/admin/users/${row.id}/delete`}>
                          {t.admin.deleteUser}
                        </a>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section class="section">
        <div class="section-head">
          <div>
            <h2>{t.admin.capsTitle}</h2>
            <p class="lead">{t.admin.capsLead}</p>
          </div>
        </div>
        <div class="card">
          <p class="caps-org">
            {orgList.length > 0 ? t.admin.orgAccounts(orgList.join(", ")) : t.admin.orgNone}
          </p>
          <table class="table">
            <tbody>
              <tr>
                <td>{t.admin.capToExternal}</td>
                <td>{capText(props.caps.toExternal)}</td>
              </tr>
              <tr>
                <td>{t.admin.capFromExternal}</td>
                <td>{capText(props.caps.fromExternal)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="fineprint caps-how">{t.admin.capsHow}</p>
      </section>

      <section class="section">
        <div class="section-head">
          <div>
            <h2>{t.admin.compareTitle}</h2>
            <p class="lead">{t.admin.compareLead}</p>
          </div>
          <form method="post" action="/admin/compare" class="inline-form">
            <button type="submit" class="button">
              {t.admin.compareStart}
            </button>
          </form>
        </div>
        {props.compareStart ? (
          <p class="notice">
            {t.admin.compareCounts(
              props.compareStart.started,
              props.compareStart.open,
              props.compareStart.failed,
            )}
          </p>
        ) : null}
        <div class="card">
          {props.compares.length === 0 ? (
            <div class="empty">{t.admin.compareEmpty}</div>
          ) : (
            <ul class="compare-list">
              {props.compares.map((row) => {
                const { calendarId, mode } = parseDetail(row.detail) as Partial<CompareRunDetail>;
                return (
                  <li data-compare={`${calendarId}:${mode}`}>
                    <span>{describeCompare(row, t)}</span>
                    <span class="muted">
                      {mode ? t.admin.compareModes[mode] : ""} · {row.email ?? "–"} ·{" "}
                      {formatTimestamp(row.createdAt)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <p class="fineprint caps-how">{t.admin.compareHorizon}</p>
      </section>

      <section class="section">
        <div class="section-head">
          <div>
            <h2>{t.admin.alertsTitle}</h2>
            <p class="lead">{props.alertsConfigured ? t.admin.alertsLead : t.admin.alertsOff}</p>
          </div>
          {props.alertsConfigured ? (
            <form method="post" action="/admin/test-alert" class="inline-form">
              <button type="submit" class="button">
                {t.admin.testAlertSend}
              </button>
            </form>
          ) : null}
        </div>
        {props.testAlert ? (
          <p class="notice test-alert-result" role="status">
            {t.admin.testAlertResults[props.testAlert]}
          </p>
        ) : null}
      </section>

      <section class="section">
        <div class="section-head">
          <div>
            <h2>{t.activity.title}</h2>
            <p class="lead">{t.admin.activityLead(ADMIN_ACTIVITY_ROWS)}</p>
          </div>
          <a class="button" href="/admin/activity">
            {t.admin.activityAll}
          </a>
        </div>
        <div class="card">
          <ActivityTable rows={props.activity.slice(0, ADMIN_ACTIVITY_ROWS)} showUser />
        </div>
      </section>
    </Layout>
  );
}
