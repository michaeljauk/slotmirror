import type { Role } from "../access";
import type { ActivityRow } from "../audit";
import type { DetailCaps } from "../detail-policy";
import { useI18n } from "../i18n";
import type { CurrentUser } from "../users";
import { ActivityTable } from "./activity";
import { Layout } from "./layout";

export interface AdminUserRow {
  email: string;
  role: Role;
  lastSignInAt: string | null;
  accounts: number;
}

/** Users of the admin's org with their number of connected accounts. No calendar data. */
export function AdminPage(props: {
  user: CurrentUser;
  users: AdminUserRow[];
  activity: ActivityRow[];
  caps: DetailCaps;
  /** Domains and Entra tenants whose accounts count as work calendars. */
  org: { domains: string[]; tenantCount: number };
}) {
  const { t, formatTimestamp } = useI18n();
  const orgList = [
    ...props.org.domains.map((domain) => `@${domain}`),
    ...(props.org.tenantCount > 0 ? [t.admin.tenants(props.org.tenantCount)] : []),
  ];
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
        <div class="card">
          <table class="table">
            <thead>
              <tr>
                <th>{t.admin.email}</th>
                <th>{t.admin.role}</th>
                <th>{t.admin.accounts}</th>
                <th>{t.admin.lastSignIn}</th>
              </tr>
            </thead>
            <tbody>
              {props.users.map((row) => (
                <tr>
                  <td>{row.email}</td>
                  <td>
                    <span class={row.role === "admin" ? "badge admin" : "badge"}>
                      {t.roles[row.role]}
                    </span>
                  </td>
                  <td>{row.accounts}</td>
                  <td class="muted">
                    {row.lastSignInAt ? formatTimestamp(row.lastSignInAt) : t.admin.never}
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
            <h2>{t.activity.title}</h2>
            <p class="lead">{t.activity.orgLead}</p>
          </div>
        </div>
        <div class="card">
          <ActivityTable rows={props.activity} showUser />
        </div>
      </section>
    </Layout>
  );
}
