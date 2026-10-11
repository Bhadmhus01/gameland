# AYO — The Everyday Games

**One round a day. The same task for every human on Earth. Made in Lagos, played everywhere.**

AYO is a free, browser-based daily competition in which every country on the planet
plays the identical discipline on the same UTC day, scores roll up into national
tables that population cannot inflate, and the season ends in a live world final.

This repository contains a **working prototype** of the daily game, plus the
concept and business document behind it.

- Concept & strategy → [`docs/AYO-The-Everyday-Games.md`](docs/AYO-The-Everyday-Games.md)
- Play it → `node server.mjs` then open <http://localhost:3000>

---

## Run it

Requires Node 18+ (developed on Node 22). **Zero runtime dependencies.**

```bash
node server.mjs                  # http://localhost:3000
PORT=8080 node server.mjs        # different port
HOST=127.0.0.1 node server.mjs   # bind locally only
AYO_STORE=data/other.json node server.mjs   # use a separate data file
AYO_DATE=2026-10-13 node server.mjs         # pin the round to a chosen day (dev/QA)
```

`AYO_DATE` exists so a round can be checked without waiting for the rotation to
reach it — including past rounds, which is the only way to re-verify a day that
has already been played. In the browser, `?date=YYYY-MM-DD` does the same thing
for the client. Both are development tools: with neither set, the server decides
what "today" is, which is the normal path.

The board is never empty: the server generates a deterministic, clearly-labelled
**demo world** for territories where the game has not launched, and
`tools/seed.mjs` fills it with named demonstration players.

```bash
node tools/seed.mjs                             # seed named players (default :3000)
BASE=http://127.0.0.1:3100 node tools/seed.mjs  # against another instance
```

## Test it

```bash
npm install --no-save jsdom       # only the test needs this
node tools/smoke.mjs              # 74 checks: API, views, all 7 games, fairness, retention, identity, season, input trust, anti-cheat
BASE=http://127.0.0.1:3100 node tools/smoke.mjs
```

The suite boots the entire client in a real DOM against a live server, plays
through every screen, builds and tears down all seven disciplines, and attempts
to cheat the endpoint seven different ways. It is repeatable and safe to run
against a throwaway store:

```bash
PORT=3100 AYO_STORE=data/smoke-store.json node server.mjs &
BASE=http://127.0.0.1:3100 node tools/smoke.mjs
```

---

## How it works

### The seven faculties

One discipline per day, and each week contains all seven exactly once — so a week
is a complete decathlon of the human mind and no single talent decides a season.

| Discipline | Faculty | Format | Type |
|---|---|---|---|
| The Inner Clock | Time sense | Feel 10 seconds without a clock | A |
| The Jar | Estimation | Count a flash of grains | A |
| The Chain | Working memory | Repeat a growing symbol chain | A |
| The Pulse | Rhythm | Keep a drumbeat after the guide stops | A |
| The Odd One Out | Attention | Find the one slightly rotated shape in 64 | B |
| What Comes Next | Pattern | Deduce the rule, name the future | B |
| Think Like Earth | Social intuition | Answer, then guess what humanity answered | B |

**Type A** disciplines are physically unshareable — you cannot borrow another
person's inner clock. **Type B** disciplines are drawn per player from a private
seed, so sharing an answer is useless. Together they make a country impossible to
inflate by circulating one correct response.

### Scoring

Every discipline maps a raw measurement onto 0–1000, calibrated so that a **median
human scores ~500** and the ceiling is 1000. Curves are based on published
psychophysics (Weber fractions for numerosity, working-memory span, sensorimotor
synchronisation variability) and shipped as a versioned table in
`public/js/engine.js`. A calibration promise is published in the Fair Play screen:
at the end of each season the curves are re-fitted to live global data, and any
discipline showing unexplained regional bias is rewritten or retired in public.

### The three tables

1. **Your score** — one scored attempt per day, enforced server-side. Practice is
   unlimited and never overwrites it.
2. **Nations by median** — the exact middle player in each country. Population
   cannot inflate it; one genius cannot carry it. Only depth moves it.
3. **Per-human index** — a nation's best 25 players, divided by its population to
   the ¼ power (1000 = the average nation). Population is floored at one million so
   no nation wins merely for being tiny.

### Fairness and anti-cheat

- The browser **never** declares its own score. `/api/submit` recomputes every
  score from the raw measurement and ignores anything else the client sends.
- Inputs are range-validated before scoring; malformed or impossible results are
  refused.
- One scored attempt per day per player is enforced on the server.
- Submissions for a closed round are rejected.
- The live answer key in *Think Like Earth* stays sealed until the player has
  answered, so nobody can read a near-final tally and copy it late in the day.
- Simulated players are labelled `demo` everywhere they appear and never counted
  as humans.
- No personal data is collected beyond a nickname, a country and a score.

### The season

A season is **12 weeks — 84 rounds**. The rotation puts all seven faculties in
every week (engine invariant 3), so anyone who plays a full week has faced the
identical seven challenges as everyone else on Earth. That property is what
makes ranking a season meaningful in a way ranking single rounds is not.

