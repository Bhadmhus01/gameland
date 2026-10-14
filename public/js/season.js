/**
 * AYO — the season layer.
 *
 * Pure functions, no DOM and no I/O, shared by the server, the client and the
 * test suite. The same reasoning as retention.js: a competition rule nobody can
 * reproduce by hand is not a rule, it is a rumour.
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE OF A SEASON
 *
 * A week is exactly seven rounds, and the rotation is built so that every week
 * contains all seven faculties exactly once (engine.js, invariant 3). That is
 * the property the whole season rests on: comparing two players by their week
 * is comparing them on the identical seven challenges. A season is twelve such
 * weeks — eighty-four rounds — so the same is true of a season.
 *
 * ---------------------------------------------------------------------------
 * THE QUALIFICATION RULE, AND WHY IT IS THIS ONE
 *
 * A season score is the sum of a player's BEST 40 ROUNDS out of the 84 on
 * offer, and a player must have played at least 24 rounds to qualify at all.
 *
 * Both numbers are chosen against the same constraint, which is connectivity.
 * Most of the world does not have a reliable daily connection, and the launch
 * market certainly does not. So:
 *
 *   - Requiring all 84 rounds would exclude anyone whose phone, power or data
 *     fails on a given day. That is not a measure of skill; it is a measure of
 *     income. It would also, embarrassingly, exclude exactly the people this
 *     game claims to exist for.
 *
 *   - Summing everything played rewards grinding rather than excellence, and
 *     makes an absent day a permanent penalty.
 *
 *   - Averaging everything played lets somebody with four lucky rounds beat
 *     somebody with eighty good ones. That is the "play once, score perfect"
 *     failure, which this project has already had to fix once at the daily
 *     level.
 *
 * Best-40-of-84 with a floor of 24 takes the useful part of each: your bad days
 * are forgiven, your absent days are forgiven, and you still have to show up
 * for a real stretch of the season to be counted.
 *
 * The honest tension, stated rather than hidden: a player who plays more rounds
 * has more chances to fill their best 40, so a player with reliable data still
 * has an edge in contention. It is bounded — the 41st-best round is worth
 * nothing, so the edge runs out — and it is bounded low enough that 24 rounds
 * (under three a week) is enough to qualify. We would rather name that than
 * claim a level of equality the infrastructure does not currently allow.
 */

import { utcDateString, dayIndexOf, weekIdOf, ROUND_EPOCH } from "./engine.js";

export const SEASON_EPOCH = ROUND_EPOCH; // season 1 opens with the game itself
export const SEASON_WEEKS = 12;
export const SEASON_ROUNDS = SEASON_WEEKS * 7; // 84
export const WEEK_ROUNDS = 7;

/** Play this many rounds to be counted at all. Under three a week. */
export const QUALIFY_MIN = 24;

/** Only your best N rounds count towards your season score. */
export const COUNT_BEST = 40;

