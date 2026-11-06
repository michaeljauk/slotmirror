## In short

- This site sets no cookies and does not track you across sites.
- Statistics use no cookie and no persistent ID.
- The waitlist keeps your email address only if you confirm it. Unconfirmed addresses are deleted
  after at most 8 days, and you can leave the list at any time.
- This notice covers slotmirror.com, its documentation, and the confirm and unsubscribe pages of
  the waitlist on slotmirror.app. A slotmirror deployment is run by the person or company that
  deployed it. What the software stores is described in
  [Privacy and data location](../docs/privacy/).
- No decision about you is made by automated means alone.

## Hosting

The site runs on Cloudflare Workers. To deliver a page, Cloudflare processes your IP address, the
address of the page and the headers that your browser sends. Cloudflare also uses this data to
protect the site from attacks. The Workers of this site and of the waitlist store no logs:
Workers Logs is off for both. If the site is served from GitHub Pages as a fallback, GitHub
processes the same data.

Legal basis: Art. 6(1)(f) GDPR. The legitimate interest is to deliver the site and to keep it
secure.

## Statistics

The site and its documentation use PostHog (EU Cloud, Frankfurt) for statistics.

- PostHog runs in cookieless mode. It sets no cookie and stores nothing in the browser for
  statistics. A visitor gets no persistent ID. PostHog builds a hash from IP address, user agent
  and a daily salt, and the hash changes every day.
- The site records page views and these events: a click on a "Deploy to Cloudflare" button or
  link, a click on the main button of the home page, and a sign-up sent from the waitlist form.
- Each event carries the page URL and the referring page, both without query string, fragment or
  campaign parameters, and technical data such as browser, operating system, screen size,
  language and time zone. The sign-up event carries no email address, no token and no answer of
  the server.
- There is no autocapture, no session replay, no survey and no feature flag.
- The browser sends the events to this domain. A Cloudflare Worker forwards them to PostHog with
  the IP address, because PostHog needs it for the daily hash. The Worker forwards only the headers
  `Content-Type`, `Content-Encoding` and `User-Agent`, drops all others, including cookies, and
  stores nothing. The PostHog project setting "Discard client IP data" removes the IP address after
  PostHog built the hash.
- PostHog deletes the events when the retention period of the project ends.

Legal basis: Art. 6(1)(f) GDPR. The legitimate interest is to know which pages people read and
which steps they take, so that the documentation can improve. Nothing is stored on or read from
your device for statistics.

## Waitlist of the hosted version

The home page can show a form for the waitlist of a hosted version that does not exist yet.
Joining the list is not a purchase. Giving your email address is voluntary; without it you cannot
join the list.

- **What is stored.** The email address, the place of the sign-up (for example `website-home`), the
  time of the sign-up, the time of the last confirmation mail, the time of the confirmation, and
  the expiry times of two links. The two link tokens are stored only as hashes. No name, no IP
  address and no user agent are stored. The waitlist Worker logs no address and no token.
- **Where it goes.** The browser sends the form straight to the waitlist Worker on slotmirror.app,
  not through the statistics proxy. The confirm and unsubscribe pages load no script and send
  nothing to PostHog.
- **Double opt-in.** After the sign-up you get one mail with a confirm link and an unsubscribe
  link. The address counts only after you confirm it. Opening a link changes nothing; a button on
  the page sends the confirmation or the unsubscription. The address is used only to tell you when
  the hosted version opens. The waitlist Worker sends no other mail.
- **Deadlines.** The confirm link works for 7 days from the last confirmation mail. Unconfirmed
  entries are deleted after that time, at the latest after 8 days. Confirmed entries are deleted
  after 31 March 2027. The unsubscribe link works for 365 days.
- **Leaving the list.** The unsubscribe link deletes the whole entry at once. The mail header also
  offers one-click unsubscribe. You can also ask the operator at the address above. Backups of the
  database and the delivery logs of the mail service can keep the data for a limited time after
  that.
- **Protection against abuse.** Every sign-up needs a Cloudflare Turnstile check. The browser loads
  the Turnstile script from `challenges.cloudflare.com` only when the form comes into view. The
  waitlist Worker sends the Turnstile answer and your IP address to Cloudflare to verify it. To
  limit sign-ups per network, it stores a keyed hash of the IP address (for IPv6, of the /64
  network), never the address, for about two days.

Legal basis: Art. 6(1)(a) GDPR, your consent, which you can withdraw at any time with the
unsubscribe link. The Turnstile check and the hash of the IP address: Art. 6(1)(f) GDPR. The
legitimate interest is to keep bots and abuse off the list.

## Theme

The browser keeps your light or dark choice in local storage. It never leaves your browser and is
not used for tracking.

## Processors

- Cloudflare, Inc.: hosting, the waitlist Worker and its database, and Turnstile.
- PostHog, Inc.: statistics, EU Cloud in Frankfurt.
- Resend: sends the confirmation mail, sending region EU.
- GitHub, Inc.: hosting, only if the site is served from GitHub Pages as a fallback.

These companies are based in the United States, and Cloudflare runs Workers on its worldwide
network. If data reaches them outside the EU, the transfer relies on the EU-US Data Privacy
Framework or on the standard contractual clauses of the European Commission.

## Your rights

You have the right to access your data, to correct it, to delete it, to restrict its processing,
to receive it in a portable format, and to object to processing based on Art. 6(1)(f) GDPR. You
can withdraw a consent at any time; this does not affect processing before the withdrawal. Write to
the operator at the address above.

You can also complain to a data protection authority. In Austria this is the Datenschutzbehörde,
Barichgasse 40-42, 1030 Vienna, [dsb.gv.at](https://www.dsb.gv.at/).
