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
```

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
node tools/smoke.mjs              # 33 checks: API, views, all 7 games, anti-cheat
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
  smoke.mjs                 33-check end-to-end suite (needs jsdom, test-only)
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
and a 33-check end-to-end suite.

Not yet built: accounts (identity is deliberately device-local for the prototype),
season rollups, the filmed finale production, and moderation tooling. The daily
game has no server-side dependency beyond Node and a JSON file; moving to a real
datastore is a contained change behind `recordSubmission()`.
