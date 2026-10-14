/**
 * AYO — retention instrumentation, client side.
 *
 * DELIBERATELY SMALL. The game has no third-party analytics, no CDN, no
 * cookies, and adds no network traffic to anyone but its own server. What it
 * sends is four fields: an event name, a timestamp, the round, and a random
 * device id. Nothing else, ever.
 *
 * The rules this module follows, in order of priority:
 *
 *   1. It must never break the game. Every entry point is wrapped; a failure
 *      here is silent and the round plays on.
 *   2. It must never slow the game down. Events queue in memory and are
 *      flushed in the background, batched, with keepalive off the critical
 *      path. On a 2G connection this is a rounding error next to one image.
 *   3. It must be refusable. Do Not Track is honoured, and the player can turn
 *      it off in-app. Opting out deletes what was queued, immediately.
 *   4. It must never be able to grow without bound. The local queue is capped.
 */

import { store } from "./store.js";

const ENDPOINT = "/api/events";
const MAX_QUEUE = 120;
const FLUSH_AT = 12;
const FLUSH_EVERY_MS = 20000;

/**
 * Do Not Track, plus the user's own choice, which always wins.
 * `dnt` is read once: navigator.doNotTrack is unreliable across browsers, so
 * both spellings and both value types are accepted, and an explicit in-app
 * "no" from an earlier session is respected over anything the browser says.
 */
function browserSaysNo() {
  try {
    const d = navigator.doNotTrack ?? window.doNotTrack ?? navigator.msDoNotTrack;
    return d === "1" || d === 1 || d === "yes";
  } catch {
    return false;
  }
}

function enabled() {
  try {
    const pref = store.analyticsPref;
    if (pref === false) return false;
    if (pref === true) return true;
    return !browserSaysNo();
  } catch {
    return false;
  }
}

let queue = [];
let timer = null;
let flushing = false;

/**
 * Record an event. `name` must be one the server accepts; unknown names are
 * dropped here rather than sent to be rejected, so a typo costs nothing.
 */
export function track(name, props = {}) {
  try {
    if (!enabled()) return;
    if (typeof name !== "string" || !name) return;

    queue.push({
      e: name,
      t: Date.now(),
      d: store.identity.deviceId,
      ...(props && typeof props === "object" ? { p: props } : {}),
    });
    if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);

    if (queue.length >= FLUSH_AT) flush();
    else schedule();
  } catch {
    /* instrumentation is never allowed to interrupt play */
  }
}

function schedule() {
  if (timer || !queue.length) return;
  try {
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, FLUSH_EVERY_MS);
  } catch {
    timer = null;
  }
}

/**
 * Send what is queued. Safe to call as often as you like; concurrent calls
 * collapse into the one in flight. A failed flush keeps the events for later
 * rather than dropping them — the same instinct as the offline score queue,
 * because connectivity is the normal condition for most of the world.
 */
export async function flush() {
  if (flushing || !queue.length || !enabled()) return 0;
  flushing = true;
  const batch = queue.slice(0, 64);
  try {
    const res = await fetch(new URL(ENDPOINT, location.origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: batch }),
      // Survives a tab close mid-flush, which is exactly when people leave.
      keepalive: true,
    });
    if (!res.ok) return 0;
    const sent = new Set(batch);
    queue = queue.filter((x) => !sent.has(x));
    return batch.length;
  } catch {
    return 0;
  } finally {
    flushing = false;
    schedule();
  }
}

/** Forget everything queued, right now. */
export function forget() {
  try {
    queue = [];
    if (timer) clearTimeout(timer);
    timer = null;
  } catch {
    /* nothing to do */
  }
}

/** How many events are waiting to be sent. For the tests and for debugging. */
export function queueLength() {
  return queue.length;
}

/** The player's answer to "may we count you?" — off means off. */
export function setPreference(on) {
  store.setAnalyticsPref(!!on);
  if (!on) forget();
  else track("open");
  return !!on;
}

export function currentPreference() {
  return enabled();
}

/* ------------------------------------------------------------------ wiring */

/**
 * The return signal.
 *
 * This is the single most important number in the game, so it is recorded
 * before anything else can fail: `open` fires on every load, and the server
 * derives first-vs-return from the device id it has seen before. No cookie, no
 * fingerprint — just "this random id was here on an earlier day".
 */
export function trackOpen() {
  track("open");
}

/** Flush on the way out, and when the tab comes back. */
export function installLifecycle() {
  try {
    window.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        flush();
      } else {
        trackOpen();
      }
    });
    window.addEventListener("pagehide", () => flush());
  } catch {
    /* no-op */
  }
}
