/**
 * API layer with offline resilience.
 * A failed submission is queued and flushed automatically — important where
 * connectivity is patchy, which is most of the world most of the time.
 */

import { store } from "./store.js";
import { toast } from "./ui.js";

async function jget(path, params = {}) {
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  }
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

async function jpost(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  today(date, deviceId) {
    return jget("/api/rounds/today", { date, deviceId });
  },
  leaderboard(date, scope, country) {
    return jget("/api/leaderboard", { date, scope, country });
  },
  feed(date) {
    return jget("/api/feed", { date });
  },
  /** The live answer key is sealed until the player has answered. */
  wisdom(date, pseudo, country) {
    return jget("/api/wisdom", { date, pseudo, country });
  },
  me(pseudo, country) {
    return jget("/api/me", { pseudo, country });
  },
  country(iso) {
    return jget("/api/country", { country: iso });
  },

  async submit(payload) {
    try {
      return await jpost("/api/submit", payload);
    } catch (err) {
      // Network failure (not a validation failure) → keep it and retry later.
      if (!err.data) {
        store.enqueue(payload);
        throw Object.assign(new Error("queued"), { queued: true });
      }
      throw err;
    }
  },

  /** Flush anything held in the offline queue. Safe to call often. */
  async flush() {
    const queued = store.drainQueue();
    if (!queued.length) return 0;
    try {
      const res = await jpost("/api/submit-batch", { items: queued });
      const ok = (res.results || []).filter((r) => r.ok).length;
      if (ok) toast(`Synced ${ok} saved round${ok > 1 ? "s" : ""}.`, "ok");
      return ok;
    } catch {
      store.requeue(queued);
      return 0;
    }
  },
};
