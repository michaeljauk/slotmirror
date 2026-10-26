import type { CalendarRow } from "../calendars";
import {
  FEED_DEFAULT_DAYS,
  FEED_MAX_DAYS,
  MAX_FEED_CALENDARS,
  MAX_FEEDS_PER_USER,
  type FeedSummary,
} from "../feeds";
import { useI18n } from "../i18n";
import type { CurrentUser } from "../users";
import { Layout } from "./layout";

/** The free/busy feeds of the user on the start page: list, rotate, delete, create. */
export function FeedSection(props: { feeds: FeedSummary[]; calendars: CalendarRow[] }) {
  const { t, formatDate } = useI18n();
  // Only calendars the accounts own; a calendar shared by someone else is not theirs to publish.
  const owned = props.calendars.filter((calendar) => calendar.owned);
  return (
    <section class="section" id="feeds">
      <div class="section-head">
        <div>
          <h2>{t.feeds.title}</h2>
          <p class="lead">{t.feeds.lead}</p>
        </div>
      </div>

      <div class="card">
        {props.feeds.length === 0 ? (
          <div class="empty">{t.feeds.empty}</div>
        ) : (
          <ul class="list">
            {props.feeds.map((feed) => {
              const meta = [
                feed.calendars.map((calendar) => calendar.name).join(", "),
                t.feeds.daysAhead(feed.daysAhead),
                ...(feed.includeAllDay ? [t.feeds.withAllDay] : []),
                ...(feed.rotatedAt ? [t.feeds.renewedOn(formatDate(feed.rotatedAt))] : []),
              ];
              return (
                <li>
                  <div class="item-main">
                    <div class="item-title">{t.feeds.feedTitle(formatDate(feed.createdAt))}</div>
                    <div class="item-meta">{meta.join(" · ")}</div>
                    {feed.cutAt ? (
                      <div class="item-meta">{t.feeds.cut(formatDate(feed.cutAt))}</div>
                    ) : null}
                    {feed.errorCalendar ? (
                      <form
                        method="post"
                        action={`/feeds/${feed.id}/calendars/${feed.errorCalendar.id}/remove`}
                        class="item-meta error feed-error"
                      >
                        {t.feeds.calendarUnreadable(feed.errorCalendar.name)}{" "}
                        <button type="submit" class="link-button danger">
                          {t.feeds.removeCalendar}
                        </button>
                      </form>
                    ) : null}
                  </div>
                  <details class="rename">
                    <summary class="link-button quiet">{t.feeds.rotate}</summary>
                    <form method="post" action={`/feeds/${feed.id}/rotate`} class="rename-form">
                      <p class="fineprint">{t.feeds.rotateText}</p>
                      <button type="submit" class="button small">
                        {t.feeds.rotateConfirm}
                      </button>
                    </form>
                  </details>
                  <details class="rename">
                    <summary class="link-button quiet">{t.feeds.remove}</summary>
                    <form method="post" action={`/feeds/${feed.id}/delete`} class="rename-form">
                      <p class="fineprint">{t.feeds.removeText}</p>
                      <button type="submit" class="button small danger">
                        {t.feeds.removeConfirm}
                      </button>
                    </form>
                  </details>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {owned.length === 0 ? (
        <p class="fineprint">{t.feeds.noCalendars}</p>
      ) : props.feeds.length >= MAX_FEEDS_PER_USER ? (
        <p class="fineprint">{t.feeds.tooManyFeeds(MAX_FEEDS_PER_USER)}</p>
      ) : (
        <details class="card feed-new">
          <summary class="button">{t.feeds.create}</summary>
          <form method="post" action="/feeds" class="form">
            <fieldset class="feed-calendars">
              <legend>{t.feeds.calendarsLabel(MAX_FEED_CALENDARS)}</legend>
              {owned.map((calendar) => (
                <label class="check-row">
                  <input type="checkbox" name="calendar" value={calendar.id} />
                  <span>
                    {calendar.name} <span class="muted">{calendar.accountEmail}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <label>
              <span>{t.feeds.daysLabel}</span>
              <input
                type="number"
                name="days"
                min={1}
                max={FEED_MAX_DAYS}
                value={FEED_DEFAULT_DAYS}
                required
              />
            </label>
            <label class="check-row">
              <input type="checkbox" name="allDay" value="1" />
              {t.feeds.allDayLabel}
            </label>
            <p class="fineprint feed-shares">{t.feeds.shares}</p>
            <div class="actions">
              <button type="submit" class="button primary">
                {t.feeds.submit}
              </button>
            </div>
          </form>
        </details>
      )}
    </section>
  );
}

/** The secret address, shown once after creating or renewing a feed. */
export function FeedUrlPage(props: { user: CurrentUser; url: string }) {
  const { t } = useI18n();
  return (
    <Layout title={t.feeds.urlTitle} user={props.user} active="accounts">
      <div class="center">
        <div class="card">
          <h1>{t.feeds.urlTitle}</h1>
          <p class="lead">{t.feeds.urlLead}</p>
          <div class="feed-url">
            <input
              type="text"
              id="feed-url"
              value={props.url}
              readonly
              aria-label={t.feeds.urlTitle}
            />
            <button
              type="button"
              class="button small"
              data-copy="feed-url"
              data-copied={t.feeds.copied}
            >
              {t.feeds.copy}
            </button>
          </div>
          <p class="fineprint feed-shares">{t.feeds.urlHint}</p>
          <div class="actions">
            <a class="button" href="/#feeds">
              {t.feeds.back}
            </a>
          </div>
        </div>
      </div>
    </Layout>
  );
}
