#!/usr/bin/env node
/**
 * AYO — moderation.
 *
 *   node tools/moderate.mjs --list
 *   node tools/moderate.mjs --list --round r0001
 *   node tools/moderate.mjs --strike "Some_Name" --reason "slur"
 *   node tools/moderate.mjs --suspend Some_Name --reason "ban evasion"
 *   node tools/moderate.mjs --suspend <accountId>
 *   node tools/moderate.mjs --unsuspend <accountId>
 *   node tools/moderate.mjs --audit
 *
 * WHY THIS EXISTS
 *
 * The name filter rejects markup, placeholders and the unambiguous cases, but
 * automated filtering of language is a losing game — every list long enough to
 * catch everything starts rejecting real surnames. So the filter is best-effort
 * by design, and this is what catches the rest. Without a human path to remove
 * a name from a national board, "moderation" would just be a regex and a hope.
 *
 * A strike removes the entry and adjusts the aggregates it fed, so a removed
 * score cannot leave a nation's median inflated. Every action is appended to an
 * audit log with the reason, because a moderation power with no record is
 * indistinguishable from tampering.
 *
 * IT TALKS TO THE STORE FILE DIRECTLY. Stop the server, or accept that the next
 * save from a running server may overwrite the change.
 */

import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1] ?? true;
};
const has = (name) => argv.includes(`--${name}`);

const STORE = path.resolve(ROOT, String(flag("store", "data/store.json")));
const REASON = String(flag("reason", "")).trim() || "(no reason given)";

const read = async () => JSON.parse(await fsp.readFile(STORE, "utf8"));
const write = async (store) => {
  store.moderation = store.moderation || { actions: [] };
  await fsp.writeFile(STORE, JSON.stringify(store));
};

const pad = (v, n) => String(v ?? "").padEnd(n);

/** Remove every board entry belonging to an account (or matching a name). */
function removeEntries(store, { accountId, pseudo, roundId }) {
  const removed = [];
  for (const [rid, round] of Object.entries(store.rounds || {})) {
    if (roundId && rid !== roundId) continue;
    const keep = [];
    for (const e of round.board || []) {
      const hitId = accountId && e.accountId === accountId;
      const hitName = pseudo && e.pseudo.toLowerCase() === String(pseudo).toLowerCase();
      if (!hitId && !hitName) {
        keep.push(e);
        continue;
      }
      // Undo the aggregates this entry contributed to, or a struck score would
      // leave the nation's median, average and player count inflated.
      const s = round.scores?.[e.iso];
      if (s) {
        s.sum = Math.max(0, s.sum - e.score);
        s.n = Math.max(0, s.n - 1);
        if (!s.n) delete round.scores[e.iso];
      }
      if (round.countries?.[e.iso]) {
        round.countries[e.iso] = Math.max(0, round.countries[e.iso] - 1);
        if (!round.countries[e.iso]) delete round.countries[e.iso];
      }
      round.feed = (round.feed || []).filter(
        (f) => !(f.pseudo === e.pseudo && f.iso === e.iso && f.ts === e.ts)
      );
      removed.push({ roundId: rid, pseudo: e.pseudo, iso: e.iso, score: e.score, accountId: e.accountId || null });
    }
    round.board = keep;
  }
  return removed;
}

function accountFor(store, needle) {
  const accounts = store.accounts || {};
  if (accounts[needle]) return accounts[needle];
  const lower = String(needle).toLowerCase();
  for (const acc of Object.values(accounts)) {
    // An account's name is on its board entries, not on the account record.
    for (const round of Object.values(store.rounds || {})) {
      const hit = (round.board || []).find(
        (e) => e.accountId === acc.id && e.pseudo.toLowerCase() === lower
      );
      if (hit) return acc;
    }
  }
  return null;
}

function log(store, action, detail) {
  store.moderation = store.moderation || { actions: [] };
  store.moderation.actions.push({ at: Date.now(), action, reason: REASON, ...detail });
}

