import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { vi } from "vitest";
import {
  changeFakeWireEvent,
  FAKE_PROVIDERS,
  fakeFaultsLeft,
  readFakeCalendar,
  type FakeFault,
} from "../../src/providers/fake-calendar.ts";
import { BASE, signIn } from "../../test/helpers.ts";
import type {
  CalendarChange,
  CalendarEntry,
  CalendarSide,
  Capability,
  ControlAction,
  DriverSetup,
  RuleSettings,
  SuiteDriver,
} from "../lib/scenario.ts";

type FakeProvider = NonNullable<(typeof FAKE_PROVIDERS)[number]>;

function providersOf(direction: string): Record<CalendarSide, FakeProvider> {
  const [first, second] = FAKE_PROVIDERS as [FakeProvider, FakeProvider];
  return direction === "forward"
    ? { source: first, target: second }
    : { source: second, target: first };
}

/**
 * The driver for the simulated calendars. It runs inside the Workers runtime of Vitest. The real
 * `AccountSync` runs its alarms and cron ticks, and only the provider is simulated. The clock is
 * simulated too, so a wait costs no real time and alarms never fire on their own: the start lies
 * years ahead of real time, on a fixed date, so that every run sees the same calendar.
 */
const LOCAL_START = Date.parse("2031-02-03T09:15:00Z");
const CRON_MS = 600_000;
const DAY_MS = 86_400_000;
/** A guard against an alarm that sets itself again at once. */
const MAX_WAIT_STEPS = 5_000;
/** Refused for the whole pause; `reconnect` ends it. */
const CALLS_ONE_YEAR_AHEAD = 365 * DAY_MS;
/** A setup ends when the first cycle and the watches are done. */
const SETUP_SECONDS = 120;

const CAPABILITIES: Capability[] = [
  "clock",
  "faults",
  "provider-calls",
  "account-state",
  "disconnect",
  "detail-levels",
];

function ruleOptions(rule: RuleSettings = {}): string {
  const hours = rule.workingHours;
  return JSON.stringify({
    daysAhead: rule.daysAhead ?? 30,
    bufferBefore: rule.bufferBeforeMinutes ?? 0,
    bufferAfter: rule.bufferAfterMinutes ?? 0,
    ...(rule.detail ? { detailLevel: rule.detail } : {}),
    ...(hours
      ? {
          workDays: hours.days,
          workStart: hours.start,
          workEnd: hours.end,
          workTimeZone: hours.timeZone,
        }
      : {}),
  });
}

export class LocalDriver implements SuiteDriver {
  readonly name = "local";
  readonly mode = "simulated-clock";
  readonly capabilities: ReadonlySet<Capability> = new Set(CAPABILITIES);
  readonly directions = ["forward", "reverse"] as const;

  private runs = 0;
  private accounts: Record<CalendarSide, string> = { source: "", target: "" };
  private zones: Record<CalendarSide, string> = { source: "UTC", target: "UTC" };
  private providers = providersOf("forward");
  private ruleTargets: CalendarSide[] = [];
  /**
   * What a calendar showed after the last alarm. Disconnecting an account deletes its Durable
   * Object storage, and the simulated calendar lives there. A real calendar stays.
   */
  private lastSeen: Partial<Record<CalendarSide, CalendarEntry[]>> = {};

  now(): number {
    return Date.now();
  }

  protected stub(side: CalendarSide) {
    return env.ACCOUNT_SYNC.getByName(this.accounts[side]);
  }

  private stubs() {
    return (["source", "target"] as const).map((side) => this.stub(side));
  }

  private inCalendar<T>(side: CalendarSide, work: (sql: SqlStorage) => T): Promise<T> {
    return runInDurableObject(this.stub(side), (_instance, state) => work(state.storage.sql));
  }

  /** The provider stays with the tokens: without it, the store falls back to the first one. */
  private storeTokens(side: CalendarSide, accessExpiresAt: number): Promise<void> {
    const tokens = { refreshToken: "fake", accessToken: "fake", accessExpiresAt };
    return this.stub(side).storeTokens(this.accounts[side], tokens, this.providers[side]);
  }

