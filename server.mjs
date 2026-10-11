/**
 * AYO — The Everyday Games
 * Zero-dependency Node server.
 *
 *   • Serves the static client from /public
 *   • Verifies every score server-side (the browser never declares its own points)
 *   • Keeps a daily, global leaderboard: personal, national and per-capita
 *   • Runs a clearly-labelled rotating "demo world" in countries where the game
 *     has not yet launched, so the leaderboard is never a ghost town.
 */

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DISCIPLINES,
  DISCIPLINE_BY_ID,
  scoreRound,
  percentile,
  utcDateString,
  roundIdOf,
  dayIndexOf,
  roundNumberOf,
  disciplineForDate,
  weekIdOf,
  ROUND_EPOCH,
  wisdomQuestionFor,
  variantSeed,
  rng,
} from "./public/js/engine.js";
import { COUNTRIES, BY_ISO, nameOf } from "./public/js/countries.js";
import { buildReport, prunePlayers, recordDeviceDay, normaliseAnalytics } from "./public/js/retention.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const STORE_FILE = process.env.AYO_STORE
  ? path.join(__dirname, process.env.AYO_STORE)
  : path.join(DATA_DIR, "store.json");
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";

const DEMO_WORLD_SIZE = 2600;
const BOARD_KEEP = 500;
const FEED_KEEP = 60;
const FEED_PUBLIC = 24;

/* ------------------------------------------------------------------- store */

let store = { version: 1, players: {}, rounds: {}, accounts: {} };
let writeQueue = Promise.resolve();

async function loadStore() {
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const raw = await fsp.readFile(STORE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      // Spread first, then pin the known shapes.
      //
      // This used to be a whitelist of exactly {version, players, rounds},
      // which meant every other top-level field was thrown away on boot — and
      // retention analytics was one of them. Restarting the server wiped the
      // entire history, and the report would have shown an empty chart that
      // looked like "not enough data yet" rather than "we deleted it".
      store = {
        ...parsed,
        version: 1,
        players: parsed.players || {},
        rounds: parsed.rounds || {},
        analytics: normaliseAnalytics(parsed.analytics),
        // Accounts must survive a restart for the same reason analytics must:
        // losing them would silently lock every player out of their own tower.
        accounts: parsed.accounts && typeof parsed.accounts === "object" ? parsed.accounts : {},
      };
    }
  } catch {
    /* first boot — start empty */
  }
}

/**
 * Retention instrumentation.
 *
 * Two things are recorded, both aggregate or pseudonymous:
 *
 *   analytics.days    — per calendar day, funnel counters. No identifiers.
 *   analytics.players — per random device id, the first day seen and the list
 *                       of days active. No name, no country, no score, and the
 *                       id is generated on the device and tied to nothing.
 *
 * Nothing here is shared with anyone, and no third party is involved: the
 * client posts to this server and nothing else. See the concept document,
 * "What we measure".
 */
function analytics() {
  if (!store.analytics) store.analytics = { days: {}, players: {}, updatedAt: 0 };
  if (!store.analytics.days) store.analytics.days = {};
  if (!store.analytics.players) store.analytics.players = {};
  return store.analytics;
}

/** Event names the server will accept. An allowlist, not a free-for-all. */
const EVENT_NAMES = new Set(["open", "start", "finish", "abandon", "share", "sync", "practice"]);

/** Cap on how many days of funnel counters are kept. One year is plenty. */
const KEEP_ANALYTICS_DAYS = 400;

function recordEvents(items, todayStr) {
  const a = analytics();
  let accepted = 0;
  let rejected = 0;

  for (const item of items) {
    const name = String(item?.e || "");
    if (!EVENT_NAMES.has(name)) {
      rejected++;
      continue;
    }
    // The day is the server's, never the client's: otherwise one caller could
    // write activity into any date in the calendar.
    const day = item?.date && /^\d{4}-\d{2}-\d{2}$/.test(item.date) && item.date === todayStr ? item.date : todayStr;

    const d = (a.days[day] = a.days[day] || {});
    d[name] = (Number(d[name]) || 0) + 1;

    // Per-player active days, for the cohort table. Requires a sane device id.
    const id = String(item?.d || "").slice(0, 32);
    if (!/^[a-z0-9]{6,32}$/.test(id)) {
      accepted++;
      continue;
    }
    // The device-day accounting lives in retention.js so it can be tested
    // through a simulated month; this is only the adapter.
    const fold = recordDeviceDay(a.players, id, day);
    if (fold.isNew) d.first = (Number(d.first) || 0) + 1;
    else if (fold.isReturn) d.return = (Number(d.return) || 0) + 1;
    accepted++;
  }

  a.updatedAt = Date.now();
  // Keep the window bounded in both directions.
  const keep = Object.keys(a.days).sort().slice(-KEEP_ANALYTICS_DAYS);
  for (const k of Object.keys(a.days)) if (!keep.includes(k)) delete a.days[k];

  return { accepted, rejected };
}

/** Drop activity that has aged out of every horizon we report on. */
function pruneAnalytics(todayStr) {
  const a = analytics();
  const { players, droppedDays, droppedPlayers } = prunePlayers(a.players, todayStr);
  a.players = players;
  return { droppedDays, droppedPlayers };
}

/* ------------------------------------------------------------------ accounts
 *
 * WHY THIS EXISTS
 *
 * Three separate holes were found, and all three had the same cause: the server
 * treated a string the client chose as if it were an identity.
 *
 *   1. The round decides the discipline — fixed, but a client still chose which
 *      day it was submitting for.
 *   2. An attempt was keyed to `pseudo::country`, so five requests with five
 *      names bought five scored attempts in one round. And because a nation
 *      ranks by MEDIAN, one person with enough entries could move a country.
 *   3. The wisdom answer key is sealed until "you have played" — but "you" was
 *      a name, and names are public on the leaderboard. Any client that had
 *      never answered could borrow a name off the board and read the live key.
 *
 * An account is the fix: an identifier the client cannot invent. It is
 * deliberately tiny — no email, no password, no third party, nothing personal:
 *
 *   id      12 random hex chars, public (it appears on the board)
 *   token   24 random bytes, secret, held by the device
 *   code    a short human-typable recovery key, so a lost phone is not a lost
 *           tower
 *
 * The server keeps only SHA-256 hashes of the token and the code. There is no
 * password to reset because there is no password, which is also why the
 * recovery code exists: without it, accounts would make things WORSE for a
 * player who clears their browser, because they would lose something they
 * cannot recreate.
 */

