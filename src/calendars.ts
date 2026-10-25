import type { CalendarInfo } from "./providers/graph-calendar";

export interface CalendarRow {
  id: string;
  accountId: string;
  accountEmail: string;
  name: string;
  canEdit: boolean;
  isDefault: boolean;
}

/** Calendars of all accounts of a user, from the registry. */
export async function userCalendars(db: D1Database, userId: string): Promise<CalendarRow[]> {
  const { results } = await db
    .prepare(
      `SELECT c.id, c.account_id AS accountId, a.email AS accountEmail, c.name,
              c.can_edit AS canEdit, c.is_default AS isDefault
       FROM calendars c JOIN accounts a ON a.id = c.account_id
       WHERE a.user_id = ?
       ORDER BY a.email, c.is_default DESC, c.name`,
    )
    .bind(userId)
    .all<{
      id: string;
      accountId: string;
      accountEmail: string;
      name: string;
      canEdit: number;
      isDefault: number;
    }>();
  return results.map((row) => ({
    ...row,
    canEdit: row.canEdit === 1,
    isDefault: row.isDefault === 1,
  }));
}

/** Load the calendar list of every account of a user from the provider into the registry. */
export async function refreshUserCalendars(env: Env, userId: string): Promise<void> {
  const { results: accounts } = await env.DB.prepare(
    "SELECT id, email FROM accounts WHERE user_id = ? AND provider = 'microsoft'",
  )
    .bind(userId)
    .all<{ id: string; email: string }>();

  for (const account of accounts) {
    // One account with expired or missing tokens must not block the calendars of the others.
    let calendars: CalendarInfo[];
    try {
      calendars = await env.ACCOUNT_SYNC.getByName(account.id).listCalendars();
    } catch (error) {
      console.error("Loading calendars failed", account.id, error);
      continue;
    }
    if (calendars.length === 0) continue;
    await env.DB.batch(
      calendars.map((calendar) =>
        env.DB.prepare(
          `INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (account_id, remote_id) DO UPDATE SET
             name = excluded.name, can_edit = excluded.can_edit, is_default = excluded.is_default`,
        ).bind(
          crypto.randomUUID(),
          account.id,
          calendar.id,
          calendar.name,
          // Only the account's own calendars are targets. A colleague's calendar shared with edit
          // rights must never receive blocks by accident.
          calendar.canEdit && calendar.ownerAddress === account.email.toLowerCase() ? 1 : 0,
          calendar.isDefault ? 1 : 0,
        ),
      ),
    );
  }
}
