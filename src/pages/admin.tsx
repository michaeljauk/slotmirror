import type { Role } from "../access";
import { useI18n } from "../i18n";
import type { CurrentUser } from "../users";
import { Layout } from "./layout";

export interface AdminUserRow {
  email: string;
  role: Role;
  lastSignInAt: string | null;
  accounts: number;
}

/** Users of the admin's org with their number of connected accounts. No calendar data. */
export function AdminPage(props: { user: CurrentUser; users: AdminUserRow[] }) {
  const { t, formatTimestamp } = useI18n();
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
    </Layout>
  );
}