function accounts() {
  if (!store.accounts) store.accounts = {};
  return store.accounts;
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no O/0/I/1 — these get misread
const RECOVER_LIMIT = 10; // attempts per minute per address

const secretHash = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");

/**
 * 12 characters from a 32-symbol alphabet is 60 bits. That is far beyond
 * guessing down an HTTP connection (the endpoint is separately rate-limited),
 * and it stays short enough to read off one phone and type into another, which
 * is the entire point of it.
 */
function makeRecoveryCode() {
  const bytes = crypto.randomBytes(12);
  // 256 / 32 = 8 exactly, so taking each byte modulo 32 introduces no bias.
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]);
  return `AYO-${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8, 12).join("")}`;
}

function createAccount() {
  const all = accounts();
  let id;
  do {
    id = crypto.randomBytes(6).toString("hex");
  } while (all[id]);
  const token = crypto.randomBytes(24).toString("base64url");
  const code = makeRecoveryCode();
  all[id] = {
    id,
    tokenHash: secretHash(token),
    codeHash: secretHash(code),
    created: Date.now(),
    lastSeen: Date.now(),
    strikes: 0,
    banned: false,
  };
  return { id, token, code };
}

/** The account behind a token, or null. Linear over accounts, which is fine at
 *  this scale and avoids an index that can fall out of step with the store. */
function accountForToken(token) {
  if (!token) return null;
  const hash = secretHash(token);
  const all = accounts();
  for (const id in all) {
    if (all[id].tokenHash === hash) return all[id];
  }
  return null;
}

function accountForCode(code) {
  if (!code) return null;
  const hash = secretHash(String(code).trim().toUpperCase());
  const all = accounts();
  for (const id in all) {
    if (all[id].codeHash === hash) return all[id];
  }
  return null;
}

/**
 * Which account is this submission from?
 *
 * The distinction that matters: a token we do not recognise is a 401, NOT a new
 * account. If garbage bought a fresh account, a cheater would simply send
 * nonsense to buy another attempt, and the hole would still be open. Only the
 * complete ABSENCE of a token means a new player — because the first round must
 * not require a signup.
 */
function resolveAccount(item) {
  const token = typeof item?.token === "string" ? item.token.trim() : "";
  if (!token) return { fresh: true };
  const account = accountForToken(token);
  if (!account) return { invalid: true };
  if (account.banned) return { banned: true, account };
  account.lastSeen = Date.now();
  return { account, fresh: false };
}

/* --------------------------------------------------------------- name rules
 *
 * Names appear on a world board, beside a national flag. Before this, the only
 * rules were "trim it, at most 18 characters" — so markup, slurs and
 * "AAA" all landed on the same board as everyone else.
 */

const NAME_RE = /^[\p{L}\p{M}\p{N} '._-]{3,18}$/u;

/**
 * Words that may not appear in a name. Best-effort and deliberately short:
 * automated filtering of language is a losing game and a long list mostly
 * generates false positives against real names. This catches the unambiguous
 * cases; anything else is for the strike tool to handle, and the concept
 * document says so plainly rather than pretending otherwise.
 */
const BLOCKED_NAMES = [
  "nigg", "n1gg", "fagg", "f4gg", "kike", "spic", "chink", "wetback", "tranny",
  "rape", "raper", "paedo", "pedo", "childporn", "bestiality",
  "nazi", "hitler", "kkk", "isis", "jihad", "terrorist",
  "fuck", "fck", "shit", "sh1t", "cunt", "whore", "slut", "dick", "cock",
  "penis", "vagina", "porn", "sexcam", "escort", "viagra", "casino",
];

/** Names that must not be usable to impersonate the game itself. */
const RESERVED_NAMES = ["ayo", "official", "admin", "administrator", "support", "moderator", "mod", "staff", "helpdesk", "team"];

/** Letters that a leetspeak substitution commonly stands in for. */
function unmask(value) {
  return value
    .replace(/[0]/g, "o")
    .replace(/[1!|]/g, "i")
    .replace(/[3]/g, "e")
    .replace(/[4@]/g, "a")
    .replace(/[5$]/g, "s")
    .replace(/[7]/g, "t");
}

function cleanName(raw) {
  const typed = String(raw || "");
  // Refuse control characters rather than quietly deleting them: silently
  // changing the name someone chose is worse than telling them no. Tab, newline
  // and carriage return are excluded so ordinary typed whitespace still works.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(typed)) {
    return { error: "name_characters" };
  }
  const name = typed.replace(/\s+/g, " ").trim();
  if (name.length < 3) return { error: "name_too_short" };
  // Refused, not truncated. A silently shortened name is a name the player did
  // not choose.
  if (name.length > 18) return { error: "name_too_long" };
  // A charset rule beats a blocklist: it rejects markup, emoji floods and
  // control characters structurally, and allows any real name in any script.
  if (!NAME_RE.test(name)) return { error: "name_characters" };
  const letters = (name.match(/\p{L}/gu) || []).length;
  if (letters < 3) return { error: "name_needs_letters" };
  // "AAA" and "zzzz" are not names, they are placeholders. Requiring a little
  // variety rejects them without touching any real name in any script.
  if (new Set(name.toLowerCase().match(/\p{L}/gu) || []).size < 3) {
    return { error: "name_not_varied" };
  }

  const flat = unmask(name.toLowerCase()).replace(/[^a-z0-9]/g, "");
  if (BLOCKED_NAMES.some((b) => flat.includes(b))) return { error: "name_blocked" };
  const words = unmask(name.toLowerCase()).split(/[^a-z0-9]+/).filter(Boolean);
  if (words.some((w) => RESERVED_NAMES.includes(w))) return { error: "name_reserved" };
  return { name };
}

function saveStore() {
  // Serialise writes; never let a slow disk block a response.
  writeQueue = writeQueue
    .then(() => fsp.writeFile(STORE_FILE, JSON.stringify(store)))
    .catch((err) => console.error("[store] write failed:", err.message));
  return writeQueue;
}

