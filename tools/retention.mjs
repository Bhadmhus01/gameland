#!/usr/bin/env node
/**
 * AYO — retention report.
 *
 *   node tools/retention.mjs                     # report on data/store.json
 *   node tools/retention.mjs --store data/x.json # a specific store
 *   node tools/retention.mjs --window 14         # narrower window
 *   node tools/retention.mjs --json              # machine-readable
 *   node tools/retention.mjs --today 2026-10-16  # report as if on that day
 *   node tools/retention.mjs --simulate 40       # see below
 *
 * --simulate invents a cohort of honest-looking players in a SCRATCH store and
 * prints the report for it. Two reasons that exists:
 *
 *   1. The instrument can be checked before launch. A retention chart that has
 *      never been tested against known input is a decoration.
 *   2. It shows what a healthy curve looks like next to the real (empty) one,
 *      so "no data yet" is never mistaken for "no retention".
 *
 * It writes to a scratch file, never to the store you are reporting on.
 */

import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildReport, addDays, HORIZONS } from "../public/js/retention.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1] ?? true;
};
const has = (name) => argv.includes(`--${name}`);

const STORE = path.resolve(ROOT, String(flag("store", "data/store.json")));
const WINDOW = Math.min(90, Math.max(7, Number(flag("window", 30)) || 30));
const AS_JSON = has("json");
const SIMULATE = Number(flag("simulate", 0)) || 0;
// Reporting on a store that was written with AYO_DATE pinned needs the same
// pin here, or a window anchored on the real today will filter out every day
// in it and report a clean, empty, entirely wrong chart.
const PINNED_TODAY = flag("today", null);

const todayStr = (d = new Date()) =>
  PINNED_TODAY && /^\d{4}-\d{2}-\d{2}$/.test(String(PINNED_TODAY)) ? String(PINNED_TODAY) : d.toISOString().slice(0, 10);

/** Deterministic RNG, so a simulated report is reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A plausible cohort: a growing trickle of arrivals, most of whom never come
 * back, a minority who form a habit. The numbers are invented; the SHAPE is
 * what matters, because it is what the report has to be able to express.
 */
export function simulate(players = 40, days = 34) {
  const rnd = mulberry32(20261011);
  const today = todayStr();
  const start = addDays(today, -(days - 1));
  const analytics = { days: {}, players: {}, updatedAt: Date.now() };

  for (let d = 0; d < days; d++) {
    const date = addDays(start, d);
    // Every counter must exist up front: `day.first++` on a missing key is
    // `undefined++`, which is NaN, which JSON serialises as null — a silent
    // zero that looks like real data.
    const day = (analytics.days[date] = { open: 0, first: 0, return: 0, start: 0, finish: 0 });
    const arrivals = 3 + Math.floor(rnd() * 4);

    for (let i = 0; i < arrivals; i++) {
      const id = `sim${String(players++).padStart(5, "0")}`;
      analytics.players[id] = { first: date, last: date, days: [date] };
      day.open++;
      day.first++;
      // Nested on purpose: you cannot finish a round you never started, and a
      // funnel that says otherwise is a funnel nobody should trust.
      if (rnd() < 0.9) {
        day.start++;
        if (rnd() < 0.9) day.finish++;
      }
    }

    // Everyone already here: comes back with a probability that decays, then
    // floors out — a small core that plays most days.
    for (const [id, p] of Object.entries(analytics.players)) {
      if (p.first === date) continue;
      const age = (Date.parse(date) - Date.parse(p.first)) / 86400000;
      const chance = 0.16 + 0.34 * Math.exp(-age / 9);
      if (rnd() >= chance) continue;
      p.days.push(date);
      p.last = date;
      day.open++;
      day.return++;
      if (rnd() < 0.92) {
        day.start++;
        if (rnd() < 0.93) day.finish++;
      }
    }
  }
  return analytics;
}

const pct = (v) => (v === null || v === undefined ? "  —  " : `${v.toFixed(1)}%`.padStart(6));
const num = (v) => String(v).padStart(5);
const bar = (v, width = 28) => {
  if (v === null || v === undefined) return "";
  return "█".repeat(Math.max(0, Math.min(width, Math.round((v / 100) * width))));
};

