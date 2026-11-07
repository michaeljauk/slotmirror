/**
 * What a log may hold of an error: its name, a safe code, a safe message and the stack frames.
 * Never the raw message or stack: a provider's `error_description` can name the user, and a
 * SyntaxError can quote the input. This module imports nothing, so that the logger
 * (`src/telemetry.ts`) and the providers can both use it without an import cycle.
 */

/** The parts of an error that a log may hold. See `errorFields`. */
export interface ErrorFields {
  name: string;
  /** An own `code` property that looks like a code. */
  code?: string;
  /** The message if it is safe (`safeMessage`), or the codes and paths of a schema error. */
  message?: string;
  /** The stack frames without the message. */
  frames: string;
}

/**
 * Messages this app throws itself. They hold no provider text and no user data, so they are safe
 * to log and store. A Durable Object error reaches the Worker as a plain `Error`, so the UI and
 * the audit log tell these apart by message.
 */
const STATIC_MESSAGES = new Set([
  "Account has no tokens",
  "Simulation is off",
  "A rule runs in the instance of its target account",
  "Token response carries no ID token",
  "Batch too large",
  "Google listed no sync token",
  "Google address is not verified",
  "Malformed ID token",
  "ID token carries no verified email and no preferred_username",
  "The rule's owner is no longer admitted",
  "Google event time has neither date nor dateTime",
]);

/**
 * Static text with IDs, status codes or a time zone name: "Rule <id> not found",
 * "Graph <what> failed: 403 <reason>". Also the messages of the runtime and of this app's own
 * error classes. A V8 TypeError or RangeError can quote values and is not listed.
 */
const STATIC_PATTERNS = [
  /^Rule [\w-]{1,64} not found$/,
  // The zone name comes from the provider, not from the user.
  /^Expected UTC times from Graph, got [A-Za-z0-9_/+ .-]{1,64}$/,
  /^(Graph|Google) [A-Za-z $]{1,40} failed: \d{3}( [A-Za-z0-9_.-]{1,64})?$/,
  /^Requesting a sync failed in \d{1,5} account\(s\)$/,
  // workerd and the Workers platform. The first six strings are in the workerd binary; the
  // subrequest and free-tier messages come from the platform and follow its documented wording.
  /^Network connection lost\.$/,
  /^Worker exceeded CPU time limit\.?$/,
  /^internal error; reference = [\w-]{1,64}$/,
  /^Durable Object storage operation exceeded timeout which caused object to be reset\.$/,
  /^Durable Object waited for too long\. The call was canceled and the Durable Object was reset\.$/,
  /^Durable Object storage (deleteAll\(\)|write) caused object to be reset; reference = [\w-]{1,64}$/,
  /^Durable Object's isolate exceeded its memory limit due to overflowing the storage cache\.[ -~]{0,200}$/,
  /^Too many subrequests( by single Worker invocation\.[ -~]{0,160}|\.)$/,
  /^Exceeded allowed (rows read|rows written|duration) in Durable Objects free tier\.$/,
];

/**
 * D1 messages that name tables and columns but quote no bound value: "D1_ERROR: UNIQUE
 * constraint failed: users.email". D1_TYPE_ERROR can quote a bound value and is left out.
 */
const D1_MESSAGE = /^D1_ERROR: [A-Za-z0-9_ .,:()'*-]{1,160}$/;

/**
 * The message of an error, only if it cannot quote provider text or user data: a static message
 * of this app or of the runtime, or a D1 message that holds no bound values.
 */
export function safeMessage(error: Error): string | undefined {
  const { message } = error;
  if (STATIC_MESSAGES.has(message) || STATIC_PATTERNS.some((pattern) => pattern.test(message))) {
    return message;
  }
  if (D1_MESSAGE.test(message)) return message;
  return undefined;
}

/** An own `code` property that survived the Durable Object boundary, if it looks like a code. */
export function safeCode(error: Error): string | undefined {
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[a-z0-9_]{1,64}$/i.test(code) ? code : undefined;
}

const FRAME = /^\s+at (?:[^\n]* \()?[^\s()]+:\d+:\d+\)?$/;

/**
 * The stack frames, without the message and its extra lines. Only lines of the form
 * "at <name> (<path>:<line>:<col>)" or "at <path>:<line>:<col>" count as frames.
 */
export function stackFrames(error: Error): string {
  // The stack starts with "name: message". A message of several lines takes several lines.
  const lines = (error.stack ?? "").split("\n").slice(error.message.split("\n").length);
  return lines.filter((line) => FRAME.test(line)).join("\n");
}

const ISSUE_CODE = /^[a-z_]{1,40}$/;
/** A field name. No "@", "." or "-", so an email address or a title cannot pass as one. */
const PATH_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/**
 * Fields that hold a record: the key after them comes from the data, not from the schema. Google
 * extended properties ("private", "shared") and Graph batch response headers.
 */
const RECORD_FIELDS = new Set(["private", "shared", "headers"]);
const MAX_ISSUES = 5;

/**
 * A schema error as "schema <code>@<path> ...", for example "schema invalid_type@value.1.owner".
 * A Zod error that crossed a Durable Object boundary keeps only its message, the JSON list of its
 * issues, so the issues come from the error itself or from that message. Only the code and the
 * path go into the log: never the expected or received values, and never Zod's text.
 */
export function schemaIssues(error: Error): string | undefined {
  let issues: unknown = (error as { issues?: unknown }).issues;
  if (issues === undefined) {
    if (!error.message.startsWith("[")) return undefined;
    try {
      issues = JSON.parse(error.message);
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(issues) || issues.length === 0) return undefined;
  const parts: string[] = [];
  for (const issue of issues.slice(0, MAX_ISSUES)) {
    const { code, path } = (issue ?? {}) as { code?: unknown; path?: unknown };
    if (typeof code !== "string" || !ISSUE_CODE.test(code) || !Array.isArray(path)) {
      return undefined;
    }
    const keys = path.map((key: unknown, index) => {
      if (typeof key === "number") return key;
      const parent: unknown = index > 0 ? path[index - 1] : undefined;
      if (typeof parent === "string" && RECORD_FIELDS.has(parent)) return "?";
      return typeof key === "string" && PATH_KEY.test(key) ? key : "?";
    });
    parts.push(`${code}@${keys.join(".")}`);
  }
  return `schema ${parts.join(" ")}`;
}

/** What to log for an error. The logger calls it; other code passes the error to the logger. */
export function errorFields(error: unknown): ErrorFields {
  if (!(error instanceof Error)) return { name: typeof error, frames: "" };
  const fields: ErrorFields = { name: error.name, frames: stackFrames(error) };
  const code = safeCode(error);
  if (code) fields.code = code;
  const message = safeMessage(error) ?? schemaIssues(error);
  if (message) fields.message = message;
  return fields;
}