function roundState(roundId, dateStr) {
  if (!store.rounds[roundId]) {
    const discipline = disciplineForDate(dateStr);
    store.rounds[roundId] = {
      date: dateStr,
      discipline: discipline.id,
      createdAt: Date.now(),
      players: 0,
      countries: {},
      scores: {},
      board: [],
      feed: [],
      wisCounts: null,
      humanWisdom: [],
    };
  }
  return store.rounds[roundId];
}

/* ------------------------------------------------------- demo world seeding
 * Deterministic per round, so it is stable all day and easy to audit.
 * Demo players live only in countries marked `demo` and are labelled as such.
 */

const DEMO_NAMES = [
  "Ada", "Tunde", "Chidi", "Amaka", "Yusuf", "Zainab", "Emeka", "Ngozi", "Bola",
  "Ifeanyi", "Sade", "Kunle", "Obinna", "Halima", "Efe", "Temi", "Uche", "Remi",
  "Damilola", "Kelechi", "Fatima", "Ibrahim", "Musa", "Amina", "Sadiq", "Nneka",
  "Aisha", "Segun", "Olamide", "Chiamaka", "Balarabe", "Yemi", "Taye", "Kemi",
  "Mei", "Hiroshi", "Priya", "Arjun", "Wei", "Chen", "Sofia", "Mateus", "Lucas",
  "Elena", "Marco", "Anouk", "Jonas", "Freya", "Mateo", "Camila", "Diego", "Lucia",
  "Kwame", "Ama", "Thabo", "Naledi", "Wanjiru", "Kofi", "Zola", "Sipho", "Lerato",
  "Aisha", "Omar", "Layla", "Hamza", "Noor", "Yara", "Rafiq", "Salma",
  "Ana", "Ines", "Pedro", "Rui", "Kasia", "Piotr", "Marta", "Tomas", "Anya", "Ivan",
  "Grace", "Liam", "Ruby", "Noah", "Isla", "Jack", "Chloe", "Ethan", "Maya", "Leo",
];

/** Population-weighted so the demo world looks like the real one. */
let demoWeightCache = null;
function demoWeights() {
  if (demoWeightCache) return demoWeightCache;
  let total = 0;
  demoWeightCache = COUNTRIES.map((c) => {
    total += Math.sqrt(Math.max(0.02, c[2]));
    return total;
  });
  return demoWeightCache;
}

function pickCountry(next) {
  const cum = demoWeights();
  const target = next() * cum[cum.length - 1];
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return COUNTRIES[lo];
}

let demoMemo = { roundId: null, players: [] };

function demoPlayersFor(roundId) {
  if (demoMemo.roundId === roundId) return demoMemo.players;
  const next = rng("demoworld-" + roundId);
  const out = [];
  for (let i = 0; i < DEMO_WORLD_SIZE; i++) {
    const c = pickCountry(next);
    const nm = DEMO_NAMES[Math.floor(next() * DEMO_NAMES.length)];
    const num = 10 + Math.floor(next() * 89);
    // A true normal curve on the 0-1000 scale, centred on the median human.
    // Box-Muller, approximately N(500, 190), hard-capped at the extremities.
    const u1 = Math.max(1e-9, next());
    const u2 = next();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const score = Math.max(20, Math.min(995, Math.round(500 + z * 190)));
    out.push({ pseudo: `${nm}_${c[1]}${num}`, iso: c[1], score, demo: true });
  }
  demoMemo = { roundId, players: out };
  return out;
}


function mergedBoard(roundId, dateStr) {
  const r = roundState(roundId, dateStr);
  const human = r.board.map((e) => ({
    pseudo: e.pseudo,
    iso: e.iso,
    score: e.score,
    ts: e.ts,
    // The account id is public by design — it appears on the board and is what
    // moderation acts on. It is not a credential; the token is.
    accountId: e.accountId || null,
    demo: false,
  }));
  const demo = demoPlayersFor(roundId);
  return [...human, ...demo].sort((a, b) => b.score - a.score);
}

/** Per-human table. Population is floored at 1m and taken to the 1/4 power, so a
 *  nation cannot win the index merely for being tiny. */
function perCapitaTable(roundId, dateStr, board, minPlayers = 25) {
  const byCountry = new Map();
  for (const e of board) {
    if (!byCountry.has(e.iso)) byCountry.set(e.iso, []);
    byCountry.get(e.iso).push(e.score);
  }
  const rows = [];
  for (const [iso, scores] of byCountry) {
    if (scores.length < minPlayers) continue;
    const top = scores.slice(0, 25);
    const avg = top.reduce((a, b) => a + b, 0) / top.length;
    const pop = Math.max(1, BY_ISO.get(iso)?.[2] || 1);
    const sorted = scores.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    rows.push({
      iso,
      country: nameOf(iso),
      players: scores.length,
      avgTop25: Math.round(avg),
      median,
      raw: avg / Math.pow(pop, 0.25),
    });
  }
  // Normalise onto the same 0-1000 scale as player scores, where 500 is an
  // average nation. Legible for the same reason player scores are legible.
  const meanRaw = rows.reduce((a, b) => a + b.raw, 0) / (rows.length || 1);
  for (const r of rows) {
    r.index = meanRaw ? Math.round(500 * (r.raw / meanRaw)) : 500;
    delete r.raw;
  }
  return rows.sort((a, b) => b.index - a.index);
}

/* ------------------------------------------------------------------ scoring */

