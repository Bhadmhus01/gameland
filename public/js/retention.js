/**
 * AYO — retention maths.
 *
 * Pure functions, no DOM and no I/O, shared by the server, the operator report
 * (`tools/retention.mjs`) and the test suite. Keeping the arithmetic in one
 * place is the point: a retention number nobody can reproduce is not a
 * measurement, it is a claim.
 *
 * What this measures, and why these particular numbers:
 *
 *   A daily game lives or dies on whether people come back TOMORROW. Not on
 *   total installs, not on time-in-app. So the unit is the device-day, the
 *   headline is the funnel (did the people who opened actually play?), and the
 *   cohort table answers the only question that matters: of the people who
 *   arrived on a given day, how many came back on day 1, day 7, day 30?
 *
 * Nothing here is personally identifying. A "player" is a random device id
 * generated on the device; there is no name, no email, no account.
 */

const DAY_MS = 86400000;

/** Whole days from `a` to `b`, both YYYY-MM-DD. Negative if b is earlier. */
export function daysBetween(a, b) {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / DAY_MS);
}

export function addDays(dateStr, n) {
  return new Date(Date.parse(dateStr + "T00:00:00Z") + n * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Put stored analytics back into a known shape.
 *
 * This exists because of a real failure: the server rebuilt its store from an
 * explicit whitelist of top-level keys on every boot, and the retention data
 * was not on that list — so each restart silently discarded every recorded
 * day. A retention instrument that forgets on deploy is worse than none,
 * because the numbers it does show look real.
 *
 * Anything unreadable is replaced with an empty structure rather than trusted;
 * anything readable is preserved exactly.
 */
export function normaliseAnalytics(raw) {
  const a = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const map = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
  const out = {
    days: map(a.days),
    players: map(a.players),
    updatedAt: Number(a.updatedAt) || 0,
  };

  // Belt and braces: a player record with no day list is meaningless and would
  // crash the cohort table later.
  for (const [id, p] of Object.entries(out.players)) {
    if (!p || typeof p !== "object" || !Array.isArray(p.days)) delete out.players[id];
    else if (!p.first) out.players[id] = { ...p, first: p.days[0] || "" };
  }
  for (const [date, d] of Object.entries(out.days)) {
    if (!d || typeof d !== "object" || Array.isArray(d)) delete out.days[date];
  }
  return out;
}

/* ------------------------------------------------------------------ funnel */

export const FUNNEL_STEPS = ["open", "start", "finish"];

/**
 * Turn one day's raw counters into a funnel with the rates a product decision
 * actually turns on.
 *
 * `open`   — the app was opened on this day
 * `start`  — a round was begun
 * `finish` — a result was submitted
 * `sync`   — an offline-queued result reached the server
 * `first`  — of the opens, how many were that device's first ever
 * `return` — of the opens, how many were by a device seen on an earlier day
 */
export function funnelFrom(day = {}) {
  const n = (k) => Number(day[k]) || 0;
  const open = n("open");
  const start = n("start");
  const finish = n("finish");
  const rate = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

  return {
    open,
    first: n("first"),
    return: n("return"),
    start,
    finish,
    abandon: Math.max(0, start - finish),
    sync: n("sync"),
    // Share of opens that led to a begun round, then to a finished one.
    startRate: rate(start, open),
    // Share of begun rounds seen through to a score.
    completionRate: rate(finish, start),
    // Share of opens that produced a score.
    overallRate: rate(finish, open),
  };
}

/** A funnel for each day in a window, oldest first, with a combined row. */
export function funnelSeries(days = {}, { from, to } = {}) {
  const keys = Object.keys(days)
    .filter((d) => (!from || d >= from) && (!to || d <= to))
    .sort();
  const rows = keys.map((date) => ({ date, ...funnelFrom(days[date]) }));

  const sum = (k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
  const total = {
    date: "all",
    open: sum("open"),
    first: sum("first"),
    return: sum("return"),
    start: sum("start"),
    finish: sum("finish"),
    abandon: sum("abandon"),
    sync: sum("sync"),
  };
  const rate = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
  total.startRate = rate(total.start, total.open);
  total.completionRate = rate(total.finish, total.start);
  total.overallRate = rate(total.finish, total.open);

  return { rows, total };
}

/* ----------------------------------------------------------------- cohorts */

export const HORIZONS = [1, 7, 30];

/** Did this player record any activity on `date`? */
export function activeOn(player, date) {
  return Array.isArray(player?.days) && player.days.includes(date);
}

/**
 * The cohort table.
 *
 * For each day a group of players arrived (`first` === that day), what share
 * were still showing up `n` days later?
 *
 * A horizon is only reported once it could have happened. A cohort from
 * yesterday has a D7 that is six days in the future; reporting it as 0% would
 * be a lie dressed as a number, so it is reported as `null` with an
 * honest "not yet measurable" reason.
 *
 * A cohort with too few players is also flagged rather than hidden: 100% of
 * one person is not a retention rate, and the caller is expected to say so.
 */
export function cohortTable(players = {}, today, horizons = HORIZONS, { minCohort = 1 } = {}) {
  const byFirst = new Map();
  for (const [id, p] of Object.entries(players)) {
    if (!p || !p.first) continue;
    if (!byFirst.has(p.first)) byFirst.set(p.first, []);
    byFirst.get(p.first).push({ id, ...p });
  }

  const cohorts = [...byFirst.keys()].sort().map((date) => {
    const members = byFirst.get(date);
    const age = daysBetween(date, today);
    const row = {
      date,
      size: members.length,
      age,
      small: members.length < minCohort,
      retained: {},
      rates: {},
      measurable: {},
    };

    for (const h of horizons) {
      row.measurable[h] = age >= h;
      if (age < h) {
        row.retained[h] = null;
        row.rates[h] = null;
        continue;
      }
      const target = addDays(date, h);
      const back = members.filter((m) => activeOn(m, target)).length;
      row.retained[h] = back;
      row.rates[h] = members.length ? Math.round((back / members.length) * 1000) / 10 : null;
    }
    return row;
  });

  // Weighted average across every cohort where the horizon has elapsed, so a
  // 1-person cohort cannot swing the headline number.
  const overall = {};
  for (const h of horizons) {
    let inCohort = 0;
    let cameBack = 0;
    for (const row of cohorts) {
      if (!row.measurable[h]) continue;
      inCohort += row.size;
      cameBack += row.retained[h] || 0;
    }
    overall[h] = {
      measurable: inCohort > 0,
      cohortSize: inCohort,
      returned: cameBack,
      rate: inCohort ? Math.round((cameBack / inCohort) * 1000) / 10 : null,
    };
  }

  return { cohorts, overall };
}

/**
 * How sticky is the daily habit overall?
 *
 * `stickiness` is the share of all the device-days we have seen that were
 * repeats rather than first arrivals — i.e. how much of the activity is people
 * coming back rather than new people arriving. A game that is only growing and
 * never retaining shows a low number here even while its installs climb, which
 * is exactly the failure mode this whole instrument exists to catch.
 */
export function stickiness(players = {}) {
  let deviceDays = 0;
  let repeatDays = 0;
  let players_seen = 0;
  for (const p of Object.values(players)) {
    if (!p || !Array.isArray(p.days) || !p.days.length) continue;
    players_seen++;
    deviceDays += p.days.length;
    repeatDays += p.days.length - 1;
  }
  return {
    players: players_seen,
    deviceDays,
    repeatDays,
    // Sessions per player: 1.0 means nobody has ever come back.
    perPlayer: players_seen ? Math.round((deviceDays / players_seen) * 100) / 100 : null,
    stickiness: deviceDays ? Math.round((repeatDays / deviceDays) * 1000) / 10 : null,
  };
}

/* ------------------------------------------------------------ growth bounds */

/**
 * Activity is capped per player and players are capped in total, so the
 * instrument cannot become the thing that fills the disk. Losing the tail of a
 * player's history is harmless: the horizons are 1, 7 and 30 days.
 */
export const KEEP_DAYS_PER_PLAYER = 120;
export const MAX_TRACKED_PLAYERS = 20000;

/**
 * Fold one device-day into the stored player map.
 *
 * This is the only place a device's history changes, and it lives here rather
 * than in the server so it can be driven through a simulated month in a test.
 * The counters it reports — new device, or a device coming back on a later
 * day — are exactly what the funnel's first/return split is built from, and a
 * silent zero in either was the first bug this instrument produced.
 *
 * Mutates `players`. Returns what the caller should count.
 */
export function recordDeviceDay(players = {}, id, day, { max = MAX_TRACKED_PLAYERS } = {}) {
  if (!id || !day) return { isNew: false, isReturn: false, atCapacity: false };

  const existing = players[id];
  if (!existing) {
    if (Object.keys(players).length >= max) {
      // At capacity: the aggregate day counters still count this, the cohort
      // table simply stops growing.
      return { isNew: false, isReturn: false, atCapacity: true };
    }
    players[id] = { first: day, last: day, days: [day] };
    return { isNew: true, isReturn: false, atCapacity: false };
  }

  // Already seen on this day: nothing changes, and it is not a return. Coming
  // back means coming back on a DIFFERENT day; opening the app twice on
  // Tuesday is not retention.
  if (existing.days.includes(day)) {
    return { isNew: false, isReturn: false, atCapacity: false };
  }

  const isReturn = existing.days.length > 0;
  existing.days.push(day);
  existing.days.sort();
  if (existing.days.length > KEEP_DAYS_PER_PLAYER) {
    existing.days = existing.days.slice(-KEEP_DAYS_PER_PLAYER);
  }
  if (day > (existing.last || "")) existing.last = day;
  return { isNew: false, isReturn, atCapacity: false };
}

/**
 * Trim stored activity in place-ish (returns a new object). Returns the counts
 * that were dropped, because silently discarding data is how a measurement
 * starts lying.
 */
export function prunePlayers(players = {}, today, { keep = KEEP_DAYS_PER_PLAYER, max = MAX_TRACKED_PLAYERS } = {}) {
  const cutoff = addDays(today, -keep);
  const out = {};
  let droppedDays = 0;
  let droppedPlayers = 0;

  // Most recently active first, so the cap sheds dormant players, not new ones.
  const entries = Object.entries(players).sort((a, b) => String(b[1]?.last || "").localeCompare(String(a[1]?.last || "")));

  for (const [id, p] of entries) {
    if (!p || !Array.isArray(p.days)) continue;
    const days = p.days.filter((d) => d >= cutoff);
    if (days.length !== p.days.length) droppedDays += p.days.length - days.length;
    if (!days.length) {
      droppedPlayers++;
      continue;
    }
    if (Object.keys(out).length >= max) {
      droppedPlayers++;
      continue;
    }
    out[id] = { first: p.first, last: days[days.length - 1], days };
  }

  return { players: out, droppedDays, droppedPlayers };
}

/** The full report, assembled from stored state. */
export function buildReport(store = {}, { today, window = 30 } = {}) {
  const days = store.days || {};
  const players = store.players || {};
  const from = addDays(today, -(window - 1));
  const funnel = funnelSeries(days, { from, to: today });
  const cohort = cohortTable(players, today);
  const stick = stickiness(players);
  const realDays = Object.keys(days).filter((d) => d >= from && d <= today).length;

  return {
    today,
    window,
    windowFrom: from,
    daysWithData: realDays,
    funnel,
    cohort,
    stickiness: stick,
    // Said plainly, in the payload, so no caller can present a funnel of zeros
    // as a result. There is a difference between "no retention" and "no data".
    empty: funnel.total.open === 0,
  };
}