```bash
curl 'localhost:3000/api/season'          # the season table, rules included
curl 'localhost:3000/api/tower?deviceId=X' # your own tower (device id, not a credential)
node tools/retention.mjs                   # a different question: do people come back
```

**The qualification rule: your best 40 rounds of 84, with a floor of 24.**

| | |
|---|---|
| Counted | your best 40 rounds by score |
| To qualify | at least 24 rounds played |
| Ranked by | season total, then the weakest counted round, then rounds played, then account id |

Both numbers are chosen against **connectivity**, not convenience:

- Requiring all 84 rounds would exclude anyone whose phone, power or data fails
  on a given day. That measures income, not skill — and it would exclude exactly
  the people this game claims to exist for.
- Summing everything played rewards grinding, and makes a single absent day a
  permanent penalty.
- Averaging everything played lets four lucky rounds beat eighty good ones.
  That is the "play once, score perfect" failure the daily board already had to
  fix once.

The honest tension is documented rather than hidden: a player who plays more
rounds has more chances to fill their best 40, so reliable data is still an
advantage in contention. It is bounded — the 41st-best round is worth nothing —
and the floor is low enough to clear on a patchy connection.

Nations rank by **median of their qualifying players**, for the same reason the
daily board does: population must not buy a place and one prodigy must not carry
a country. A nation needs 5 qualifiers before it is ranked at all, and until
then it is listed as unranked with the number still needed — never with a rank
it has not earned. **The demo world never competes**; qualifying for a televised
finale by simulation would be absurd.

Mid-season, nobody is declared qualified in week one of twelve:
`qualified` only after the season ends, `on_track` for anyone above the floor,
`at_risk` while the floor is still reachable, and `out` — with the arithmetic
shown — once it is not.

### Identity, and moderation

Three holes turned out to share one cause: the server treating a string the
client chose as if it were an identity. It chose the discipline, it chose the
day, and it chose **who it was** — which bought unlimited scored attempts in a
single round, and opened the wisdom answer key to anyone who could read a name
off the public leaderboard.

An account is the fix: an identifier the client cannot invent. It is
deliberately tiny — no email, no password, no third party, nothing personal.

| | |
|---|---|
| `id` | 12 random hex characters, **public** (it appears on the board) |
| `token` | 24 random bytes, secret, held by the device |
| `code` | a short human-typable recovery key, e.g. `AYO-GBHD-9NF3-MP2C` |

The server stores only SHA-256 hashes of the token and the code. The first score
a player submits mints the account — no signup, because a signup before the
first round is friction for nothing. `POST /api/account/recover` brings an
account to a new device from the code, which is what stops a lost phone being a
lost tower.

Two decisions carry the weight:

- **A token we do not recognise is a 401, not a new account.** If garbage bought
  a fresh account, a cheater would send nonsense to buy another attempt. Only
  the complete *absence* of a token means a new player.
- **Attempts are keyed to the account, not the name.** The old key was
  `pseudo::country`, so five requests with five names bought five scored
  attempts — and because a nation ranks by **median**, one person could move a
  country.

Names are validated where they are entered *and* on the server: a charset rule
(which rejects markup structurally rather than by list), a minimum of three
distinct letters, a short denylist, and reserved words that would let someone
impersonate the game. One name maps to one account per round, so a name on the
board means one person.

Filtering language automatically is a losing game, so the filter is
best-effort **by design** and there is a human path for the rest:

```bash
node tools/moderate.mjs --list                      # every entry, with account ids
node tools/moderate.mjs --strike "Some_Name" --reason "slur"
node tools/moderate.mjs --suspend "<name|accountId>" --reason "..."
node tools/moderate.mjs --audit                     # every action, with its reason
```

A strike removes the entry **and the aggregates it fed**, so a removed score
cannot leave a nation's median inflated. Three strikes suspend an account;
suspending also removes its entries and refuses its future submissions with
`403 account_suspended`. Every action is recorded with its reason, because a
moderation power with no record is indistinguishable from tampering.

### What is measured

One question only: **do people come back tomorrow?** Everything else is
downstream of it, so the instrument is built around that and not around vanity
numbers.

| | |
|---|---|
| `public/js/analytics.js` | client capture — batched, capped, switchable, honours Do Not Track |
| `public/js/retention.js` | the maths, pure and shared by server, tool and tests |
| `POST /api/events` | ingest — allowlisted names, server-assigned date, ≤64 per batch |
| `GET /api/retention` | the report — aggregates only, never a device id |
| `tools/retention.mjs` | the operator report, plus `--simulate` |

Recorded per calendar day: opens, first-ever devices, returning devices, rounds
started, rounds finished, rounds abandoned. Recorded per device: the day it was
first seen and the days it was active. That is all — **four fields per event**
(name, time, round, random device id), no name, no country, no score.

