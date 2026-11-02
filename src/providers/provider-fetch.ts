/**
 * A token request holds every caller of one account behind `AccountSync.refresh()`, and at sign-in a
 * person waits for it. A token endpoint normally answers within a second or two.
 */
export const TOKEN_TIMEOUT_MS = 10_000;

/** One read, or one watch call. Provider calls run one at a time, so a slow call holds the rest. */
export const CALL_TIMEOUT_MS = 30_000;

/**
 * One write batch of up to 50 actions. A timeout leaves the outcome of a write unknown, so a batch
 * gets more time than a read.
 */
export const BATCH_TIMEOUT_MS = 60_000;

/**
 * Status and reason of a calendar call that timed out, in the form of a provider error. No provider
 * sent them. `isThrottled()` does not match them, so a timeout takes the path of a failed call. A
 * throttled rule stays first in the queue, and a read that always times out would block the others.
 */
export const TIMEOUT_STATUS = 504;
export const TIMEOUT_REASON = "timeout";

/**
 * `fetch` for a provider, with one deadline for the answer and its body. The body is read here,
 * because a stream can stop after the headers. Callers read the returned response as usual.
 *
 * After the deadline the call throws `timeoutError()`. There is one exception: a refusal with a
 * stalled body comes back with its status and headers and an empty body, because a 429 still
 * carries its `Retry-After`. Other failures stay as they are. There is no retry here: a retry would
 * spend a subrequest and hold the queue. The next run tries again.
 *
 * The timer ends with the call. A timer that runs on keeps a Durable Object from hibernating.
 */
export async function providerFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  timeoutError: () => Error,
): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Provider deadline passed"));
    }, timeoutMs);
  });
  let head: Response | undefined;
  const answer = async () => {
    const response = await fetch(url, { ...init, signal: controller.signal });
    head = response;
    const body = await response.arrayBuffer();
    // A Response refuses a body, even an empty one, with a status such as 204.
    return new Response(body.byteLength > 0 ? body : null, {
      status: response.status,
      headers: response.headers,
    });
  };
  try {
    return await Promise.race([answer(), expired]);
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    if (head && !head.ok) return new Response(null, { status: head.status, headers: head.headers });
    throw timeoutError();
  } finally {
    clearTimeout(timer);
  }
}