  async prepare({ scenario, direction }: DriverSetup): Promise<void> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(LOCAL_START);
    this.runs += 1;
    const name = `suite-${scenario.id}-${direction}-${this.runs}-${crypto.randomUUID().slice(0, 8)}`;
    this.accounts = { source: `${name}-s`, target: `${name}-t` };
    this.zones = {
      source: scenario.calendars.source.timeZone,
      target: scenario.calendars.target.timeZone,
    };
    this.lastSeen = {};
    const both = scenario.rule?.direction === "both";
    this.ruleTargets = both ? ["target", "source"] : ["target"];
    this.providers = providersOf(direction);
    const { user } = await signIn("owner@example.com");
    const statements = (["source", "target"] as const).flatMap((side) => [
      env.DB.prepare(
        "INSERT INTO accounts (id, user_id, provider, email) VALUES (?, ?, ?, ?)",
      ).bind(this.accounts[side], user.id, this.providers[side], `${name}-${side}@example.com`),
      env.DB.prepare(
        `INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source)
         VALUES (?, ?, 'main', 'Calendar', 1, 1, 1)`,
      ).bind(`${this.accounts[side]}-main`, this.accounts[side]),
    ]);
    const rule = (id: string, from: CalendarSide, to: CalendarSide) =>
      env.DB.prepare(
        `INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(
        id,
        user.id,
        `${this.accounts[from]}-main`,
        `${this.accounts[to]}-main`,
        ruleOptions(scenario.rule),
      );
    statements.push(rule(`${name}-rule`, "source", "target"));
    if (both) statements.push(rule(`${name}-back`, "target", "source"));
    await env.DB.batch(statements);
    for (const side of ["source", "target"] as const) {
      const stub = this.stub(side);
      await this.storeTokens(side, this.now() + CALLS_ONE_YEAR_AHEAD);
      await stub.seedFake({ account: 1, accounts: 1, days: 90 }, 0);
      await stub.requestSync();
    }
    await this.waitForSync({ timeoutSeconds: SETUP_SECONDS });
  }

  async write(calendar: CalendarSide, change: CalendarChange): Promise<void> {
    const zone = this.zones[calendar];
    await this.inCalendar(calendar, (sql) => changeFakeWireEvent(sql, change, zone));
    // The simulated calendars send no notifications. This asks the same accounts as a real one.
    for (const side of new Set([calendar, ...this.ruleTargets])) {
      await this.stub(side).requestSync();
    }
  }

  async read(calendar: CalendarSide): Promise<CalendarEntry[]> {
    const live = await this.stub(calendar).hasTokens();
    if (!live) return this.lastSeen[calendar] ?? [];
    return this.inCalendar(calendar, (sql) => readFakeCalendar(sql));
  }

  private async nextAlarm(): Promise<{ at: number; side: CalendarSide } | null> {
    let next: { at: number; side: CalendarSide } | null = null;
    for (const side of ["source", "target"] as const) {
      const at = await runInDurableObject(this.stub(side), (_instance, state) =>
        state.storage.getAlarm(),
      );
      if (at !== null && (next === null || at < next.at)) next = { at, side };
    }
    return next;
  }

  private async remember(): Promise<void> {
    for (const side of ["source", "target"] as const) {
      if (await this.stub(side).hasTokens()) {
        this.lastSeen[side] = await this.inCalendar(side, (sql) => readFakeCalendar(sql));
      }
    }
  }

  async waitForSync(wait: {
    until?: () => Promise<boolean>;
    timeoutSeconds: number;
  }): Promise<boolean> {
    const deadline = this.now() + wait.timeoutSeconds * 1000;
    for (let step = 0; step < MAX_WAIT_STEPS; step++) {
      if (wait.until && (await wait.until())) return true;
      const alarm = await this.nextAlarm();
      const cron = (Math.floor(this.now() / CRON_MS) + 1) * CRON_MS;
      const next = Math.min(alarm?.at ?? Infinity, cron);
      if (next > deadline) {
        vi.setSystemTime(deadline);
        return wait.until ? wait.until() : false;
      }
      vi.setSystemTime(Math.max(this.now(), next));
      if (alarm && alarm.at <= cron) {
        await this.remember();
        await runDurableObjectAlarm(this.stub(alarm.side));
      } else {
        for (const stub of this.stubs()) await stub.tick();
      }
    }
    throw new Error("The alarms do not come to rest");
  }

  advance(to: number): Promise<void> {
    vi.setSystemTime(to);
    return Promise.resolve();
  }

  private async inject(side: CalendarSide, fault: FakeFault): Promise<void> {
    await this.stub(side).injectFakeFault(fault);
  }

  async control(action: ControlAction): Promise<void> {
    const side = action.calendar;
    switch (action.action) {
      case "throttle-reads":
        await this.inject(side, {
          kind: "reads_fail",
          error: "throttled",
          retryAfterMs: action.retryAfterSeconds * 1000,
        });
        return;
      case "throttle-writes":
        await this.inject(side, {
          kind: "writes_fail",
          status: 429,
          retryAfterMs: action.retryAfterSeconds * 1000,
        });
        return;
      case "fail-writes":
        await this.inject(side, {
          kind: "writes_fail",
          status: action.status,
          actions: action.actions,
        });
        return;
      case "refuse-token":
        // An expired access token needs a refresh, and the token endpoint refuses it: see the
        // outbound service in `suite/vitest.config.ts`.
        await this.storeTokens(side, this.now() - DAY_MS);
        return;
      case "reconnect":
        await this.storeTokens(side, this.now() + CALLS_ONE_YEAR_AHEAD);
        await env.DB.prepare("UPDATE accounts SET needs_reconnect = 0 WHERE id = ?")
          .bind(this.accounts[side])
          .run();
        return;
      case "disconnect": {
        const { cookie } = await signIn("owner@example.com");
        const response = await exports.default.fetch(
          `${BASE}/accounts/${this.accounts[side]}/disconnect`,
          { method: "POST", headers: { cookie, origin: BASE }, redirect: "manual" },
        );
        if (response.status !== 302) throw new Error(`Disconnect answered ${response.status}`);
        return;
      }
    }
  }

  async faultsFired(): Promise<boolean> {
    for (const side of ["source", "target"] as const) {
      if (await this.inCalendar(side, (sql) => fakeFaultsLeft(sql))) return false;
    }
    return true;
  }

  async providerCalls(calendar: CalendarSide): Promise<number> {
    const stats = await this.stub(calendar).fakeStats();
    return Object.values(stats.calls).reduce((sum, count) => sum + count, 0);
  }

  async cleanup(): Promise<void> {
    for (const stub of this.stubs()) {
      await runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm());
    }
    vi.useRealTimers();
  }
}