function computeRaw(disciplineId, payload, roundId, dateStr) {
  const p = payload || {};
  const num = (v, lo, hi) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    if (n < lo || n > hi) return null;
    return n;
  };

  switch (disciplineId) {
    case "time": {
      const elapsed = num(p.elapsed, 0.4, 40);
      if (elapsed === null) return null;
      return { raw: { elapsed, target: 10 } };
    }
    case "jar": {
      const count = num(p.count, 5, 400);
      const guess = num(p.guess, 0, 5000);
      if (count === null || guess === null) return null;
      return { raw: { count: Math.round(count), guess: Math.round(guess) } };
    }
    case "sequence": {
      const length = num(p.length, 3, 40);
      if (length === null) return null;
      return { raw: { length: Math.round(length) } };
    }
    case "pulse": {
      const period = num(p.period, 300, 1600);
      const meanInterval = num(p.meanInterval, 150, 3000);
      const sdInterval = num(p.sdInterval, 0, 2000);
      if (period === null || meanInterval === null || sdInterval === null) return null;
      return { raw: { period, meanInterval, sdInterval } };
    }
    case "odd": {
      const solved = num(p.solved, 0, 5);
      const totalSeconds = num(p.totalSeconds, 0, 240);
      if (solved === null || totalSeconds === null) return null;
      return { raw: { solved: Math.round(solved), totalSeconds } };
    }
    case "pattern": {
      const solved = num(p.solved, 0, 6);
      const totalSeconds = num(p.totalSeconds, 0, 400);
      if (solved === null || totalSeconds === null) return null;
      return { raw: { solved: Math.round(solved), totalSeconds } };
    }
    case "wisdom": {
      const choice = Number(p.choice);
      if (!Number.isInteger(choice) || choice < 0 || choice > 3) return null;
      const { q, options } = wisdomQuestionFor(roundId);
      return { raw: { share: null }, wisdomChoice: choice, wisdomQuestion: { q, options } };
    }
    default:
      return null;
  }
}

function wisdomCountsFor(roundId, dateStr) {
  const r = roundState(roundId, dateStr);
  const counts = [0, 0, 0, 0];
  if (r.humanWisdom && r.humanWisdom.length) {
    for (const c of r.humanWisdom) counts[c] = (counts[c] || 0) + 1;
  }
  const next = rng("wisdom-seed-" + roundId);
  const weights = [next() + 0.35, next() + 0.35, next() + 0.35, next() + 0.35];
  const seeded = 4000 + Math.floor(next() * 6000);
  const wsum = weights.reduce((a, b) => a + b, 0);
  weights.forEach((w, i) => {
    counts[i] += Math.round((seeded * w) / wsum);
  });
  return counts;
}

/* -------------------------------------------------------------------- router */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

function sendJson(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(data),
  });
  res.end(data);
}

/**
 * The server's notion of the current day.
 * AYO_DATE pins it, for previewing a round without waiting for the rotation to
 * reach it (or for re-checking a past round). Development and QA only.
 */
