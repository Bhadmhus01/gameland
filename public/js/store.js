/**
 * Local player state.
 * The identity is deliberately light: a nickname and a country, stored on the
 * device. Nothing here is a login, and nothing private is ever collected.
 */

import { utcDateString, roundIdOf } from "./engine.js";

const KEY = "ayo.v1";

function deviceId() {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(36)).join("").slice(0, 12);
}

const DEFAULTS = {
  pseudo: "",
  iso: "",
  deviceId: deviceId(),
  // The account the server issued this device. `token` is the credential and is
  // never sent anywhere except /api/submit and /api/wisdom; `code` is the
  // recovery key the player can read off one phone and type into another.
  account: { id: "", token: "", code: "" },
  results: {},   // roundId -> { score, discipline, raw, rank, percentile, at }
  queue: [],     // unsent submissions (offline resilience)
  streak: { last: "", count: 0 },
  seen: false,
  // Retention instrumentation: null means "not chosen yet", so the browser's
  // Do Not Track setting decides. True or false is the player's own answer and
  // always wins.
  analytics: null,
};

/**
 * A storage-like object, or null — never throws.
 *
 * Reading `window.localStorage` can THROW in a third-party frame, so even
 * touching it has to be guarded.
 */
function safeStorage() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Can this browser actually keep anything?
 *
 * There are three possible states and only one is fine:
 *
 *   1. setItem works and getItem returns what was set  -> usable
 *   2. setItem throws                                  -> blocked, as in a
 *      third-party frame on Safari or some private modes
 *   3. setItem silently does nothing                   -> "working" storage
 *      that forgets, which is WORSE than blocked because it looks fine
 *
 * Only a round trip tells them apart, so that is what this does. A one-way
 * check would report healthy storage in case 3 and hand out a throwaway
 * identity on every single page load.
 */
export function storageProbe(ls) {
  if (!ls) return "unavailable";
  const key = "ayo.probe";
  try {
    ls.setItem(key, "1");
    const back = ls.getItem(key);
    ls.removeItem(key);
    if (back !== "1") return "not_persisting";
    return "";
  } catch {
    return "unavailable";
  }
}

/**
 * Computed once, at boot. If storage is broken we still play — but we must
 * never pretend a score in this context is a score that can be kept.
 */
const STORAGE_PROBLEM = storageProbe(safeStorage());

let state = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS, deviceId: deviceId() };
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed, deviceId: parsed.deviceId || deviceId() };
  } catch {
    return { ...DEFAULTS };
  }
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* private mode — the game still works for this session */
  }
}

export const store = {
  get all() {
    return state;
  },
  get identity() {
    return { pseudo: state.pseudo, iso: state.iso, deviceId: state.deviceId };
  },
  get account() {
    return state.account || { id: "", token: "", code: "" };
  },
  /**
   * "" when storage works; a reason string when it does not.
   *
   * The reason matters more than the boolean: a player told "your browser is
   * blocking storage" can act on it, and a promise that identity is safe while
   * it is not is worse than no promise at all.
   */
  get storageProblem() {
    return STORAGE_PROBLEM;
  },
  /** Remember what the server issued. Called once, on a player's first score. */
  setAccount({ id, token, code }) {
    state.account = {
      id: id || state.account?.id || "",
      token: token || state.account?.token || "",
      code: code || state.account?.code || "",
    };
    persist();
  },
  get hasAccount() {
    return !!state.account?.token;
  },
  get hasIdentity() {
    return state.pseudo.trim().length >= 2 && /^[A-Z]{2}$/.test(state.iso);
  },
  setIdentity(pseudo, iso) {
    state.pseudo = String(pseudo || "").trim().slice(0, 18);
    state.iso = String(iso || "").toUpperCase();
    persist();
  },
  todayResult(dateStr = utcDateString()) {
    return state.results[roundIdOf(dateStr)] || null;
  },
  saveResult(roundId, payload) {
    state.results[roundId] = { ...payload, at: Date.now() };
    persist();
  },
  /** Results for the last N days, newest first. */
  history(days = 30) {
    const today = Date.now();
    return Object.entries(state.results)
      .map(([roundId, r]) => ({ roundId, ...r }))
      .filter((r) => today - (r.at || 0) < days * 86400000)
      .sort((a, b) => b.at - a.at);
  },
  enqueue(item) {
    state.queue.push(item);
    if (state.queue.length > 14) state.queue.shift();
    persist();
  },
  drainQueue() {
    const q = state.queue.slice();
    state.queue = [];
    persist();
    return q;
  },
  requeue(items) {
    state.queue = [...items, ...state.queue].slice(-14);
    persist();
  },
  bumpStreak(dateStr = utcDateString()) {
    const s = state.streak || { last: "", count: 0 };
    if (s.last === dateStr) return s.count;
    const yesterday = utcDateString(new Date(Date.parse(dateStr) - 86400000));
    s.count = s.last === yesterday ? s.count + 1 : 1;
    s.last = dateStr;
    state.streak = s;
    persist();
    return s.count;
  },
  markSeen() {
    state.seen = true;
    persist();
  },
  get analyticsPref() {
    return state.analytics === undefined ? null : state.analytics;
  },
  setAnalyticsPref(on) {
    state.analytics = !!on;
    persist();
  },
  /** How many distinct days this device has played, ever. */
  get daysPlayed() {
    const seen = new Set();
    for (const [roundId, r] of Object.entries(state.results)) {
      if (r && r.at) seen.add(new Date(r.at).toISOString().slice(0, 10));
      else if (roundId) seen.add(roundId);
    }
    return seen.size;
  },
  /**
   * Clear this device. The account goes with it — it is the player's identity,
   * so "reset" means a fresh start — but the recovery code is deliberately
   * returned to the caller so the UI can show it one last time before it is
   * gone. Losing a tower silently is exactly what accounts exist to prevent.
   */
  reset() {
    const dev = state.deviceId;
    const pref = state.analytics;
    const code = state.account?.code || "";
    state = { ...DEFAULTS, deviceId: dev, analytics: pref };
    persist();
    return { code };
  },
};

export { deviceId };
