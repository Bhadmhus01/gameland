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
  results: {},   // roundId -> { score, discipline, raw, rank, percentile, at }
  queue: [],     // unsent submissions (offline resilience)
  streak: { last: "", count: 0 },
  seen: false,
};

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
  reset() {
    const dev = state.deviceId;
    state = { ...DEFAULTS, deviceId: dev };
    persist();
  },
};

export { deviceId };