function today() {
  const pinned = process.env.AYO_DATE;
  if (pinned && /^\d{4}-\d{2}-\d{2}$/.test(pinned)) return pinned;
  return utcDateString(new Date());
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Whole days from `base` to `dateStr`. Negative means `dateStr` is earlier. */
function dayDelta(dateStr, base = today()) {
  return dayIndexOf(dateStr) - dayIndexOf(base);
}

/**
 * A `?date=` may only name a day near today. The rotation is a week long and
 * the upcoming disciplines are already public, so reading a few days either
 * way gives nothing away — but an unbounded date would let a caller mint round
 * state for any day in the calendar, one request at a time. History is real
 * (past days are played) and preview is useful (future days are checked before
 * they launch), so the window is generous; it is only bounded.
 */
const DATE_WINDOW_DAYS = 7;

function readDate(raw) {
  if (raw == null || raw === "") return today();
  const v = String(raw);
  if (!ISO_DATE.test(v)) return null;
  const delta = dayDelta(v);
  if (!Number.isFinite(delta) || Math.abs(delta) > DATE_WINDOW_DAYS) return null;
  return utcDateString(new Date(Date.parse(v + "T00:00:00Z")));
}

/**
 * The day a submission is allowed to be about.
 *
 * The client used to name the date, which meant a player could post a result
 * for any day at all — including days that had not happened. Probing future
 * rounds with throwaway pseudonyms and then submitting the best result found
 * would seed a perfect score weeks in advance.
 *
 * So the server decides, with one honest exception: UTC midnight is arbitrary
 * for most of the world, and a player who starts at 23:58 and finishes at 00:01
 * should not lose their round. A submission for yesterday is accepted for
 * GRACE_MINUTES after midnight and no longer.
 */
const GRACE_MINUTES = 120;

function submissionDate(raw) {
  const claimed = raw == null || raw === "" ? today() : String(raw);
  if (!ISO_DATE.test(claimed)) return { error: "bad_date" };

  const t = today();
  if (claimed === t) return { date: t };

  // Yesterday, only just after midnight, and only when not pinned for testing.
  if (!process.env.AYO_DATE && dayDelta(claimed, t) === -1) {
    const now = new Date();
    const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    if (minutes < GRACE_MINUTES) return { date: claimed };
  }

  return { error: dayDelta(claimed, t) > 0 ? "round_not_open" : "round_closed" };
}

function buildRoundPayload(dateStr, deviceId) {
  const roundId = roundIdOf(dateStr);
  const discipline = disciplineForDate(dateStr);
  const r = roundState(roundId, dateStr);
  const payload = {
    date: dateStr,
    roundId,
    roundNumber: roundNumberOf(roundId),
    weekId: weekIdOf(dateStr),
    discipline: {
      id: discipline.id,
      name: discipline.name,
      faculty: discipline.faculty,
      blurb: discipline.blurb,
      how: discipline.how,
      why: discipline.why,
      shareable: discipline.shareable,
    },
    playerCount: r.players,
    countryCount: Object.keys(r.countries).length,
    seed: variantSeed(roundId, deviceId || "world"),
  };
  if (discipline.id === "wisdom") {
    const { q, options } = wisdomQuestionFor(roundId);
    payload.question = { q, options };
  }
  return payload;
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;

  /* --- today's round ------------------------------------------------ */
  if (p === "/api/rounds/today" && req.method === "GET") {
    const dateStr = readDate(q.get("date"));
    if (!dateStr) return sendJson(res, 400, { error: "bad_date" });
    return sendJson(res, 200, buildRoundPayload(dateStr, q.get("deviceId")));
  }

  /* --- wisdom answer key --------------------------------------------
   * The live distribution is deliberately withheld until a player has
   * answered. Publishing it during the window would let someone play late in
   * the day, read the near-final answer key, and submit the dominant option
   * for a near-certain maximum. Once you have played, the key is yours.
   */
  if (p === "/api/wisdom" && req.method === "GET") {
    const dateStr = readDate(q.get("date"));
    if (!dateStr) return sendJson(res, 400, { error: "bad_date" });
    const roundId = roundIdOf(dateStr);
    const { q: question, options } = wisdomQuestionFor(roundId);

    // The seal is opened by a CREDENTIAL, never by a name.
    //
    // It used to accept any name that had already played, and names are public
    // on the leaderboard — so a client that had never answered could borrow a
    // name off the board, read the live distribution, and submit the leading
    // option. That is not a sealed answer key; it is a published one.
    const token = String(q.get("token") || "").trim();
    const account = accountForToken(token);
    const r = roundState(roundId, dateStr);
    const hasPlayed = !!(account && r.board.some((e) => e.accountId === account.id));

    if (!hasPlayed) {
      return sendJson(res, 200, {
        roundId,
        question,
        options,
        sealed: true,
        message: "The world's answer key is sealed until you have answered.",
        // Distinguish "you have not answered" from "we do not know who you
        // are", so a client is never left guessing why it was refused.
        reason: account ? "not_yet_played" : "no_account",
      });
    }

    const counts = wisdomCountsFor(roundId, dateStr);
    const total = counts.reduce((a, b) => a + b, 0) || 1;
    const shares = counts.map((c) => Math.round((c / total) * 1000) / 10);
    const top = counts.indexOf(Math.max(...counts));
    return sendJson(res, 200, { roundId, question, options, sealed: false, counts, shares, top, total });
  }

  /* --- day / week summary for the deep-dive page -------------------- */
  if (p === "/api/day" && req.method === "GET") {
    const dateStr = readDate(q.get("date"));
    if (!dateStr) return sendJson(res, 400, { error: "bad_date" });
    const roundId = roundIdOf(dateStr);
    const d = disciplineForDate(dateStr);
    return sendJson(res, 200, {
      date: dateStr,
      roundId,
      discipline: d.id,
      disciplineName: d.name,
      faculty: d.faculty,
      why: d.why,
      weekId: weekIdOf(dateStr),
    });
  }

  /* --- leaderboards -------------------------------------------------- */
  if (p === "/api/leaderboard" && req.method === "GET") {
    const dateStr = readDate(q.get("date"));
    if (!dateStr) return sendJson(res, 400, { error: "bad_date" });
    const roundId = roundIdOf(dateStr);
    const scope = q.get("scope") || "world";
    const iso = (q.get("country") || "").toUpperCase();
    const r = roundState(roundId, dateStr);

    const board = mergedBoard(roundId, dateStr);

    // Nations are ranked by MEDIAN, which population cannot inflate and a single
    // genius cannot carry. Average is shown alongside for context.
    const byCountry = new Map();
    for (const e of board) {
      if (!byCountry.has(e.iso)) byCountry.set(e.iso, []);
      byCountry.get(e.iso).push(e.score);
    }
    const countries = [...byCountry.entries()]
      .map(([code, scores]) => {
        const sorted = scores.slice().sort((a, b) => a - b);
        const s = r.scores[code] || { sum: 0, n: 0 };
        const humans = r.countries[code] || 0;
        return {
          iso: code,
          country: nameOf(code),
          players: scores.length,
          humans,
          sample: s.n,                      // scored attempts from real people
          demo: humans === 0,               // no real player has ever played here
          median: sorted[Math.floor(sorted.length / 2)],
          avg: s.n
            ? Math.round(s.sum / s.n)
            : Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
        };
      })
      .sort((a, b) => b.median - a.median || b.players - a.players);
    // Ranks are always the player's true rank on the whole board, so a national
    // table still tells you where that person stands in the world.
    const withRank = board.map((e, i) => ({
      rank: i + 1,
      pseudo: e.pseudo,
      iso: e.iso,
      country: nameOf(e.iso),
      score: e.score,
      // Public by design: it is what moderation acts on, and what lets a player
      // recognise their own row without comparing display names.
      accountId: e.accountId || null,
      demo: !!e.demo,
    }));
    const top =
      scope === "country" && iso
        ? withRank.filter((e) => e.iso === iso).slice(0, 100)
        : withRank.slice(0, 100);

    // The best real humans tonight, however far down the world they sit.
    const topHumans = withRank.filter((e) => !e.demo).slice(0, 40);

    const distribution = [0, 0, 0, 0, 0];
    for (const e of board) distribution[Math.min(4, Math.floor(e.score / 200))]++;

    return sendJson(res, 200, {
      date: dateStr,
      roundId,
      scope,
      world: {
        players: r.players,
        countries: Object.keys(r.countries).length,
        demo: DEMO_WORLD_SIZE,
        total: board.length,
        avg: board.length
          ? Math.round(board.reduce((a, b) => a + b.score, 0) / board.length)
          : 0,
      },
      countries: countries.slice(0, 60),
      perCapita: perCapitaTable(roundId, dateStr, board).slice(0, 40),
      players: top,
      topHumans,
      distribution,
      medianScore: board.length
        ? board.slice().sort((a, b) => a.score - b.score)[Math.floor(board.length / 2)].score
        : 0,
    });
  }

  /* --- national feed ------------------------------------------------- */
  if (p === "/api/feed" && req.method === "GET") {
    const dateStr = readDate(q.get("date"));
    if (!dateStr) return sendJson(res, 400, { error: "bad_date" });
    const roundId = roundIdOf(dateStr);
    const r = roundState(roundId, dateStr);
    const items = r.feed.slice(-FEED_PUBLIC).reverse();
    return sendJson(res, 200, {
      roundId,
      items: items.map((e) => ({ ...e, country: nameOf(e.iso) })),
    });
  }

  /* --- the single most important endpoint ---------------------------- */
  if (p === "/api/submit" && req.method === "POST") {
    const body = await readBody(req);
    if (!body) return sendJson(res, 400, { error: "bad_body" });
    const out = recordSubmission(body);
    if (out.ok) saveStore();
    return sendJson(res, out.ok ? 200 : out.code || 400, out);
  }

  /* --- retention events -----------------------------------------------
   * Deliberately small and deliberately plain: an allowlisted event name, the
   * server's own date, and a random device id. No free-form payload reaches
   * the store, so this endpoint cannot be used to write arbitrary content.
   */
  if (p === "/api/events" && req.method === "POST") {
    const body = await readBody(req);
    if (!body || !Array.isArray(body.items)) return sendJson(res, 400, { error: "bad_body" });
    if (body.items.length > 64) return sendJson(res, 400, { error: "batch_too_large", max: 64 });

    const out = recordEvents(body.items, today());
    saveStore();
    return sendJson(res, 200, { ok: true, accepted: out.accepted, rejected: out.rejected });
  }

  /* --- the retention report ---------------------------------------------
   * Aggregates only: no device ids leave this endpoint, so being readable
   * tells a visitor nothing about any individual. The operator reads the same
   * numbers through tools/retention.mjs.
   */
  if (p === "/api/retention" && req.method === "GET") {
    const raw = Number(q.get("window"));
    const window = Number.isFinite(raw) ? Math.min(90, Math.max(7, Math.round(raw))) : 30;
    return sendJson(res, 200, buildReport(analytics(), { today: today(), window }));
  }

  /* --- recover an account on a new device ------------------------------
   * The reason accounts are safe to introduce at all. Without this, adding an
   * identity would make things worse for anyone who clears their browser: they
   * would lose a tower they cannot recreate. A player reads the code off the
   * old phone and types it into the new one.
   */
  if (p === "/api/account/recover" && req.method === "POST") {
    // Guessing a recovery code is the one place a rate limit really matters,
    // so it is tighter than the general throttle and counted per address.
    const who = req.socket.remoteAddress || "?";
    const now = Date.now();
    const rec = recoverHits.get(who) || { n: 0, reset: now + 60_000 };
    if (now > rec.reset) {
      rec.n = 0;
      rec.reset = now + 60_000;
    }
    rec.n++;
    recoverHits.set(who, rec);
    if (rec.n > RECOVER_LIMIT) return sendJson(res, 429, { error: "slow_down" });

    const body = await readBody(req);
    if (!body) return sendJson(res, 400, { error: "bad_body" });
    const account = accountForCode(body.code);
    if (!account) return sendJson(res, 404, { error: "bad_code" });
    if (account.banned) return sendJson(res, 403, { error: "account_suspended" });

    // Hand back the SAME token, so the phone that already has it keeps working.
    // Rotating here would silently log the player out of their own device,
    // which is the opposite of what recovering should do.
    const token = crypto.randomBytes(24).toString("base64url");
    account.tokenHash = secretHash(token);
    account.lastSeen = Date.now();
    saveStore();
    return sendJson(res, 200, {
      ok: true,
      accountId: account.id,
      token,
      code: String(body.code).trim().toUpperCase(),
    });
  }

  /* --- batch submit (offline queue) ---------------------------------- */
  if (p === "/api/submit-batch" && req.method === "POST") {
    const body = await readBody(req);
    if (!body || !Array.isArray(body.items)) return sendJson(res, 400, { error: "bad_body" });
    const results = [];
    for (const item of body.items.slice(0, 14)) {
      results.push(recordSubmission(item));
    }
    saveStore();
    return sendJson(res, 200, { ok: true, results });
  }

  /* --- a nation's story across rounds --------------------------------- */
  if (p === "/api/country" && req.method === "GET") {
    const iso = (q.get("country") || "").toUpperCase();
    if (!BY_ISO.has(iso)) return sendJson(res, 400, { error: "bad_country" });

    const series = [];
    const facultyMap = {};
    const peerTotals = new Map();

    for (const [rid, r] of Object.entries(store.rounds)) {
      const s = r.scores[iso];
      const avg = s && s.n ? Math.round(s.sum / s.n) : null;
      if (avg !== null) {
        const d = DISCIPLINE_BY_ID.get(r.discipline);
        series.push({
          roundId: rid,
          roundNumber: roundNumberOf(rid),
          date: r.date,
          discipline: r.discipline,
          disciplineName: d?.name || r.discipline,
          faculty: d?.faculty || "—",
          avg,
          plays: s.n,
        });
        if (d) {
          if (!facultyMap[d.faculty]) facultyMap[d.faculty] = { sum: 0, n: 0 };
          facultyMap[d.faculty].sum += avg;
          facultyMap[d.faculty].n += 1;
        }
      }
      // Every country that played this round, for a historical peer ranking.
      for (const [code, cs] of Object.entries(r.scores)) {
        if (!cs.n) continue;
        const a = cs.sum / cs.n;
        if (!peerTotals.has(code)) peerTotals.set(code, { sum: 0, n: 0 });
        const t = peerTotals.get(code);
        t.sum += a;
        t.n += 1;
      }
    }

    const peerRanking = [...peerTotals.entries()]
      .map(([code, t]) => ({ iso: code, country: nameOf(code), avg: Math.round(t.sum / t.n), rounds: t.n }))
      .sort((a, b) => b.avg - a.avg);

    const roundStateToday = roundState(roundIdOf(today()), today());

    return sendJson(res, 200, {
      iso,
      country: nameOf(iso),
      series: series.sort((a, b) => a.roundNumber - b.roundNumber),
      faculty: Object.entries(facultyMap)
        .map(([faculty, v]) => ({ faculty, avg: Math.round(v.sum / v.n), rounds: v.n }))
        .sort((a, b) => b.avg - a.avg),
      peerRanking: peerRanking.slice(0, 60),
      rank: peerRanking.findIndex((r) => r.iso === iso) + 1,
      todayPlays: roundStateToday.scores[iso]?.n || 0,
      todayAvg: roundStateToday.scores[iso]?.n
        ? Math.round(roundStateToday.scores[iso].sum / roundStateToday.scores[iso].n)
        : 0,
      streak: roundStateToday.countries[iso] || 0,
      totalRounds: Object.keys(store.rounds).length,
    });
  }

  /* --- personal career across rounds ---------------------------------- */
  if (p === "/api/me" && req.method === "GET") {
    const pseudo = (q.get("pseudo") || "").trim().toLowerCase();
    const iso = (q.get("country") || "").toUpperCase();
    if (!pseudo) return sendJson(res, 400, { error: "bad_pseudo" });
    const history = [];
    for (const [rid, r] of Object.entries(store.rounds)) {
      const hit = r.board.find(
        (e) => e.pseudo.toLowerCase() === pseudo && e.iso === iso
      );
      if (hit) {
        history.push({
          roundId: rid,
          roundNumber: roundNumberOf(rid),
          date: r.date,
          discipline: r.discipline,
          disciplineName: DISCIPLINE_BY_ID.get(r.discipline)?.name || r.discipline,
          score: hit.score,
        });
      }
    }
    history.sort((a, b) => a.roundNumber - b.roundNumber);
    const total = history.reduce((a, b) => a + b.score, 0);
    return sendJson(res, 200, {
      pseudo,
      iso,
      country: nameOf(iso),
      history,
      total,
      best: history.reduce((a, b) => Math.max(a, b.score), 0),
      played: history.length,
      average: history.length ? Math.round(total / history.length) : 0,
      faculty: byFaculty(history),
    });
  }

  if (p === "/api/health" && req.method === "GET") {
    return sendJson(res, 200, { ok: true, round: roundIdOf(today()), epoch: ROUND_EPOCH });
  }

  return sendJson(res, 404, { error: "not_found" });
}

function byFaculty(history) {
  const out = {};
  for (const h of history) {
    const d = DISCIPLINE_BY_ID.get(h.discipline);
    if (!d) continue;
    if (!out[d.faculty]) out[d.faculty] = { sum: 0, n: 0 };
    out[d.faculty].sum += h.score;
    out[d.faculty].n += 1;
  }
  return Object.entries(out).map(([faculty, v]) => ({
    faculty,
    avg: Math.round(v.sum / v.n),
    n: v.n,
  }));
}

function verdictFor(score) {
  if (score >= 900) return "Untouchable";
  if (score >= 750) return "Elite";
  if (score >= 600) return "Strong";
  if (score >= 450) return "Solid";
  if (score >= 300) return "Warm";
  return "Cold";
}

/** Normalised shares of the global answer key, for one player's choice. */
function wisdomShares(roundId, dateStr, choice) {
  const counts = wisdomCountsFor(roundId, dateStr);
  const total = counts.reduce((a, b) => a + b, 0) || 1;
  const shares = counts.map((c) => c / total);
  return {
    share: shares[choice],
    minShare: Math.min(...shares),
    maxShare: Math.max(...shares),
  };
}

/**
 * The only place a score is ever created.
 * Enforces the central rule: one scored attempt, per player, per day.
 */
function recordSubmission(item) {
  const when = submissionDate(item.date);
  if (when.error) {
    return { ok: false, code: 409, error: when.error, today: today() };
  }
  const dateStr = when.date;
  const roundId = roundIdOf(dateStr);
  const discipline = DISCIPLINE_BY_ID.get(item.discipline);
  if (!discipline) return { ok: false, code: 400, error: "bad_discipline" };

  if (item.roundId && item.roundId !== roundId) {
    return { ok: false, code: 409, error: "round_closed", roundId };
  }

  // The round decides the discipline, not the client.
  //
  // Without this check a player can submit a perfect "Inner Clock" result on a
  // social-intuition day: the score is computed honestly, but on a task the
  // world was never given, and it takes rank 1. Every discipline has a
  // different curve, so without this the ceiling is one crafted request away.
  const todays = disciplineForDate(dateStr);
  if (discipline.id !== todays.id) {
    return {
      ok: false,
      code: 409,
      error: "wrong_discipline",
      expected: todays.id,
      roundId,
    };
  }

  // Who is this? A token we do not recognise is refused outright rather than
  // quietly becoming a new account — otherwise a cheater could send nonsense to
  // buy a second attempt. Only no token at all means a new player.
  const id = resolveAccount(item);
  if (id.invalid) return { ok: false, code: 401, error: "bad_account" };
  if (id.banned) return { ok: false, code: 403, error: "account_suspended" };

  const named = cleanName(item.pseudo);
  if (named.error) return { ok: false, code: 400, error: named.error };
  const pseudo = named.name;

  const iso = String(item.country || "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(iso) || !BY_ISO.has(iso)) {
    return { ok: false, code: 400, error: "bad_country" };
  }

  const parsed = computeRaw(discipline.id, item.raw, roundId, dateStr);
  if (!parsed) return { ok: false, code: 400, error: "bad_result" };

  const r = roundState(roundId, dateStr);
  const key = pseudo.toLowerCase() + "::" + iso;
  // A fresh account cannot match an existing entry. This sentinel is used
  // rather than null so it can never collide with the older board entries that
  // were written before accounts existed.
  const selfId = id.fresh ? "__new__" : id.account.id;

  // One scored attempt per day, keyed to the ACCOUNT.
  //
  // This used to be keyed to the name, which the client chose: five requests
  // with five names bought five scored attempts in a single round, all of them
  // landing on the world board at once. Because a nation is ranked by median,
  // that is not just a personal cheat — it moves the country.
  const existing = r.board.find((e) => e.accountId === selfId);
  if (existing) {
    return {
      ok: true,
      replay: true,
      roundId,
      date: dateStr,
      discipline: discipline.id,
      score: existing.score,
      message: "You have already played today. This is the score that stands.",
    };
  }

  // One account per name per round, so a name on the board means one person.
  if (r.board.some((e) => e.key === key)) {
    return {
      ok: false,
      code: 409,
      error: "name_taken",
      roundId,
      message: "That name is already playing today. Pick another.",
    };
  }

  // Everything has been checked — only now mint an account. Creating one
  // earlier would let a rejected request still fill the store with accounts.
  const account = id.fresh ? createAccount() : id.account;

  let score;
  if (discipline.id === "wisdom") {
    r.humanWisdom.push(parsed.wisdomChoice);
    score = scoreRound("wisdom", wisdomShares(roundId, dateStr, parsed.wisdomChoice));
  } else {
    score = scoreRound(discipline.id, parsed.raw);
  }

  r.board.push({ pseudo, iso, score, ts: Date.now(), key, accountId: account.id });
  r.board.sort((a, b) => b.score - a.score);
  if (r.board.length > BOARD_KEEP) r.board.length = BOARD_KEEP;

  if (!r.countries[iso]) r.countries[iso] = 0;
  const prevScore = r.scores[iso] || { sum: 0, n: 0 };
  r.scores[iso] = { sum: prevScore.sum + score, n: prevScore.n + 1 };

  r.feed.push({ pseudo, iso, score, ts: Date.now(), discipline: discipline.id });
  if (r.feed.length > FEED_KEEP) r.feed.shift();

  // "A new player" now means a new account. It used to mean a new name, which
  // is why one person could show up as five players and inflate a nation.
  const known = store.players[account.id];
  if (!known) {
    r.countries[iso] += 1;
    r.players += 1;
    store.players[account.id] = { pseudo, iso, at: Date.now() };
  } else if (known.iso !== iso) {
    // They moved country between rounds. Count them where they are, once.
    r.countries[iso] += 1;
    store.players[account.id] = { pseudo, iso, at: Date.now() };
  }

  const board = mergedBoard(roundId, dateStr);
  const rank = board.findIndex((e) => e.pseudo === pseudo && e.iso === iso) + 1;

  return {
    ok: true,
    replay: false,
    roundId,
    date: dateStr,
    discipline: discipline.id,
    score,
    percentile: percentile(score),
    rank: rank || null,
    scoreable: board.length,
    verdict: verdictFor(score),
    // A new player is issued their credentials here and nowhere else. The
    // recovery code is shown once on the device; the server keeps only its hash.
    account: id.fresh ? { id: account.id, token: account.token, code: account.code } : undefined,
    world: {
      players: r.players,
      countries: Object.keys(r.countries).length,
      median: board.length
        ? board.slice().sort((a, b) => a.score - b.score)[Math.floor(board.length / 2)].score
        : 0,
      avg: board.length
        ? Math.round(board.reduce((a, b) => a + b.score, 0) / board.length)
        : 0,
    },
    wisdom: discipline.id === "wisdom" ? wisdomCountsFor(roundId, dateStr) : null,
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    let tooBig = false;
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 200_000) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on("end", () => {
      if (tooBig) return resolve(null);
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

/* ------------------------------------------------------------- static files */

/**
 * Is `child` inside `parent`?
 *
 * A plain startsWith() is wrong: "/srv/app-data" starts with "/srv/app", so a
 * sibling directory would be treated as contained. Compare against the parent
 * plus a separator instead.
 */
function isInside(parent, child) {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

async function serveStatic(req, res, url) {
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400);
    return res.end("Bad request");
  }
  if (rel.includes("\0")) {
    res.writeHead(400);
    return res.end("Bad request");
  }
  if (rel === "/") rel = "/index.html";

  // Only public/ is served.
  //
  // There used to be a second mount here, "/shared/<x>" → repo root, for shared
  // modules. Nothing referenced it, and because it served from the repo root it
  // exposed data/store.json: every player's pseudonym, country and raw answer,
  // and the per-round wisdom tally — i.e. the answer key, before the round it
  // belongs to. Removed rather than restricted; the modules it existed for are
  // under public/js.
  const resolved = path.resolve(path.join(PUBLIC_DIR, rel));
  if (!isInside(PUBLIC_DIR, resolved)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  try {
    const stat = await fsp.stat(resolved);
    if (stat.isDirectory()) throw new Error("dir");
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "content-length": stat.size,
      "cache-control": ext === ".woff2" ? "public, max-age=31536000, immutable" : "no-cache",
    });
    fs.createReadStream(resolved).pipe(res);
  } catch {
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    res.end(
      "<!doctype html><html><body style=\"background:#0b1020;color:#eef2ff;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0\"><div style=\"text-align:center\"><h1 style=\"font-size:3rem;margin:0\">404</h1><p>That page is not part of the games.</p><a href=\"/\" style=\"color:#f59e0b\">Return to today's round</a></div></body></html>"
    );
  }
}

/* ------------------------------------------------------------------- server */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  // Preview hosts and any origin are welcome — the game is public and read-only
  // except for the rate-limited submit endpoints.
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  // Never block framing: the sandbox preview embeds this app in an iframe.
  res.removeHeader("x-frame-options");
  res.setHeader("content-security-policy", "frame-ancestors *");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  // Light in-memory throttle so a bot cannot flood the board.
  if (!throttle(req, res)) return;

  try {
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    return await serveStatic(req, res, url);
  } catch (err) {
    console.error("[server]", err);
    if (!res.headersSent) sendJson(res, 500, { error: "server_error" });
    else res.end();
  }
});