async function main() {
  let data;
  let source = STORE;

  if (SIMULATE) {
    data = { analytics: simulate(SIMULATE) };
    source = `simulated · ${SIMULATE} arrivals, 34 days`;
  } else {
    try {
      data = JSON.parse(await fsp.readFile(STORE, "utf8"));
    } catch (err) {
      console.error(`Could not read ${STORE}: ${err.message}`);
      process.exitCode = 1;
      return;
    }
  }

  const report = buildReport(data.analytics || {}, { today: todayStr(), window: WINDOW });

  if (AS_JSON) {
    console.log(JSON.stringify({ source, ...report }, null, 2));
    return;
  }

  const line = "─".repeat(74);
  console.log(`\nAYO — retention report`);
  console.log(line);
  console.log(`  source      ${source}`);
  console.log(`  window      ${report.windowFrom} → ${report.today}  (${report.window} days)`);
  console.log(`  days with data  ${report.daysWithData}`);

  if (report.empty) {
    console.log(`
  NO DATA YET.

  Nothing has been played on this store, so there is no retention to report.
  That is not the same as zero retention, and the difference matters: do not
  read a flat line into it.

  To see the instrument working, and what a real curve looks like:
      node tools/retention.mjs --simulate 40
`);
    return;
  }

  /* ---- funnel ---- */
  const t = report.funnel.total;
  console.log(`\n  THE DAILY FUNNEL  (all ${report.window} days combined)\n`);
  console.log(`    opened the game            ${num(t.open)}`);
  console.log(`    ├─ first time here         ${num(t.first)}`);
  console.log(`    └─ been here before        ${num(t.return)}`);
  console.log(`    started a round            ${num(t.start)}   ${pct(t.startRate)} of opens`);
  console.log(`    finished a round           ${num(t.finish)}   ${pct(t.overallRate)} of opens, ${pct(t.completionRate)} of starts`);
  console.log(`    started but never finished ${num(t.abandon)}`);

  const last = report.funnel.rows.slice(-14);
  if (last.length > 1) {
    console.log(`\n  BY DAY (last ${last.length})\n`);
    console.log(`    date          opens  start  finish   start%  finish%`);
    for (const r of last) {
      console.log(
        `    ${r.date}  ${num(r.open)}  ${num(r.start)}  ${num(r.finish)}   ${pct(r.startRate)}  ${pct(r.completionRate)}`
      );
    }
  }

  /* ---- cohorts ---- */
  console.log(`\n  COME-BACK RATES BY ARRIVAL DAY\n`);
  console.log(`    This is the number the product lives on: of the people who first`);
  console.log(`    arrived on a day, how many were still showing up n days later?\n`);
  console.log(`    arrival       size   ${HORIZONS.map((h) => `D${h}`.padStart(6)).join(" ")}`);
  const shown = report.cohort.cohorts.slice(-14);
  for (const c of shown) {
    const cells = HORIZONS.map((h) => (c.measurable[h] ? pct(c.rates[h]) : "  n/a ")).join(" ");
    console.log(`    ${c.date}  ${num(c.size)}   ${cells}${c.small ? "   (small cohort)" : ""}`);
  }

  console.log(`\n  WEIGHTED OVERALL\n`);
  for (const h of HORIZONS) {
    const o = report.cohort.overall[h];
    if (!o.measurable) {
      console.log(`    D${String(h).padEnd(2)}  not yet measurable — that many days have not elapsed`);
      continue;
    }
    console.log(`    D${String(h).padEnd(2)}  ${pct(o.rate)}  ${bar(o.rate)}  (${o.returned}/${o.cohortSize})`);
  }

  /* ---- stickiness ---- */
  const s = report.stickiness;
  console.log(`\n  STICKINESS\n`);
  console.log(`    devices seen          ${num(s.players)}`);
  console.log(`    device-days           ${num(s.deviceDays)}`);
  console.log(`    repeat days           ${num(s.repeatDays)}   ${pct(s.stickiness)} of all activity`);
  console.log(`    days per device       ${String(s.perPlayer).padStart(6)}${s.perPlayer <= 1.05 ? "   ← nobody has come back yet" : ""}`);
  console.log(`\n${line}\n`);
}

// Only run when invoked directly, so the simulation can be imported by tests.
const isEntry = process.argv[1] && (await import("node:url")).fileURLToPath(import.meta.url) === (await import("node:path")).resolve(process.argv[1]);
if (isEntry || argv.length) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