export const addDays = (dateStr, n) =>
  new Date(Date.parse(dateStr + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

/** 0-based season index for a date. */
export function seasonIndex(dateStr) {
  return Math.floor(dayIndexOf(dateStr) / SEASON_ROUNDS);
}

export function seasonId(index) {
  return "s" + String(index + 1).padStart(3, "0");
}

/**
 * Everything a caller needs to know about where a date sits in the season.
 *
 * NOTE ON NAMING: the position within the season is called `position`, never
 * `seasons`. Binding that identifier inside a destructure silently disables the
 * rest of the function it appears in — a mistake that already cost this project
 * a full debugging cycle, so the name is avoided on purpose.
 */
export function seasonInfo(dateStr) {
  const index = seasonIndex(dateStr);
  const start = addDays(SEASON_EPOCH, index * SEASON_ROUNDS);
  const position = dayIndexOf(dateStr) - index * SEASON_ROUNDS; // 0..83
  return {
    ...seasonByIndex(index),
    position,
    roundInSeason: position + 1,
    weekInSeason: Math.floor(position / WEEK_ROUNDS) + 1,
    weekId: weekIdOf(dateStr),
    // How many rounds of the season have been offered as of this date.
    roundsElapsed: Math.min(SEASON_ROUNDS, position + 1),
    roundsRemaining: Math.max(0, SEASON_ROUNDS - (position + 1)),
  };
}

/**
 * Describe a season by its index, independent of any date.
 *
 * Needed because "is this season over?" cannot be answered from a date inside
 * it — the day after it ends, that date belongs to the NEXT season. Whether a
 * season has finished is a question about today, so it is asked separately
 * through seasonStatus().
 */
export function seasonByIndex(index) {
  const start = addDays(SEASON_EPOCH, index * SEASON_ROUNDS);
  const end = addDays(start, SEASON_ROUNDS - 1);
  return {
    id: seasonId(index),
    number: index + 1,
    index,
    start,
    end,
    totalRounds: SEASON_ROUNDS,
    totalWeeks: SEASON_WEEKS,
  };
}

/** "upcoming" | "running" | "complete", judged against a real today. */
export function seasonStatus(info, today) {
  const now = seasonIndex(today);
  if (now < info.index) return "upcoming";
  if (now > info.index) return "complete";
  return "running";
}

/** True when both dates are in the same season. */
export function sameSeason(a, b) {
  return seasonIndex(a) === seasonIndex(b);
}

/**
 * A player's tower for a span of rounds.
 *
 * `entries` is [{ roundId, date, score }] — one per round played, in any order.
 * Duplicates for the same round are ignored, keeping the best, because a round
 * can only be played once and a stale local copy must not invent a second
 * attempt.
 */
export function towerFor(entries = [], { today, season = null } = {}) {
  const info = season || seasonInfo(today);
  const status = seasonStatus(info, today);
  // How far into the season today is, derived from `today` rather than read off
  // `info`. A caller may pass a plain season description (from seasonByIndex)
  // which has no position — and silently reading undefined there produced a
  // tower that claimed the season had no rounds left.
  const elapsed = Math.max(0, Math.min(SEASON_ROUNDS, dayIndexOf(today) - dayIndexOf(info.start) + 1));
  const remaining = Math.max(0, SEASON_ROUNDS - elapsed);

  // One entry per round, best kept.
  const byRound = new Map();
  for (const e of entries) {
    if (!e || !e.roundId || !Number.isFinite(e.score)) continue;
    const prev = byRound.get(e.roundId);
    if (!prev || e.score > prev.score) byRound.set(e.roundId, e);
  }

  const played = [...byRound.values()].sort((a, b) => b.score - a.score);
  const counted = played.slice(0, COUNT_BEST);
  const total = counted.reduce((a, e) => a + e.score, 0);
  const roundsPlayed = played.length;
  const qualifying = roundsPlayed >= QUALIFY_MIN;

  // Can this player still reach the floor this season?
  const canStillQualify = qualifying || roundsPlayed + remaining >= QUALIFY_MIN;
  const needed = Math.max(0, QUALIFY_MIN - roundsPlayed);

  return {
    seasonStatus: status,
    roundsPlayed,
    roundsCounted: counted.length,
    // The rounds that actually count, best first.
    counted,
    total,
    best: played.length ? played[0].score : null,
    worst: played.length ? played[played.length - 1].score : null,
    // The weakest score among those being counted: the "how good is your good
    // enough" number, and the first tie-break.
    floor: counted.length ? counted[counted.length - 1].score : null,
    // Average across everything played, for display only — never for ranking,
    // because it is the number that lets a lucky short season look strong.
    average: roundsPlayed ? Math.round(total_played(played) / roundsPlayed) : null,
    roundsNeeded: needed,
    roundsRemaining: remaining,
    qualifying,
    canStillQualify,
    // A provisional read while the season is running; only the season's end
    // confirms it. Mid-season the label says so, because declaring somebody
    // qualified in week one of twelve would be nonsense.
    status: qualifying
      ? status === "complete"
        ? "qualified"
        : "on_track"
      : canStillQualify
        ? "at_risk"
        : "out",
  };
}

function total_played(played) {
  return played.reduce((a, e) => a + e.score, 0);
}

/**
 * A week's tower: the rounds inside the week containing `dateStr`.
 * Seven rounds, one per faculty — the smallest complete unit of the game.
 */
export function weekTowerFor(entries = [], dateStr) {
  const week = weekIdOf(dateStr);
  const rows = (entries || []).filter((e) => e && e.date && weekIdOf(e.date) === week);
  const byRound = new Map();
  for (const e of rows) {
    const prev = byRound.get(e.roundId);
    if (!prev || e.score > prev.score) byRound.set(e.roundId, e);
  }
  const played = [...byRound.values()].sort((a, b) => b.score - a.score);
  return {
    weekId: week,
    roundsOffered: WEEK_ROUNDS,
    roundsPlayed: played.length,
    total: played.reduce((a, e) => a + e.score, 0),
    best: played.length ? played[0].score : null,
    complete: played.length === WEEK_ROUNDS,
    // Seven rounds at 1000 is the ceiling; useful for progress display.
    perfect: WEEK_ROUNDS * 1000,
  };
}

/**
 * Rank players for a season.
 *
 * TIE-BREAKS, in order, all of them things a player can understand:
 *   1. season score  — the sum of your best 40
 *   2. floor         — the weakest round you are counting, i.e. consistency,
 *                      so a player with fewer bad days ranks higher
 *   3. rounds played — the player who showed up more
 *   4. account id    — arbitrary but deterministic, so the table never reshuffles
 *
 * Only qualifying players are ranked. Everybody else is reported separately,
 * with how many rounds they still need, rather than quietly appearing at the
 * bottom as though they had competed and lost.
 */
export function seasonStandings(players = {}, { today, season = null, limit = 100 } = {}) {
  const info = season || seasonInfo(today);
  const ranked = [];
  const chasing = [];

  for (const [accountId, p] of Object.entries(players)) {
    if (!p || p.demo) continue; // the demo world never competes
    const tower = towerFor(p.entries || [], { today, season: info });
    const row = {
      accountId,
      pseudo: p.pseudo,
      iso: p.iso,
      ...tower,
    };
    if (tower.qualifying) ranked.push(row);
    else if (tower.roundsPlayed > 0) chasing.push(row);
  }

  ranked.sort(
    (a, b) =>
      b.total - a.total ||
      (b.floor ?? 0) - (a.floor ?? 0) ||
      b.roundsPlayed - a.roundsPlayed ||
      String(a.accountId).localeCompare(String(b.accountId))
  );

  chasing.sort(
    (a, b) => b.roundsPlayed - a.roundsPlayed || String(a.accountId).localeCompare(String(b.accountId))
  );

  return {
    season: info,
    qualifiers: ranked.length,
    chasing: chasing.length,
    standings: ranked.slice(0, limit).map((r, i) => ({ rank: i + 1, ...r })),
    // Kept short: enough to show there is a queue, not a list of the excluded.
    closestToQualifying: chasing.slice(0, 20),
  };
}

/**
 * Rank nations for a season.
 *
 * By MEDIAN of their qualifying players, for the same reason the daily board
 * uses median: population must not buy rank, and one prodigy must not make a
 * country look strong. A nation needs a minimum number of qualifiers before it
 * is ranked at all, and until then it is shown as unranked with the number
 * still needed — never as a rank it has not earned.
 */
export function nationStandings(players = {}, { today, season = null, minQualifiers = 5, limit = 100 } = {}) {
  const info = season || seasonInfo(today);
  const byCountry = new Map();

  for (const [accountId, p] of Object.entries(players)) {
    if (!p || p.demo || !p.iso) continue;
    const tower = towerFor(p.entries || [], { today, season: info });
    if (!tower.qualifying) continue;
    if (!byCountry.has(p.iso)) byCountry.set(p.iso, []);
    byCountry.get(p.iso).push({ accountId, pseudo: p.pseudo, total: tower.total });
  }

  const ranked = [];
  const unranked = [];

  for (const [iso, members] of byCountry) {
    const scores = members.map((m) => m.total).sort((a, b) => a - b);
    const median = scores[Math.floor(scores.length / 2)];
    const row = {
      iso,
      qualifiers: members.length,
      median,
      top: scores[scores.length - 1],
      // Depth, not a single star: the country's 10th-best qualifier is what a
      // national final would draw on.
      depth: scores.length >= 10 ? scores[scores.length - 10] : null,
      needed: Math.max(0, minQualifiers - members.length),
    };
    if (members.length >= minQualifiers) ranked.push(row);
    else unranked.push(row);
  }

  ranked.sort(
    (a, b) => b.median - a.median || b.qualifiers - a.qualifiers || a.iso.localeCompare(b.iso)
  );
  unranked.sort((a, b) => b.qualifiers - a.qualifiers || a.iso.localeCompare(b.iso));

  return {
    season: info,
    minQualifiers,
    ranked: ranked.slice(0, limit).map((r, i) => ({ rank: i + 1, ...r })),
    unranked: unranked.slice(0, 20),
  };
}

/**
 * Gather every round of a season into per-account score lists.
 *
 * `rounds` is the raw store: { r0001: { date, board: [{ accountId, ... }] } }.
 * Anything outside the season's window is ignored, and entries without an
 * account are skipped — those were written before accounts existed and cannot
 * be attributed to anyone.
 */
export function collectSeasonEntries(rounds = {}, { today, season = null, includeDemo = false } = {}) {
  const info = season || seasonInfo(today);
  const players = {};
  const seenRounds = [];

  for (const [roundId, round] of Object.entries(rounds)) {
    if (!round || !round.date) continue;
    if (!sameSeason(round.date, info.start)) continue;
    seenRounds.push({ roundId, date: round.date });
    for (const e of round.board || []) {
      if (e.demo && !includeDemo) continue;
      if (!e.accountId) continue;
      const key = e.accountId;
      if (!players[key]) players[key] = { pseudo: e.pseudo, iso: e.iso, entries: [] };
      players[key].entries.push({ roundId, date: round.date, score: e.score });
      // Keep the most recent name and country: a player who moves is counted
      // where they now are, once.
      players[key].pseudo = e.pseudo;
      if (e.iso) players[key].iso = e.iso;
    }
  }

  seenRounds.sort((a, b) => a.date.localeCompare(b.date));
  return { players, rounds: seenRounds, playersCount: Object.keys(players).length, season: info };
}

/** Convenience for callers that only have a date. */
export const seasonOf = (dateStr = utcDateString()) => seasonInfo(dateStr);