Privacy is structural, not a promise: there is no third party, no CDN, no
cookie and no fingerprint. The id is generated on the device and tied to
nothing. Do Not Track is honoured automatically, the player can switch counting
off in the Fair Play screen (which deletes anything queued), and the operator's
own report never contains an id.

```bash
node tools/retention.mjs                 # the report, from data/store.json
node tools/retention.mjs --json          # machine-readable
node tools/retention.mjs --simulate 40   # a scratch store, to see it working
```

`--simulate` exists because a retention chart that has never been shown known
input is a decoration. It invents a plausible cohort in a **scratch** store so
the instrument can be checked before launch, and so "no data yet" is never
mistaken for "no retention" — the report says which of the two it is.

Growth is bounded in both directions: 120 days of history per device, 20,000
devices tracked, 400 days of aggregates. The cohort horizons are 1, 7 and 30
days, and a horizon that has not yet elapsed is reported as `null` with a
reason, never as a fake 0%.

### Colour and accessibility

Colour is **never** the dimension being tested. Every shape carries a fixed
colour, so colour can only reinforce shape identity, and no discipline is decided
by it. This is enforced by test, not intention: the suite generates 720 puzzles
across all six pattern families, deletes every colour from the options, and
asserts the answer is still uniquely identifiable. The attention round uses one
colour for all 64 shapes, so rotation is the only signal.

The palette was fitted by maximising the minimum CIE76 difference across
simulated protanopia, deuteranopia and tritanopia — 28.8, where the original
palette scored 9.0 (a just-noticeable difference is ~2.3). A sixth colour was
tested and rejected: every candidate either collapsed toward blue under
protanopia or fell to ~1.4:1 contrast against the background.

| Discipline | Requires |
|---|---|
| The Inner Clock | touch |
| The Jar · The Chain | sight |
| The Pulse | touch, plus sight **or** hearing |
| The Odd One Out · What Comes Next | sight |
| Think Like Earth | reading **or** listening |

All seven are tested to build and run with audio disabled. The rhythm round
carries its beat three ways — sound, a full-width visual pulse, and vibration.
*Think Like Earth* is the one discipline whose content is language, so its
question and all four options can be read aloud on any device offering speech.
Remaining gaps — motor impairment, English-only interface text, no screen-reader
support for the visual disciplines — are documented in the concept document
rather than glossed over.

### Offline resilience

A dropped connection does not lose a round. The client queues the submission in
`localStorage` and flushes it automatically; the service worker (`public/sw.js`)
caches the entire game shell so a player on an intermittent connection can still
play today's round.

---

## Architecture

Deliberately boring: **no framework, no build step, no runtime dependencies.**

```
server.mjs                  Zero-dependency Node server: static files, API, scoring,
                            leaderboards, and the labelled demo world
public/
  index.html                Entry point (single page, five screens)
  css/app.css               The whole design system, incl. the aso-oke band motif
  js/
    engine.js               Rotation, scoring curves, wisdom bank — SHARED with server
    countries.js            196-nation roster with populations — SHARED with server
    games.js                The seven disciplines, all client-side
    views.js                Today · The World · Nigeria → The World · Fair Play · My Tower
    main.js                 App shell, tabs, data loading
    api.js                  Fetch layer + offline queue
    store.js                Local player state (localStorage)
    ui.js                   Tiny DOM helpers, toasts, sheets, confetti
  sw.js                     Service worker: play offline
  fonts/                    Self-hosted Anton + Inter (no third-party CDN, no tracking)
tools/
  seed.mjs                  Seed named demonstration players
  smoke.mjs                 74-check end-to-end suite (needs jsdom, test-only)
  color-science.mjs         CVD simulation + perceptual distance, for the palette test
data/store.json             Persisted rounds, players, boards
docs/                       Concept, strategy and business document
```

`engine.js` and `countries.js` are imported by **both** the browser and the Node
server. There is exactly one definition of the rules, and it is impossible for the
client and server to disagree about them.

### API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/rounds/today?date=&deviceId=` | Today's round, discipline, private seed |
| GET | `/api/leaderboard?date=&scope=&country=` | World, national and per-human tables |
| GET | `/api/country?country=NG` | A nation's story across all rounds |
| GET | `/api/wisdom?date=&pseudo=&country=` | The global answer key — sealed until you have answered |
| GET | `/api/feed?date=` | Live national ticker |
| GET | `/api/me?pseudo=&country=` | A player's career |
| POST | `/api/submit` | The only place a score is created |
| POST | `/api/submit-batch` | Offline queue replay |
| GET | `/api/health` | Liveness |

---

## Status

Working today: the daily loop, all seven disciplines, three leaderboards, the
national page, the Fairness Charter, career history, offline play, PWA install,
and a 74-check end-to-end suite.

Not yet built: accounts (identity is deliberately device-local for the prototype),
season rollups, the filmed finale production, and moderation tooling. The daily
game has no server-side dependency beyond Node and a JSON file; moving to a real
datastore is a contained change behind `recordSubmission()`.