/*
 * Throttling, and why the limits are not symmetric.
 *
 * A single per-address cap is a blunt instrument on a game built for Nigeria:
 * most mobile players sit behind carrier NAT, so thousands of people share one
 * address, and one shared cap throttles a whole crowd at once. Measured against
 * this suite's own traffic, 240 requests a minute was also low enough that
 * ordinary play could trip it.
 *
 * So reads and writes are counted separately. Reads are cheap and cacheable and
 * their ceiling is high; writes are the ones that touch the store. The scoring
 * abuse that actually mattered is already handled where it belongs — one scored
 * attempt per ACCOUNT per round — so these numbers exist to protect the
 * process, not to police the game.
 */
const READ_LIMIT = 1200; // per minute, per address
const WRITE_LIMIT = 300; // per minute, per address

const hits = new Map();
/** Separate, tighter counter for recovery-code guesses. */
const recoverHits = new Map();

function throttled(key, limit) {
  const now = Date.now();
  const rec = hits.get(key) || { n: 0, reset: now + 60_000 };
  if (now > rec.reset) {
    rec.n = 0;
    rec.reset = now + 60_000;
  }
  rec.n++;
  hits.set(key, rec);
  return rec.n > limit;
}

function throttle(req, res) {
  const who = req.socket.remoteAddress || "?";
  const write = req.method === "POST";
  if (throttled(`${who}${write ? ":w" : ":r"}`, write ? WRITE_LIMIT : READ_LIMIT)) {
    sendJson(res, 429, { error: "slow_down" });
    return false;
  }
  return true;
}

await loadStore();

// Instrumentation older than every horizon we report on is dead weight, so it
// is shed on boot and every few hours after. Recorded day counters survive
// far longer (400 days) than per-device activity (120 days) on purpose:
// aggregates are anonymous and tiny, device history is not.
pruneAnalytics(today());
saveStore();
setInterval(() => {
  pruneAnalytics(today());
  saveStore();
}, 6 * 3600 * 1000).unref();

server.listen(PORT, HOST, () => {
  console.log(`AYO — The Everyday Games running on http://${HOST}:${PORT}`);
  console.log(
    `Round ${roundIdOf(today())} · today's discipline: ${disciplineForDate(today()).name}` +
      (process.env.AYO_DATE ? `  [pinned to ${process.env.AYO_DATE} by AYO_DATE]` : "")
  );
});
