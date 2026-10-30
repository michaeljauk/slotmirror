// The waitlist form. It posts to the waitlist Worker, never through the statistics proxy.
// The analytics script sends waitlist_submit on the submit event: no address, no token.
type Turnstile = {
  render(el: HTMLElement, options: Record<string, unknown>): string;
  reset(id?: string): void;
};
type Check = "idle" | "loading" | "ready" | "failed";

const MESSAGES: Record<string, string> = {
  invalid_email: "That email address does not look valid. Check it and try again.",
  turnstile_failed: "The human check failed. Try again.",
  rate_limited: "Too many attempts from this network. Try again in an hour.",
  mail_unavailable: "We cannot send mail right now. Try again later.",
  storage_unavailable: "The waitlist is not available right now. Try again later.",
};
const FALLBACK = "Something went wrong. Try again later.";
const NETWORK = "We could not reach the waitlist. Check your connection and try again.";
const LOADING = "Loading the human check…";
const CHECK_FAILED = "The human check did not load. Select “Try again”.";
const SENT = "Check your inbox. We sent a link to confirm your address. It works for 7 days.";

function setupWaitlist(form: HTMLFormElement) {
  const input = form.querySelector<HTMLInputElement>("#waitlist-email")!;
  const button = form.querySelector<HTMLButtonElement>("#waitlist-submit")!;
  const status = form.querySelector<HTMLElement>("#waitlist-status")!;
  const widgetBox = form.querySelector<HTMLElement>("#waitlist-widget")!;
  const row = form.querySelector<HTMLElement>(".waitlist-row")!;
  const endpoint = form.dataset.endpoint!;
  const siteKey = form.dataset.siteKey!;
  const turnstile = () => (window as unknown as { turnstile?: Turnstile }).turnstile;
  let widgetId: string | undefined;
  let token = "";
  let check: Check = "idle";
  let busy = false;
  let done = false;

  function show(text: string, error = false) {
    status.textContent = text;
    status.classList.toggle("error", error);
  }
  function render() {
    // "Try again" is a plain button, so the retry does not count as a submit in analytics.
    button.type = check === "failed" && !busy ? "button" : "submit";
    button.disabled = busy || (check !== "ready" && check !== "failed");
    button.textContent = busy ? "Sending…" : check === "failed" ? "Try again" : "Join the waitlist";
  }
  function fail() {
    token = "";
    check = "failed";
    show(CHECK_FAILED, true);
    render();
  }
  function waitForToken() {
    token = "";
    check = "loading";
    render();
  }
  function mount() {
    const api = turnstile();
    if (!api) return fail();
    // The widget runs in the managed mode: it shows a challenge only if it needs one.
    widgetId = api.render(widgetBox, {
      sitekey: siteKey,
      action: "waitlist",
      callback: (value: string) => {
        token = value;
        check = "ready";
        if (status.textContent === LOADING) show("");
        render();
      },
      "expired-callback": waitForToken,
      "timeout-callback": waitForToken,
      "error-callback": fail,
    });
  }
  function loadWidget() {
    check = "loading";
    show(LOADING);
    render();
    if (turnstile()) return mount();
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onload = mount;
    script.onerror = fail;
    document.head.append(script);
  }

  form.hidden = false;
  render();
  // Load the third-party script only when the form comes into view.
  const io = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      io.disconnect();
      loadWidget();
    },
    { rootMargin: "200px" },
  );
  io.observe(form);

  button.addEventListener("click", () => {
    if (check !== "failed" || busy) return;
    show(LOADING);
    if (widgetId === undefined) loadWidget();
    else {
      waitForToken();
      turnstile()?.reset(widgetId);
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || done) return;
    if (check !== "ready" || !token) return;
    if (!input.checkValidity()) {
      show(MESSAGES.invalid_email!, true);
      input.focus();
      return;
    }
    busy = true;
    show("");
    render();
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: input.value,
          source: "website-home",
          turnstileToken: token,
        }),
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(15000),
      });
      if (response.ok) {
        done = true;
        row.hidden = true;
        widgetBox.hidden = true;
        show(SENT);
      } else {
        let code = "";
        try {
          code = ((await response.json()) as { code?: string }).code ?? "";
        } catch {}
        show(MESSAGES[code] ?? FALLBACK, true);
      }
    } catch {
      show(NETWORK, true);
    } finally {
      busy = false;
      if (!done) {
        // A token works once. The input stays as typed.
        waitForToken();
        if (widgetId !== undefined) turnstile()?.reset(widgetId);
      } else render();
    }
  });
}

const form = document.querySelector<HTMLFormElement>("#waitlist-form");
if (form) setupWaitlist(form);
