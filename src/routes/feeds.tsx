import { Hono, type Context } from "hono";
import type { AppEnv } from "../app-env";
import {
  createFeed,
  deleteFeed,
  FEED_MAX_DAYS,
  feedUrl,
  MAX_FEED_CALENDARS,
  MAX_FEEDS_PER_USER,
  rotateFeed,
  type FeedInput,
} from "../feeds";
import { i18nFromContext } from "../i18n";
import { FeedUrlPage } from "../pages/feeds";
import { MessagePage } from "../pages/message";
import { render } from "../render";
import type { CurrentUser } from "../users";

/** Managing the signed-in user's free/busy feeds. The feed itself is served under /ics. */
export const feeds = new Hono<AppEnv>();

feeds.use("*", async (c, next) => {
  if (!c.get("user")) return c.redirect("/");
  await next();
});

function currentUser(c: Context<AppEnv>): CurrentUser {
  const user = c.get("user");
  if (!user) throw new Error("feed routes require a user");
  return user;
}

/** The form of a new feed, or null if it is malformed. The page cannot send such a form. */
function parseFeedForm(form: FormData): FeedInput | null {
  const calendarIds = form.getAll("calendar").filter((id): id is string => typeof id === "string");
  const days = Number(form.get("days"));
  if (!Number.isInteger(days) || days < 1 || days > FEED_MAX_DAYS) return null;
  return { calendarIds, daysAhead: days, includeAllDay: form.get("allDay") === "1" };
}

/** The address of a deployment: PUBLIC_URL if set, otherwise the address of the request. */
function baseUrl(c: Context<AppEnv>): string {
  return c.env.PUBLIC_URL?.trim() || new URL(c.req.url).origin;
}

/** Show the secret address once. The page must not be stored or leak through a referrer. */
function showUrl(c: Context<AppEnv>, feedId: string, token: string) {
  c.header("cache-control", "no-store");
  c.header("referrer-policy", "no-referrer");
  return render(c, <FeedUrlPage user={currentUser(c)} url={feedUrl(baseUrl(c), feedId, token)} />);
}

feeds.post("/", async (c) => {
  const user = currentUser(c);
  const input = parseFeedForm(await c.req.formData());
  if (!input) return c.text("Bad request", 400);
  const { locale, t } = i18nFromContext(c);
  const result = await createFeed(c.env, user, input, locale);
  if (result.ok) return showUrl(c, result.feedId, result.token);
  // Another user's calendar looks the same as one that does not exist.
  if (result.reason === "not_owned") return c.notFound();
  const message =
    result.reason === "no_calendar"
      ? t.feeds.noCalendar
      : result.reason === "too_many_calendars"
        ? t.feeds.tooManyCalendars(MAX_FEED_CALENDARS)
        : t.feeds.tooManyFeeds(MAX_FEEDS_PER_USER);
  return render(c, <MessagePage title={t.feeds.errorTitle} message={message} />, 400);
});

feeds.post("/:id/rotate", async (c) => {
  const rotated = await rotateFeed(c.env, currentUser(c), c.req.param("id"));
  if (!rotated) return c.notFound();
  return showUrl(c, rotated.feedId, rotated.token);
});

feeds.post("/:id/delete", async (c) => {
  const deleted = await deleteFeed(c.env, currentUser(c), c.req.param("id"));
  if (!deleted) return c.notFound();
  return c.redirect("/#feeds");
});