async function main() {
  const store = await read();

  if (has("audit")) {
    const actions = store.moderation?.actions || [];
    if (!actions.length) {
      console.log("\n  Nothing has ever been moderated on this store.\n");
      return;
    }
    console.log(`\n  ${actions.length} moderation action(s), oldest first:\n`);
    for (const a of actions) {
      const when = new Date(a.at).toISOString().replace("T", " ").slice(0, 16);
      console.log(`   ${when}  ${pad(a.action, 10)} ${a.pseudo || a.accountId || ""}  — ${a.reason}`);
    }
    console.log("");
    return;
  }

  if (has("list")) {
    const roundId = flag("round", null);
    for (const [rid, round] of Object.entries(store.rounds || {})) {
      if (roundId && rid !== roundId) continue;
      console.log(`\n  ${rid} · ${round.date} · ${round.discipline} · ${(round.board || []).length} entries\n`);
      console.log(`    ${pad("name", 20)} ${pad("cty", 4)} ${pad("score", 6)} account`);
      for (const e of (round.board || []).slice(0, 60)) {
        const acc = e.accountId && store.accounts?.[e.accountId];
        const mark = acc?.banned ? "  [SUSPENDED]" : "";
        console.log(
          `    ${pad(e.pseudo, 20)} ${pad(e.iso, 4)} ${pad(e.score, 6)} ${(e.accountId || "—").slice(0, 12)}${mark}`
        );
      }
      if ((round.board || []).length > 60) console.log(`    … and ${round.board.length - 60} more`);
    }
    console.log("");
    return;
  }

  if (has("strike")) {
    const target = String(flag("strike"));
    const acc = accountFor(store, target);
    const removed = removeEntries(store, { pseudo: target });
    if (!removed.length) {
      console.error(`\n  No board entry matched "${target}". Nothing changed.\n`);
      process.exitCode = 1;
      return;
    }
    if (acc) {
      acc.strikes = (acc.strikes || 0) + 1;
      // Three strikes and the account is suspended. Stated here rather than
      // buried, so whoever runs the tool knows exactly what will happen.
      if (acc.strikes >= 3) acc.banned = true;
    }
    log(store, "strike", { pseudo: target, accountId: acc?.id || null, removed: removed.length, strikes: acc?.strikes ?? null });
    await write(store);
    console.log(`\n  Struck "${target}" from ${removed.length} round(s).`);
    for (const r of removed) console.log(`    ${r.roundId}: ${r.pseudo} (${r.iso}) scored ${r.score} — removed`);
    if (acc) console.log(`  Account ${acc.id} now has ${acc.strikes} strike(s)${acc.banned ? " and is SUSPENDED" : ""}.`);
    console.log(`  Reason recorded: ${REASON}\n`);
    return;
  }

  if (has("suspend") || has("unsuspend")) {
    const suspend = has("suspend");
    const target = String(flag(suspend ? "suspend" : "unsuspend"));
    const acc = accountFor(store, target);
    if (!acc) {
      console.error(`\n  No account matched "${target}". Nothing changed.\n`);
      process.exitCode = 1;
      return;
    }
    acc.banned = suspend;
    let removed = 0;
    if (suspend) removed = removeEntries(store, { accountId: acc.id }).length;
    log(store, suspend ? "suspend" : "unsuspend", { accountId: acc.id, pseudo: target, removed });
    await write(store);
    console.log(
      suspend
        ? `\n  Account ${acc.id} suspended. ${removed} entr(ies) removed. It can no longer submit.\n`
        : `\n  Account ${acc.id} reinstated. It can submit again; struck scores are not restored.\n`
    );
    return;
  }

  console.log(`
  AYO — moderation

    node tools/moderate.mjs --list [--round r0001]
    node tools/moderate.mjs --strike "<name>" --reason "..."
    node tools/moderate.mjs --suspend "<name|accountId>" --reason "..."
    node tools/moderate.mjs --unsuspend "<accountId>"
    node tools/moderate.mjs --audit
    node tools/moderate.mjs --store data/other.json ...

  A strike removes the entry and the aggregates it fed. Three strikes suspend.
  Suspending also removes the account's entries. Every action is recorded with
  its reason and can be read back with --audit.
`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
