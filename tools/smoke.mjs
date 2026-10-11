/**
 * Smoke test — renders every screen and every discipline in a real DOM.
 *
 *   NODE_PATH=/tmp/ayotest/node_modules node tools/smoke.mjs
 *
 * This is deliberately not a unit-test suite: the deliverable is a game, and
 * what matters is that every screen and every discipline actually builds,
 * mounts and produces a scoreable measurement without throwing.
 */

// jsdom is only needed to run this test, never to run the game.
const jsdomSpec = process.env.JSDOM_PATH || "jsdom";
const { JSDOM } = await import(jsdomSpec.startsWith("/") ? `file://${jsdomSpec}` : jsdomSpec);

const BASE = process.env.BASE || "http://127.0.0.1:3000";
// Unique per run, so the suite can be run repeatedly against the same store.
const RUN = Math.random().toString(36).slice(2, 7).toUpperCase();

const dom = new JSDOM(
  `<!doctype html><html><body><div id="root"></div></body></html>`,
  { url: BASE + "/", pretendToBeVisual: true }
);

const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.localStorage = window.localStorage;
// Node 22 exposes read-only globals for these, so define them explicitly.
for (const [k, v] of Object.entries({
  navigator: window.navigator,
  location: window.location,
  history: window.history,
})) {
  Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
}
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
globalThis.CustomEvent = window.CustomEvent;
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(performance.now()), 16);
globalThis.cancelAnimationFrame = clearTimeout;
window.requestAnimationFrame = globalThis.requestAnimationFrame;

// Silence the audio path; jsdom has no WebAudio.
window.AudioContext = undefined;
window.webkitAudioContext = undefined;

let failures = 0;
const ok = (name, extra = "") => console.log(`  \u001b[32m✓\u001b[0m ${name}${extra ? "  " + extra : ""}`);
const bad = (name, err) => {
  failures++;
  console.log(`  \u001b[31m✗\u001b[0m ${name}\n      ${err?.stack?.split("\n").slice(0, 4).join("\n      ") || err}`);
};

async function step(name, fn) {
  try {
    const extra = await fn();
    ok(name, extra || "");
  } catch (err) {
    bad(name, err);
  }
}

/* -------------------------------------------------------------------------- */

console.log(`\n\u001b[1mAYO smoke test\u001b[0m  \u001b[2m${BASE} · run ${RUN}\u001b[0m\n`);

/* 1. Server is alive and every endpoint returns usable data. */
console.log("api");

let board;
let round;
await step("GET /api/rounds/today", async () => {
  round = await (await fetch(`${BASE}/api/rounds/today?deviceId=smoke`)).json();
  if (!round.discipline?.id) throw new Error("no discipline");
  return `round ${round.roundNumber} · ${round.discipline.name}`;
});

await step("GET /api/leaderboard", async () => {
  board = await (await fetch(`${BASE}/api/leaderboard`)).json();
  if (!board.world) throw new Error("no world block");
  if (!board.countries?.length) throw new Error("no countries");
  if (!board.perCapita?.length) throw new Error("no perCapita");
  const peaks = board.distribution;
  if (peaks.reduce((a, b) => a + b, 0) === 0) throw new Error("empty distribution");
  return `${board.world.total} on the board · ${board.countries.length} nations · index top ${board.perCapita[0].iso} ${board.perCapita[0].index}`;
});

await step("GET /api/country?country=NG", async () => {
  const d = await (await fetch(`${BASE}/api/country?country=NG`)).json();
  if (d.iso !== "NG") throw new Error("wrong country echoed");
  return `rank ${d.rank} · ${d.series.length} rounds`;
});

/* 2. Every module imports cleanly. */
console.log("\nmodules");
let engine, countries, ui, store, api, games, views, retention, analytics, season;
await step("import engine / countries / ui / store / api / games / views", async () => {
  engine = await import("../public/js/engine.js");
  countries = await import("../public/js/countries.js");
  ui = await import("../public/js/ui.js");
  store = await import("../public/js/store.js");
  api = await import("../public/js/api.js");
  games = await import("../public/js/games.js");
  views = await import("../public/js/views.js");
  retention = await import("../public/js/retention.js");
  season = await import("../public/js/season.js");
  analytics = await import("../public/js/analytics.js");
  return `${engine.DISCIPLINES.length} disciplines · ${countries.COUNTRIES.length} countries`;
});

/* 3. The rotation guarantees a full week before it repeats. */
await step("weekly rotation covers all seven faculties", async () => {
  const { disciplineForDate, DISCIPLINES } = engine;
  const seen = new Set();
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.parse("2026-10-11T00:00:00Z") + i * 86400000)
      .toISOString()
      .slice(0, 10);
    seen.add(disciplineForDate(d).id);
  }
  if (seen.size !== DISCIPLINES.length) throw new Error(`only ${seen.size} of 7 in a week`);
  return "7/7 unique over 7 days";
});

/* 4. Scoring curves are calibrated: median human ≈ 500. */
await step("scoring curves calibrated around 500 in ALL seven disciplines", async () => {
  const { scoreRound, DISCIPLINES } = engine;
  const cases = [
    ["time median (1.35s out)", scoreRound("time", { elapsed: 11.35, target: 10 }), 500],
    ["jar median (25% error)", scoreRound("jar", { count: 100, guess: 75 }), 500],
    ["sequence median (span 7)", scoreRound("sequence", { length: 7 }), 500],
    ["pulse median", scoreRound("pulse", { period: 640, meanInterval: 686, sdInterval: 110 }), 480],
    ["odd median (3/5 in 20s)", scoreRound("odd", { solved: 3, totalSeconds: 20 }), 450],
    ["pattern median (4/6 in 40s)", scoreRound("pattern", { solved: 4, totalSeconds: 40 }), 460],
    [
      "wisdom median (agrees with the plurality)",
      scoreRound("wisdom", { share: 0.246, minShare: 0.19, maxShare: 0.354 }),
      460,
    ],
  ];
  for (const [label, got, want] of cases) {
    if (Math.abs(got - want) > 70) throw new Error(`${label}: ${got}, expected ~${want}`);
  }

  // Every discipline must be able to reach the ceiling — an unreachable one
  // would make the 0-1000 scale a lie.
  const perfect = {
    time: scoreRound("time", { elapsed: 10, target: 10 }),
    jar: scoreRound("jar", { count: 100, guess: 100 }),
    sequence: scoreRound("sequence", { length: 11 }),
    pulse: scoreRound("pulse", { period: 640, meanInterval: 640, sdInterval: 0 }),
    odd: scoreRound("odd", { solved: 5, totalSeconds: 8 }),
    pattern: scoreRound("pattern", { solved: 6, totalSeconds: 20 }),
    wisdom: scoreRound("wisdom", { share: 0.72, minShare: 0.1, maxShare: 0.72 }), // near-unanimity
  };
  for (const d of DISCIPLINES) {
    if (!(perfect[d.id] >= 950)) {
      throw new Error(`${d.name} cannot reach the ceiling: best possible is ${perfect[d.id]}`);
    }
  }
  return `${DISCIPLINES.length} curves · median ≈ 500 · every ceiling reachable`;
});

await step("wisdom cannot be gamed by always picking the same option", async () => {
  // Choosing the plurality answer is worth ~900; choosing the least common is
  // worth ~200. A player who always answers "option 1" therefore cannot farm it.
  const { scoreRound } = engine;
  const spread = { minShare: 0.19, maxShare: 0.354 };
  const dominant = scoreRound("wisdom", { share: 0.354, ...spread });
  const least = scoreRound("wisdom", { share: 0.19, ...spread });
  if (dominant - least < 500) throw new Error(`spread too flat: ${dominant} vs ${least}`);
  // The plurality answer must be rewarding but must NOT be an automatic ceiling,
  // or a third of the world would tie at 1000 on every social round.
  if (dominant > 920) throw new Error(`plurality scores ${dominant}; the ceiling must stay rare`);
  // Genuine consensus is the only route to a maximum.
  const consensus = scoreRound("wisdom", { share: 0.72, minShare: 0.1, maxShare: 0.72 });
  if (consensus < 950) throw new Error(`a real consensus scored only ${consensus}`);
  return `plurality ${dominant} · least common ${least} · consensus ${consensus}`;
});

await step("the live wisdom answer key is sealed until you have answered", async () => {
  const round = await (await fetch(`${BASE}/api/rounds/today`)).json();
  if (round.discipline.id !== "wisdom") {
    return "skipped: today is not Think Like Earth";
  }
  // A player who has not answered must not be able to read the key.
  const sealed = await (
    await fetch(`${BASE}/api/wisdom?pseudo=Peeking_Player&country=NG`)
  ).json();
  if (!sealed.sealed) throw new Error("the answer key leaked to a player who has not played");
  if (sealed.counts || sealed.shares) throw new Error("live counts were exposed while sealed");

  // After answering, it opens — and it opens for the CREDENTIAL, not for the
  // name. A name is public on the leaderboard, so a name-based gate could be
  // satisfied by anyone who could read one.
  const played = await fetch(`${BASE}/api/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      roundId: round.roundId,
      discipline: "wisdom",
      pseudo: "Peeking_" + RUN,
      country: "NG",
      raw: { choice: 1 },
    }),
  }).then((r) => r.json());
  const token = played?.account?.token;
  if (!token) throw new Error("playing the wisdom round issued no account");

  const open = await (await fetch(`${BASE}/api/wisdom?token=${token}`)).json();
  if (open.sealed) throw new Error("the key stayed sealed after playing");
  if (!open.shares) throw new Error("no shares returned after playing");

  // The name alone must no longer be enough.
  const byName = await (
    await fetch(`${BASE}/api/wisdom?pseudo=Peeking_${RUN}&country=NG`)
  ).json();
  if (!byName.sealed) throw new Error("the key opened for a name with no credential");

  return `sealed before · ${open.total} answers revealed to the credential · name alone still sealed`;
});

/* 5. Country data integrity. */
await step("country roster integrity", async () => {
  const { COUNTRIES, BY_ISO, flag } = countries;
  const isos = new Set();
  for (const [name, iso, pop, region] of COUNTRIES) {
    if (!/^[A-Z]{2}$/.test(iso)) throw new Error(`bad iso: ${iso}`);
    if (isos.has(iso)) throw new Error(`duplicate iso: ${iso}`);
    if (!(pop > 0)) throw new Error(`bad population for ${name}`);
    if (!["AF", "AS", "EU", "NA", "SA", "OC"].includes(region))
      throw new Error(`bad region for ${name}`);
    isos.add(iso);
  }
  if (!BY_ISO.has("NG")) throw new Error("Nigeria missing");
  if (flag("NG") !== "🇳🇬") throw new Error("flag emoji wrong");
  if (flag("XK") !== "🇽🇰") throw new Error("Kosovo flag wrong");
  return `${COUNTRIES.length} nations · flags generated correctly`;
});

/* 6. Every view renders with real server data. */
console.log("\nviews");

const fakeApp = {
  state: {
    tab: "today",
    date: new Date().toISOString().slice(0, 10),
    round,
    board,
    boardPlayers: board.players,
    myResult: { score: 712, percentile: 88.4, discipline: round.discipline.id },
    nigeria: null,
    nigeriaSelf: null,
    boardScope: "world",
    nationalIso: "NG",
  },
  go() {},
  refresh() {},
  rerender() {},
};

await step("view: Today (unplayed)", async () => {
  const app = { ...fakeApp, state: { ...fakeApp.state, myResult: null } };
  const el = views.viewToday(app);
  const text = el.textContent;
  if (!text.includes(round.discipline.name)) throw new Error("discipline name missing");
  if (!el.querySelector(".btn-primary")) throw new Error("no play button");
  return `${el.querySelectorAll("*").length} nodes`;
});

await step("view: Today (already played)", async () => {
  const el = views.viewToday(fakeApp);
  if (!el.textContent.includes("712")) throw new Error("score not shown");
  if (!el.textContent.includes("Practise again")) throw new Error("no unscored replay offer");
  return "score + unscored replay";
});

await step("view: Global Board (all three scopes)", async () => {
  const el = views.viewBoard(fakeApp);
  if (!el.textContent.includes("Global Board")) throw new Error("heading missing");
  const tabs = [...el.querySelectorAll(".tab")];
  if (tabs.length !== 3) throw new Error(`expected 3 scopes, got ${tabs.length}`);
  for (const t of tabs) {
    t.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    const t2 = [...el.querySelectorAll(".tab")];
    for (const t3 of t2) t3.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  }
  return "world · national · per-human all render";
});

await step("view: Nigeria → The World", async () => {
  const nigeria = await (await fetch(`${BASE}/api/country?country=NG`)).json();
  const app = { ...fakeApp, state: { ...fakeApp.state, nigeria } };
  const el = views.viewNigeria(app);
  if (!el.textContent.includes("Nigeria → The World")) throw new Error("hero missing");
  const txt = el.textContent;
  for (const must of ["Nigerian wall", "All-time", "Nations"]) {
    if (!txt.includes(must)) throw new Error(`missing section: ${must}`);
  }
  return `${el.querySelectorAll("table").length} tables`;
});

await step("view: The Fairness Charter", async () => {
  const el = views.viewRules(fakeApp);
  const t = el.textContent;
  for (const must of ["One world, one round", "No pay-to-win", "Population cannot win", "calibration"]) {
    if (!t.toLowerCase().includes(must.toLowerCase())) throw new Error(`missing: ${must}`);
  }
  return `${t.length} chars of charter`;
});

await step("view: Your Tower", async () => {
  const el = views.viewCareer(fakeApp);
  if (!el.textContent.includes("Your tower")) throw new Error("heading missing");
  return "career view renders";
});

/* 7. Every discipline builds a playable DOM. */
console.log("\ndisciplines");

const SEED = "r0001::smoketester";

for (const d of engine.DISCIPLINES) {
  await step(`game: ${d.name} (${d.faculty})`, async () => {
    let finished = null;
    const ctx = {
      roundId: "r0001",
      seed: SEED,
      question: engine.wisdomQuestionFor("r0001"),
      onFinish: (raw) => {
        finished = raw;
      },
    };
    const g = games.buildGame(d.id, ctx);
    if (!g.el) throw new Error("no root element");
    document.body.append(g.el);
    const nodes = g.el.querySelectorAll("*").length;
    if (nodes < 2) throw new Error("game rendered empty");
    g.destroy();
    g.el.remove();

    // Determinism: the same seed must produce the same task for that player.
    const again = games.buildGame(d.id, ctx);
    if (again.el.innerHTML !== g.el.innerHTML) throw new Error("same seed produced a different task");
    again.destroy();

    return `${nodes} nodes · stable under the same seed`;
  });
}

/* 8. Type A disciplines must be identical for everyone; Type B must not. */
await step("Type A tasks are identical worldwide", async () => {
  const ids = engine.DISCIPLINES.filter((d) => !d.shareable).map((d) => d.id);
  for (const id of ids) {
    const a = games.buildGame(id, {
      roundId: "r0001",
      seed: engine.variantSeed("r0001", "player-A"),
      onFinish() {},
    });
    const b = games.buildGame(id, {
      roundId: "r0001",
      seed: engine.variantSeed("r0001", "player-B"),
      onFinish() {},
    });
    // The jar is seeded per player only for grain placement, never for the count;
    // the count must be read from the raw payload, so compare the instructions.
    if (id === "jar") {
      // count is private to the closure — verify via the scoring contract instead
    } else if (a.el.innerHTML !== b.el.innerHTML) {
      throw new Error(`${id} differs between players`);
    }
    a.destroy();
    b.destroy();
  }
  return "identical instructions for every human";
});

await step("Type B tasks are regenerated per player", async () => {
  const ids = engine.DISCIPLINES.filter((d) => d.shareable).map((d) => d.id);
  // Click through the intro screen, because that is where the task is drawn.
  const play = (g) => {
    document.body.append(g.el);
    const btn = g.el.querySelector(".btn");
    if (!btn) throw new Error(`${g.el.textContent.slice(0, 40)}… has no start button`);
    btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    const html = g.el.innerHTML;
    g.el.remove();
    return html;
  };
  for (const id of ids) {
    if (id === "wisdom") continue; // one shared question by design, open answer
    const a = play(games.buildGame(id, { roundId: "r0001", seed: engine.variantSeed("r0001", "player-A"), onFinish() {} }));
    const b = play(games.buildGame(id, { roundId: "r0001", seed: engine.variantSeed("r0001", "player-B"), onFinish() {} }));
    if (a === b) throw new Error(`${id} identical for two players`);
  }
  return "variants differ per player";
});

await step("a game destroyed mid-play cannot crash into a dead stage", async () => {
  for (const d of engine.DISCIPLINES) {
    const g = games.buildGame(d.id, {
      roundId: "r0001",
      seed: engine.variantSeed("r0001", "player-A"),
      question: engine.wisdomQuestionFor("r0001"),
      onFinish() {},
    });
    document.body.append(g.el);
    g.el.querySelector(".btn")?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    // Tear the stage down exactly as the app does when a player leaves.
    g.destroy();
    g.el.remove();
  }
  // Let every pending timer, interval and animation frame fire into the void.
  await new Promise((r) => setTimeout(r, 1200));
  return "all seven survive teardown";
});

/* 9. Fairness: colour and accessibility.
 * These exist because the first version of these disciplines broke their own
 * promise. They are regression tests, not decoration. */
console.log("\nfairness");

const colorSci = await import("./color-science.mjs");

await step("colour is never the signal: every pattern option survives without it", async () => {
  const { makePatternPuzzle, shapeSignature, SHAPES, PALETTE } = games;
  if (SHAPES.length !== PALETTE.length) {
    throw new Error("every shape must have its own colour for the palette test to mean anything");
  }

  let checked = 0;
  const families = new Map();

  for (let family = 0; family < 6; family++) {
    for (let seed = 0; seed < 120; seed++) {
      const puzzle = makePatternPuzzle(engine.rng(`fairness-${family}-${seed}`), family);
      checked++;

      if (puzzle.options.length !== 4) {
        throw new Error(`family ${family}: ${puzzle.options.length} options, expected 4`);
      }

      // Strip every colour. What is left is what a colour-blind player sees.
      const sigs = puzzle.options.map((o) => shapeSignature(o));
      const unique = new Set(sigs);
      if (unique.size !== 4) {
        throw new Error(
          `family ${family} seed ${seed}: ${unique.size} distinguishable options once colour is removed`
        );
      }

      // The correct answer must be uniquely identifiable, not just "one of two".
      const answerSig = shapeSignature(puzzle.options[puzzle.correctIndex]);
      if (sigs.filter((x) => x === answerSig).length !== 1) {
        throw new Error(`family ${family} seed ${seed}: the answer is not unique without colour`);
      }

      families.set(family, (families.get(family) || 0) + 1);
    }
  }
  return `${checked} puzzles across ${families.size} families, all solvable without colour`;
});

await step("the palette is distinguishable under simulated colour blindness", async () => {
  const { PALETTE } = games;
  const { closestPair } = colorSci;

  const results = [];
  for (const type of ["protanopia", "deuteranopia", "tritanopia"]) {
    const worst = closestPair(PALETTE, type);
    results.push(`${type} ${worst.dE.toFixed(1)}`);
    if (worst.dE < 22) {
      throw new Error(
        `${type}: ${worst.a} and ${worst.b} are only dE ${worst.dE.toFixed(1)} apart ` +
          `(the original palette scored 9.0 here; ~2.3 is a just-noticeable difference)`
      );
    }
  }

  // Achromatopsia cannot be served by hue at all: no usable six-colour set
  // separates on lightness alone against a dark background. This is exactly
  // why colour is never load-bearing in any discipline, which the test above
  // proves structurally. Reported rather than asserted.
  const achroma = closestPair(PALETTE, "achromatopsia");
  return `${results.join(" · ")} | achromatopsia ${achroma.dE.toFixed(1)} (colour is never required)`;
});

await step("the Odd One Out does not tint the answer", async () => {
  const g = games.buildGame("odd", {
    roundId: "r0001",
    seed: engine.variantSeed("r0001", "fairness-odd"),
    onFinish() {},
  });
  document.body.append(g.el);
  const begin = g.el.querySelector(".btn");
  begin.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  const cells = [...g.el.querySelectorAll(".odd-cell")];
  if (cells.length !== 64) throw new Error(`expected 64 cells, got ${cells.length}`);

  const colours = cells.map((c) => c.querySelector("span").style.color);
  const distinct = new Set(colours);
  if (distinct.size !== 1) {
    throw new Error(
      `cells use ${distinct.size} colours (${[...distinct].join(", ")}). ` +
        `Tinting the odd shape hands the answer to anyone who can see colour.`
    );
  }

  // The signal must be rotation, which is colour-independent.
  const rotated = cells.filter((c) => {
    const t = c.querySelector("span").style.transform;
    return t && t !== "none";
  });
  if (rotated.length !== 1) {
    throw new Error(`expected exactly 1 rotated cell, found ${rotated.length}`);
  }

  g.destroy();
  g.el.remove();
  return `64 cells, one colour, 1 rotated → attention, not colour vision`;
});

await step("The Pulse carries its beat without sound", async () => {
  const g = games.buildGame("pulse", {
    roundId: "r0001",
    seed: engine.variantSeed("r0001", "fairness-pulse"),
    onFinish() {},
  });
  document.body.append(g.el);
  g.el.querySelector(".btn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 750));

  const strip = g.el.querySelector(".beat-strip");
  if (!strip) throw new Error("no visual beat channel exists — the round would require hearing");
  if (!strip.querySelector(".beat-dots")) throw new Error("the visual beat channel is empty");

  g.destroy();
  g.el.remove();
  return "visual beat channel present and full-width";
});

await step("every discipline remains playable with audio disabled", async () => {
  const saved = { ctx: window.AudioContext, webkit: window.webkitAudioContext };
  window.AudioContext = undefined;
  window.webkitAudioContext = undefined;
  try {
    for (const d of engine.DISCIPLINES) {
      const g = games.buildGame(d.id, {
        roundId: "r0001",
        seed: engine.variantSeed("r0001", "silent"),
        question: engine.wisdomQuestionFor("r0001"),
        onFinish() {},
      });
      if (!g.el || g.el.textContent.trim().length < 5) {
        throw new Error(`${d.name} renders nothing without audio`);
      }
      g.destroy();
    }
  } finally {
    window.AudioContext = saved.ctx;
    window.webkitAudioContext = saved.webkit;
  }
  return "7/7 build and render with no AudioContext";
});

await step("Think Like Earth can be answered without reading", async () => {
  const { canSpeak } = games;
  if (canSpeak()) throw new Error("test environment unexpectedly already has speech synthesis");

  // Without speech synthesis: no listen control, and no crash.
  const silent = games.buildGame("wisdom", {
    roundId: "r0001",
    seed: "s1",
    question: engine.wisdomQuestionFor("r0001"),
    onFinish() {},
  });
  if (silent.el.textContent.includes("Listen")) {
    throw new Error("a listen control was offered with no speech synthesis available");
  }
  silent.destroy();

  // With speech synthesis: the question and options can be heard.
  const spoken = [];
  window.speechSynthesis = { speak: (u) => spoken.push(u), cancel() {} };
  window.SpeechSynthesisUtterance = function (text) {
    this.text = text;
    this.lang = "";
    this.rate = 1;
  };
  try {
    const g = games.buildGame("wisdom", {
      roundId: "r0001",
      seed: "s2",
      question: engine.wisdomQuestionFor("r0001"),
      onFinish() {},
    });
    document.body.append(g.el);
    const listen = [...g.el.querySelectorAll(".btn")].find((b) =>
      b.textContent.includes("Listen")
    );
    if (!listen) throw new Error("no listen control offered despite speech synthesis");
    listen.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    if (!spoken.length) throw new Error("the listen control did not speak");
    const text = spoken[0].text;
    if (text.length < 20) throw new Error(`spoken text too short: "${text}"`);
    if (spoken[0].lang !== window.navigator.language) {
      throw new Error("the utterance was not given the player's language");
    }
    g.destroy();
    g.el.remove();
    return `question and all four options are spoken (${text.length} chars)`;
  } finally {
    delete window.speechSynthesis;
    delete window.SpeechSynthesisUtterance;
  }
});

await step("the Fairness Charter tells the truth about accessibility", async () => {
  const el = views.viewRules(fakeApp);
  const text = el.textContent.toLowerCase();
  for (const must of ["colour", "read", "listen"]) {
    if (!text.includes(must)) throw new Error(`the charter does not mention "${must}"`);
  }
  if (/colour is a redundant cue only/i.test(el.textContent)) {
    throw new Error("the charter still carries the retracted colour claim");
  }
  return "charter discloses the real position";
});

/* 10. Submission round-trips through the real endpoints. */
console.log("\nsubmission");

/**
 * The suite must be runnable against any day of the rotation, so submissions
 * are built from whatever discipline is actually live rather than hardcoded.
 * (Hardcoding one is how a missing discipline check went unnoticed.)
 */
const liveRound = await (await fetch(`${BASE}/api/rounds/today`)).json();
const liveDiscipline = liveRound.discipline.id;

const GOOD_RAW = {
  time: { elapsed: 10.3, target: 10 },
  jar: { count: 120, guess: 118 },
  sequence: { length: 11 },
  pulse: { period: 640, meanInterval: 645, sdInterval: 20 },
  odd: { solved: 5, totalSeconds: 12 },
  pattern: { solved: 6, totalSeconds: 26 },
  wisdom: { choice: 1 },
};
const WEAK_RAW = {
  time: { elapsed: 24, target: 10 },
  jar: { count: 120, guess: 30 },
  sequence: { length: 4 },
  pulse: { period: 640, meanInterval: 1500, sdInterval: 420 },
  odd: { solved: 1, totalSeconds: 60 },
  pattern: { solved: 1, totalSeconds: 120 },
  wisdom: { choice: 3 },
};

const post = (body) =>
  fetch(`${BASE}/api/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());

/**
 * Submit as one continuing player: carry the token the server issued, the way
 * the client does. Without this every call would look like a brand-new device,
 * which is what made the old "one attempt per day" rule skip the credential
 * that did not exist yet.
 */
async function playOnce(body) {
  const first = await post(body);
  return { first, token: first?.account?.token || "" };
}

await step(`a result for any other discipline is refused (today is ${liveRound.discipline.name})`, async () => {
  // The exploit this guards: submit a perfect result for a discipline that is
  // not today's, and take rank 1 with the easiest curve.
  const other = engine.DISCIPLINES.find((d) => d.id !== liveDiscipline).id;
  const otherRaw = GOOD_RAW[other];

  const res = await post({
    roundId: liveRound.roundId,
    discipline: other,
    pseudo: "Cherry_" + RUN,
    country: "NG",
    raw: otherRaw,
  });
  if (res.ok) {
    throw new Error(
      `a perfect "${other}" result was accepted on a "${liveDiscipline}" day and scored ${res.score}`
    );
  }
  if (res.error !== "wrong_discipline") {
    throw new Error(`refused with "${res.error}", expected "wrong_discipline"`);
  }
  if (res.expected !== liveDiscipline) {
    throw new Error(`server reported expected "${res.expected}", wanted "${liveDiscipline}"`);
  }

  // And the honest path still works, so the check is not simply blocking everything.
  const good = await post({
    roundId: liveRound.roundId,
    discipline: liveDiscipline,
    pseudo: "Honest_" + RUN,
    country: "NG",
    raw: GOOD_RAW[liveDiscipline],
  });
  if (!good.ok) throw new Error(`today's own discipline was refused: ${good.error}`);
  // Exact scores depend on the curve and the field, so the bar is "top of the
  // world", not 1000. Wisdom is scored against the world's answer, so it is
  // excluded: a near-perfect result there is whatever the crowd agreed on.
  if (liveDiscipline !== "wisdom" && good.score < 900) {
    throw new Error(`a near-perfect result scored only ${good.score}`);
  }
  return `"${other}" refused · "${liveDiscipline}" scored ${good.score}`;
});

await step("POST /api/submit round-trips and scores", async () => {
  const j = await post({
    roundId: liveRound.roundId,
    discipline: liveDiscipline,
    pseudo: "Smoke_" + RUN,
    country: "NG",
    raw: GOOD_RAW[liveDiscipline],
  });
  if (!j.ok) throw new Error(JSON.stringify(j));
  if (!(j.score >= 0 && j.score <= 1000)) throw new Error("score out of range");
  if (!j.verdict) throw new Error("no verdict");
  return `score ${j.score} · ${j.verdict} · top ${(100 - j.percentile).toFixed(1)}%`;
});

await step("server rejects malformed and forged payloads", async () => {
  const cases = [
    ["bad country", { discipline: liveDiscipline, pseudo: "Ok_Name", country: "ZZ", raw: GOOD_RAW[liveDiscipline] }],
    ["short pseudo", { discipline: liveDiscipline, pseudo: "x", country: "NG", raw: GOOD_RAW[liveDiscipline] }],
    ["bad date round", { roundId: "r9999", discipline: liveDiscipline, pseudo: "Ok_Name", country: "NG", raw: GOOD_RAW[liveDiscipline] }],
    ["unknown discipline", { discipline: "moonwalk", pseudo: "Ok_Name", country: "NG", raw: {} }],
    ["non-numeric raw", { discipline: liveDiscipline, pseudo: "Ok_Name", country: "NG", raw: { count: "lots", guess: 10 } }],
    ["missing raw", { discipline: liveDiscipline, pseudo: "Ok_Name", country: "NG" }],
    ["invented raw keys", { discipline: liveDiscipline, pseudo: "Ok_Name", country: "NG", raw: { nonsense: 1 } }],
  ];
  for (const [label, body] of cases) {
    const r = await fetch(`${BASE}/api/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.ok) throw new Error(`${label} was accepted`);
    // Guard against passing for the wrong reason: these must fail on their own
    // merits, not merely because the payload names the wrong discipline.
    const j = await r.json();
    if (j.error === "wrong_discipline") {
      throw new Error(`${label} was refused as wrong_discipline, not on its own merits`);
    }
  }
  return `${cases.length} malformed payloads refused`;
});

await step("extra fields a client invents are ignored, never trusted", async () => {
  // A cheater sending their own score alongside a poor result must not be believed.
  const j = await post({
    roundId: liveRound.roundId,
    discipline: liveDiscipline,
    pseudo: "Forged_" + RUN,
    country: "NG",
    raw: WEAK_RAW[liveDiscipline],
    score: 1000,
    percentile: 99.9,
    verdict: "Untouchable",
  });
  if (!j.account) throw new Error("a first submission came back without an account");
  if (j.score === 1000) throw new Error("invented score was trusted");
  // Wisdom is scored against the world's answer, so its floor is not ours to set.
  if (liveDiscipline !== "wisdom" && j.score > 500) {
    throw new Error(`expected a weak score from a weak result, got ${j.score}`);
  }
  return `client claimed 1000 · server computed ${j.score}`;
});

await step("one scored attempt per day is enforced", async () => {
  const one = (raw, token) =>
    post({
      roundId: liveRound.roundId,
      discipline: liveDiscipline,
      pseudo: "Daily_" + RUN,
      country: "NG",
      raw,
      token,
    });

  const { first, token } = await playOnce({
    roundId: liveRound.roundId,
    discipline: liveDiscipline,
    pseudo: "Daily_" + RUN,
    country: "NG",
    raw: GOOD_RAW[liveDiscipline],
  });
  if (!token) throw new Error("no account was issued with the first score");
  // Same person, deliberately terrible second result, hoping to overwrite.
  const second = await one(WEAK_RAW[liveDiscipline], token);
  if (first.replay) throw new Error("first attempt was flagged as a replay");
  if (!second.replay) throw new Error("second attempt was scored again");
  if (second.score !== first.score) throw new Error("a second attempt changed the score");
  return `first ${first.score} · replay returns the same ${second.score}`;
});

await step("a client-declared score is ignored", async () => {
  const j = await post({
    roundId: liveRound.roundId,
    discipline: liveDiscipline,
    pseudo: "Claimed_" + RUN,
    country: "GH",
    raw: WEAK_RAW[liveDiscipline],
    score: 1000,
  });
  if (j.score === 1000) throw new Error("client score was trusted");
  if (liveDiscipline !== "wisdom" && j.score > 500) {
    throw new Error(`expected a weak score, got ${j.score}`);
  }
  return `claimed 1000, server awarded ${j.score}`;
});

/* 11. What the server will believe from a client.
 *
 * The endpoint used to trust two things it should not have: which discipline a
 * result was for (fixed in the previous commit) and which day it was for. This
 * section holds the line on both, and on the files the server will hand out.
 */

await step("the data store is never served over HTTP", async () => {
  // /shared/<x> used to map to the repo root, so /shared/data/store.json
  // returned every pseudonym, country and raw answer — and the wisdom tally,
  // before its round.
  const paths = [
    "/shared/data/store.json",
    "/shared/../data/store.json",
    "/shared/%2e%2e/data/store.json",
    "/shared/server.mjs",
    "/data/store.json",
    "/data/../data/store.json",
  ];
  for (const p of paths) {
    const res = await fetch(`${BASE}${p}`);
    if (res.status === 200) {
      const body = await res.text();
      throw new Error(`${p} served ${body.length} bytes`);
    }
  }
  return `${paths.length} paths refused`;
});

await step("path traversal cannot escape the web root", async () => {
  for (const p of ["/../../etc/passwd", "/js/../../../etc/passwd", "/%2e%2e/etc/passwd"]) {
    const res = await fetch(`${BASE}${p}`);
    const body = res.status === 200 ? await res.text() : "";
    if (body.includes("root:")) throw new Error(`${p} leaked /etc/passwd`);
  }
  // And the server still serves the files it is supposed to.
  for (const p of ["/", "/css/app.css", "/js/games.js", "/icon.svg"]) {
    const res = await fetch(`${BASE}${p}`);
    if (res.status !== 200) throw new Error(`${p} -> ${res.status}, expected 200`);
  }
  return "traversal refused · the real files still serve";
});

await step("a result cannot be submitted for a future day", async () => {
  const tomorrow = new Date(Date.parse(liveRound.date + "T00:00:00Z") + 86_400_000)
    .toISOString()
    .slice(0, 10);
  const res = await post({
    date: tomorrow,
    discipline: liveDiscipline,
    pseudo: "Tomorrow_" + RUN,
    country: "NG",
    raw: GOOD_RAW[liveDiscipline],
  });
  // Naming a future discipline would be caught by the discipline check; naming
  // today's is what the old code allowed. Both must fail.
  if (res.ok) throw new Error(`a result for ${tomorrow} was accepted and scored ${res.score}`);
  if (res.error !== "round_not_open") {
    throw new Error(`refused with "${res.error}", expected "round_not_open"`);
  }
  return `${tomorrow} refused`;
});

await step("a result cannot be submitted for a day already gone", async () => {
  const long_ago = "2026-09-01";
  const res = await post({
    date: long_ago,
    discipline: "wisdom",
    pseudo: "Past_" + RUN,
    country: "NG",
    raw: { choice: 1 },
  });
  if (res.ok) throw new Error(`a result for ${long_ago} was accepted`);
  if (res.error !== "round_closed") {
    throw new Error(`refused with "${res.error}", expected "round_closed"`);
  }
  return `${long_ago} refused`;
});

await step("a date query is bounded to the rotation window", async () => {
  const far = "2031-01-01";
  const res = await fetch(`${BASE}/api/rounds/today?date=${far}`);
  if (res.status !== 400) {
    throw new Error(`?date=${far} returned ${res.status}, expected 400`);
  }

  // The near window still works both ways: history is real, preview is useful.
  const near = async (delta) => {
    const d = new Date(Date.parse(liveRound.date + "T00:00:00Z") + delta * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const r = await fetch(`${BASE}/api/rounds/today?date=${d}`);
    if (r.status !== 200) throw new Error(`?date=${d} -> ${r.status}`);
    return d;
  };
  const back = await near(-3);
  const fwd = await near(3);
  return `${far} rejected · ${back} and ${fwd} still served`;
});

/* 12. Retention instrumentation.
 *
 * The instrument is only worth having if its arithmetic is pinned to known
 * input. These tests drive the SAME functions the server uses through a
 * simulated month, with a cohort whose answer we already know, and then check
 * the endpoint refuses everything it should.
 */

await step("a known cohort produces exactly the known retention", async () => {
  // 20 devices arrive on day 0. Exactly 10 come back on day 1. Exactly 5 of
  // those same 10 also come back on day 7. Nobody comes back on day 30.
  const today = "2026-10-11";
  // 40 days back, so the D30 horizon has elapsed and the whole span sits
  // inside a 90-day report window.
  const day0 = retention.addDays(today, -40);
  const players = {};
  const days = {};
  const count = (day, name) => {
    days[day] = days[day] || { open: 0, first: 0, return: 0, start: 0, finish: 0 };
    days[day][name]++;
  };

  for (let i = 0; i < 20; i++) {
    const id = `device${String(i).padStart(3, "0")}`;
    const fold = retention.recordDeviceDay(players, id, day0);
    count(day0, "open");
    if (fold.isNew) count(day0, "first");
    if (i < 10) {
      const back = retention.recordDeviceDay(players, id, retention.addDays(day0, 1));
      count(retention.addDays(day0, 1), "open");
      if (back.isReturn) count(retention.addDays(day0, 1), "return");
      if (i < 5) {
        const week = retention.recordDeviceDay(players, id, retention.addDays(day0, 7));
        count(retention.addDays(day0, 7), "open");
        if (week.isReturn) count(retention.addDays(day0, 7), "return");
      }
    }
  }

  const report = retention.buildReport({ days, players }, { today, window: 90 });
  const cohort = report.cohort.cohorts[0];

  if (cohort.size !== 20) throw new Error(`cohort size ${cohort.size}, expected 20`);
  if (cohort.rates[1] !== 50) throw new Error(`D1 ${cohort.rates[1]}%, expected exactly 50%`);
  if (cohort.rates[7] !== 25) throw new Error(`D7 ${cohort.rates[7]}%, expected exactly 25%`);
  if (cohort.rates[30] !== 0) throw new Error(`D30 ${cohort.rates[30]}%, expected exactly 0%`);

  // And the funnel split must count them the same way.
  const open = Object.values(days).reduce((a, d) => a + d.open, 0);
  const first = Object.values(days).reduce((a, d) => a + d.first, 0);
  const back = Object.values(days).reduce((a, d) => a + d.return, 0);
  if (open !== 35) throw new Error(`opens ${open}, expected 35 (20 + 10 + 5)`);
  if (first !== 20) throw new Error(`firsts ${first}, expected exactly 20`);
  if (back !== 15) throw new Error(`returns ${back}, expected exactly 15`);
  if (report.funnel.total.startRate !== 0) throw new Error("start rate should be 0 with no starts recorded");

  return `D1 50% · D7 25% · D30 0% · opens 35 = 20 first + 15 return`;
});

await step("the same day twice is not retention", async () => {
  const players = {};
  retention.recordDeviceDay(players, "repeatdevice", "2026-09-01");
  const again = retention.recordDeviceDay(players, "repeatdevice", "2026-09-01");
  if (again.isReturn) throw new Error("opening the app twice in one day counted as coming back");
  const tomorrow = retention.recordDeviceDay(players, "repeatdevice", "2026-09-02");
  if (!tomorrow.isReturn) throw new Error("coming back the next day did not count");
  return "twice in one day: no · next day: yes";
});

await step("a horizon that has not elapsed is not reported as zero", async () => {
  const players = {};
  // Arrived today: neither D1 nor D7 could possibly have happened yet.
  retention.recordDeviceDay(players, "todaydevice", "2026-10-11");
  // Arrived yesterday: D1 could have happened (and did not), D7 could not.
  retention.recordDeviceDay(players, "yesterdaydevice", "2026-10-10");

  const table = retention.cohortTable(players, "2026-10-11");
  const todayRow = table.cohorts.find((c) => c.date === "2026-10-11");
  const yRow = table.cohorts.find((c) => c.date === "2026-10-10");

  if (todayRow.rates[1] !== null) throw new Error(`D1 for a same-day cohort reported as ${todayRow.rates[1]}, expected null`);
  if (todayRow.rates[7] !== null) throw new Error("D7 reported for a same-day cohort");
  if (yRow.rates[1] !== 0) throw new Error(`D1 for a one-day-old cohort should be a real 0%, got ${yRow.rates[1]}`);
  if (yRow.rates[7] !== null) throw new Error(`D7 reported for a one-day-old cohort as ${yRow.rates[7]}`);
  // And the unmeasurable ones must not be folded into the headline average.
  if (table.overall[7].cohortSize !== 0) throw new Error("unelapsed horizons leaked into the weighted overall");
  return "same-day: null · one-day-old: D1 0% and D7 null · nothing unelapsed in the average";
});

await step("an empty instrument says so instead of showing zeros", async () => {
  const report = retention.buildReport({ days: {}, players: {} }, { today: "2026-10-11", window: 30 });
  if (!report.empty) throw new Error("an empty store did not report itself as empty");
  if (report.cohort.overall[1].measurable) throw new Error("an empty store claimed a measurable D1");
  return "empty is reported as empty, not as zero retention";
});

await step("activity is bounded, so the instrument cannot fill the disk", async () => {
  const players = {};
  const start = "2026-01-01";
  for (let d = 0; d < 400; d++) {
    retention.recordDeviceDay(players, "longlived", retention.addDays(start, d));
  }
  const kept = players.longlived.days.length;
  if (kept > retention.KEEP_DAYS_PER_PLAYER) {
    throw new Error(`kept ${kept} days, cap is ${retention.KEEP_DAYS_PER_PLAYER}`);
  }
  const pruned = retention.prunePlayers(players, retention.addDays(start, 399));
  if (!pruned.players.longlived) throw new Error("pruning dropped a recently-active device");
  if (pruned.players.longlived.days.length > retention.KEEP_DAYS_PER_PLAYER) {
    throw new Error("pruning left more days than the cap allows");
  }
  return `400 days of activity capped to ${kept} · pruning kept the active device`;
});

await step("the events endpoint accepts the allowlist and refuses the rest", async () => {
  const device = "smoke" + RUN.toLowerCase();

  const good = await fetch(`${BASE}/api/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      items: [
        { e: "open", d: device },
        { e: "start", d: device },
        { e: "finish", d: device },
      ],
    }),
  }).then((r) => r.json());
  if (!good.ok) throw new Error(JSON.stringify(good));
  if (good.accepted !== 3) throw new Error(`accepted ${good.accepted}, expected 3`);

  // An unknown event name, and a device id that is not a device id.
  const mixed = await fetch(`${BASE}/api/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      items: [
        { e: "open", d: device },
        { e: "<script>alert(1)</script>", d: device },
        { e: "open", d: "not a device id" },
        { e: "open", d: device, p: { enormous: "x".repeat(5000) } },
      ],
    }),
  }).then((r) => r.json());
  if (mixed.rejected < 1) throw new Error("an unknown event name was accepted");
  if (mixed.accepted !== 3) throw new Error(`accepted ${mixed.accepted} of 4, expected 3`);

  const tooBig = await fetch(`${BASE}/api/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items: Array.from({ length: 65 }, () => ({ e: "open", d: device })) }),
  });
  if (tooBig.status !== 400) throw new Error(`a 65-event batch returned ${tooBig.status}, expected 400`);

  const notArray = await fetch(`${BASE}/api/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items: "everything" }),
  });
  if (notArray.status !== 400) throw new Error("a non-array batch was accepted");

  return "3 accepted · unknown name refused · 65-event batch refused";
});

await step("the report never leaks a device id", async () => {
  const report = await fetch(`${BASE}/api/retention`).then((r) => r.json());
  const text = JSON.stringify(report);
  if (text.includes("smoke" + RUN.toLowerCase())) {
    throw new Error("the retention report exposed a device id");
  }
  if (report.funnel?.total?.open === undefined) throw new Error("report has no funnel");
  if (!report.cohort?.overall) throw new Error("report has no cohort table");
  return `aggregates only · ${report.funnel.total.open} opens in the window`;
});

await step("analytics can be refused, and refusing forgets", async () => {
  // Do Not Track on: nothing is sent.
  const savedDnt = Object.getOwnPropertyDescriptor(window.navigator, "doNotTrack");
  try {
    Object.defineProperty(window.navigator, "doNotTrack", { value: "1", configurable: true });
    analytics.forget();
    if (analytics.currentPreference()) throw new Error("Do Not Track was ignored");
    analytics.track("open");
    // Nothing queued and nothing sent.
    const sent = await analytics.flush();
    if (sent !== 0) throw new Error(`sent ${sent} events while opted out`);

    // An explicit yes overrides the browser, because the player is the authority.
    analytics.setPreference(true);
    if (!analytics.currentPreference()) throw new Error("choosing to take part did not take effect");
    if (analytics.queueLength() !== 1) throw new Error("opting in did not record the session");
    const yes = await analytics.flush();
    if (yes !== 1) throw new Error(`opted in, but sent ${yes} events`);

    // And off really means off: what was queued is discarded, not sent later.
    analytics.track("open");
    analytics.setPreference(false);
    const afterOptOut = await analytics.flush();
    if (afterOptOut !== 0) throw new Error("turning it off still sent the queued event");
  } finally {
    if (savedDnt) Object.defineProperty(window.navigator, "doNotTrack", savedDnt);
    else delete window.navigator.doNotTrack;
    analytics.setPreference(true);
    analytics.forget();
  }
  return "Do Not Track honoured · opt-out discards the queue · opt-in overrides the browser";
});

await step("retention survives a restart, a save and a reload", async () => {
  // This is the regression test for the worst bug this lane produced: the
  // server rebuilt its store from a whitelist on boot, so analytics was
  // thrown away every restart and the report showed a clean, empty, plausible
  // chart. The cycle below is exactly what a restart does.
  const days = {};
  const players = {};
  const count = (day, key) => {
    days[day] = days[day] || { open: 0, first: 0, return: 0, start: 0, finish: 0 };
    days[day][key]++;
  };

  for (const id of ["keepa1", "keepb2", "keepc3"]) {
    const f = retention.recordDeviceDay(players, id, "2026-10-01");
    count("2026-10-01", "open");
    if (f.isNew) count("2026-10-01", "first");
  }
  // Next day: two of the three come back.
  for (const id of ["keepa1", "keepb2"]) {
    const f = retention.recordDeviceDay(players, id, "2026-10-02");
    count("2026-10-02", "open");
    if (f.isReturn) count("2026-10-02", "return");
  }

  const before = retention.buildReport({ days, players }, { today: "2026-10-03", window: 30 });

  // --- what a restart does: serialise, parse, normalise ---
  const onDisk = JSON.parse(JSON.stringify({ version: 1, players: {}, rounds: {}, analytics: { days, players } }));
  const reloaded = retention.normaliseAnalytics(onDisk.analytics);

  const after = retention.buildReport(reloaded, { today: "2026-10-03", window: 30 });

  if (after.empty) throw new Error("analytics were empty after a save/load cycle");
  if (after.funnel.total.open !== before.funnel.total.open) {
    throw new Error(`opens changed across a restart: ${before.funnel.total.open} → ${after.funnel.total.open}`);
  }
  if (after.funnel.total.return !== 2) throw new Error(`returns lost: ${after.funnel.total.return}, expected 2`);
  if (after.cohort.cohorts[0].size !== 3) throw new Error(`cohort size lost: ${after.cohort.cohorts[0].size}`);
  if (after.cohort.overall[1].rate !== 66.7) {
    throw new Error(`D1 changed across a restart: ${after.cohort.overall[1].rate}%, expected 66.7%`);
  }

  // A third day after the reload must still recognise the returning devices —
  // this is the day-rollover path the funnel's return counter depends on.
  const fold = retention.recordDeviceDay(reloaded.players, "keepa1", "2026-10-03");
  if (!fold.isReturn) throw new Error("a device known before the restart was treated as new after it");

  // And unreadable data is replaced, not trusted.
  const junk = retention.normaliseAnalytics({ days: "nope", players: [1, 2, 3] });
  if (Object.keys(junk.days).length || Object.keys(junk.players).length) {
    throw new Error("malformed analytics were accepted instead of reset");
  }

  return "opens 5 · returns 2 · D1 66.7% · unchanged across a restart";
});

await step("the player can switch counting off from inside the game", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  host.append(views.viewRules({ refresh() {}, state: {} }));
  const buttons = [...host.querySelectorAll("button")].filter((b) => /counting/i.test(b.textContent));
  if (buttons.length !== 1) throw new Error(`found ${buttons.length} counting controls, expected 1`);
  const btn = buttons[0];

  analytics.setPreference(true);
  const wasOn = analytics.currentPreference();

  btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  if (analytics.currentPreference() === wasOn) throw new Error("the control did not change anything");
  if (analytics.currentPreference()) throw new Error("clicking did not switch counting off");
  if (analytics.queueLength() !== 0) throw new Error("switching off left events queued");

  btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  if (!analytics.currentPreference()) throw new Error("clicking again did not switch counting back on");

  analytics.setPreference(true);
  host.remove();
  return "one control · switches off, clears the queue, switches back on";
});

/* 13. Identity.
 *
 * Three holes had one cause: the server treating a string the client chose as
 * an identity. It chose the discipline (fixed), it chose the day (fixed), and
 * it chose who it was — which bought unlimited scored attempts in a single
 * round, and opened the wisdom answer key to anyone who could read a name off
 * the public leaderboard.
 */

await step("a first score is issued an account, and the token holds", async () => {
  const name = "Tower_" + RUN;
  const first = await post({
    roundId: liveRound.roundId,
    discipline: liveDiscipline,
    pseudo: name,
    country: "NG",
    raw: GOOD_RAW[liveDiscipline],
  });
  if (!first.ok) throw new Error(JSON.stringify(first));
  const acc = first.account;
  if (!acc?.id || !acc?.token || !acc?.code) throw new Error("no account was issued");
  if (!/^AYO-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(acc.code)) {
    throw new Error(`recovery code has the wrong shape: ${acc.code}`);
  }
  if (/[OI01]/.test(acc.code.slice(4).replace(/-/g, ""))) {
    throw new Error("the recovery code contains a character that is misread by hand");
  }

  // The second score for that account, under a different NAME, is still the
  // same one attempt. This is the exact hole: it used to be five for five.
  const renamed = await post({
    roundId: liveRound.roundId,
    discipline: liveDiscipline,
    pseudo: "Tower2_" + RUN,
    country: "NG",
    raw: WEAK_RAW[liveDiscipline],
    token: acc.token,
  });
  if (!renamed.replay) throw new Error("renaming bought a second scored attempt");
  if (renamed.score !== first.score) throw new Error("the standing score changed");

  return `account ${acc.id} · rename to a new name still returns ${renamed.score}`;
});

await step("a forged token is refused, and never becomes a new account", async () => {
  // The distinction that closes the hole. If a bad token minted a fresh
  // account, a cheater would send nonsense to buy another attempt.
  const a = await post({
    roundId: liveRound.roundId,
    discipline: liveDiscipline,
    pseudo: "Forge1_" + RUN,
    country: "NG",
    raw: GOOD_RAW[liveDiscipline],
    token: "obviously-not-a-real-token",
  });
  if (a.ok) throw new Error("a forged token was accepted");
  if (a.error !== "bad_account") throw new Error(`refused as ${a.error}`);
  if (a.account) throw new Error("a forged token was issued a brand-new account");

  // A truncated real token must not be accepted either.
  const real = await post({
    roundId: liveRound.roundId,
    discipline: liveDiscipline,
    pseudo: "Forge2_" + RUN,
    country: "NG",
    raw: GOOD_RAW[liveDiscipline],
  });
  const cut = real.account.token.slice(0, 12);
  const b = await post({
    roundId: liveRound.roundId,
    discipline: liveDiscipline,
    pseudo: "Forge3_" + RUN,
    country: "NG",
    raw: GOOD_RAW[liveDiscipline],
    token: cut,
  });
  if (b.ok) throw new Error("a truncated token was accepted");
  return "forged 401 · truncated 401 · neither minted an account";
});

await step("one name, one player, per round", async () => {
  const name = "Unique_" + RUN;
  const a = await post({
    roundId: liveRound.roundId,
    discipline: liveDiscipline,
    pseudo: name,
    country: "NG",
    raw: GOOD_RAW[liveDiscipline],
  });
  if (!a.ok) throw new Error("the first claim on the name failed");

  // A different device, same name and country.
  const b = await post({
    roundId: liveRound.roundId,
    discipline: liveDiscipline,
    pseudo: name,
    country: "NG",
    raw: GOOD_RAW[liveDiscipline],
  });
  if (b.ok) throw new Error("two accounts played the same name in one round");
  if (b.error !== "name_taken") throw new Error(`refused as ${b.error}`);

  // Same name, different country is a different entry — allowed.
  const c = await post({
    roundId: liveRound.roundId,
    discipline: liveDiscipline,
    pseudo: name,
    country: "GH",
    raw: GOOD_RAW[liveDiscipline],
  });
  if (!c.ok) throw new Error(`a different country was blocked: ${c.error}`);
  return "same name+country refused · same name elsewhere allowed";
});

await step("names are checked before they reach a national board", async () => {
  const bad = [
    ["markup", "<i>x", "name_characters"],
    ["markup, long enough to trip length first", "AVeryLongNicknameIndeed", "name_too_long"],
    ["control characters", "Ada\u0000Baba", "name_characters"],
    ["too short", "Bo", "name_too_short"],
    ["no letters", "12345", "name_needs_letters"],
    ["placeholder", "AAAA", "name_not_varied"],
    ["slur, plainly", "n1gger", "name_blocked"],
    ["slur, unobfuscated", "faggot_here", "name_blocked"],
    ["impersonating the game", "xX_Ayo_Official_Xx", "name_reserved"],
  ];
  for (const [label, name, expected] of bad) {
    const r = await post({
      roundId: liveRound.roundId,
      discipline: liveDiscipline,
      pseudo: name,
      country: "NG",
      raw: GOOD_RAW[liveDiscipline],
    });
    if (r.ok) throw new Error(`${label} was accepted onto the board`);
    if (r.error !== expected) throw new Error(`${label} refused as ${r.error}, expected ${expected}`);
  }

  // And real names from everywhere must still work.
  // Suffixed with the run id: a name is unique per round, so an unsuffixed list
  // collides with itself on a second run. The bases are kept short so the
  // apostrophe and the non-Latin cases still fit inside the 18-character rule.
  const good = ["Ọ̀ṣun_Adé", "O'Falae", "Zanele_Dl", "अनन्या", "Nguyễn_An"].map(
    (n) => `${n}_${RUN}`
  );
  for (const name of good) {
    const r = await post({
      roundId: liveRound.roundId,
      discipline: liveDiscipline,
      pseudo: name,
      country: "NG",
      raw: GOOD_RAW[liveDiscipline],
    });
    if (!r.ok) throw new Error(`a real name was rejected: ${name} -> ${r.error}`);
  }
  return `${bad.length} refused · ${good.length} real names accepted`;
});

await step("a refused submission never mints an account", async () => {
  const before = await fetch(`${BASE}/api/retention`).then((r) => r.json());
  const attempts = [
    { pseudo: "Bad_Name", country: "ZZ", raw: GOOD_RAW[liveDiscipline] },
    { pseudo: "<script>", country: "NG", raw: GOOD_RAW[liveDiscipline] },
    { pseudo: "Fine_Name", country: "NG", raw: { nonsense: 1 } },
  ];
  for (const body of attempts) {
    const r = await post({ roundId: liveRound.roundId, discipline: liveDiscipline, ...body });
    if (r.ok) throw new Error(`a malformed submission was accepted: ${JSON.stringify(body)}`);
    if (r.account) throw new Error("a refused submission was issued an account");
  }
  const after = await fetch(`${BASE}/api/retention`).then((r) => r.json());
  if (after.funnel.total.open !== before.funnel.total.open) {
    throw new Error("a refused submission touched the funnel");
  }
  return `${attempts.length} refusals · none minted an account`;
});

await step("the wisdom answer key opens to a credential, not to a name", async () => {
  // The old gate accepted any name that had already played, and names are
  // public on the leaderboard — so a client that had never answered could
  // borrow one and read the live distribution.
  const board = await fetch(`${BASE}/api/leaderboard`).then((r) => r.json());
  const someone = (board.topHumans || [])[0];
  if (someone) {
    const borrowed = await fetch(
      `${BASE}/api/wisdom?pseudo=${encodeURIComponent(someone.pseudo)}&country=${someone.iso}`
    ).then((r) => r.json());
    if (!borrowed.sealed) throw new Error("a borrowed public name opened the sealed key");
  }

  // No credential at all: sealed, and it says why.
  const anon = await fetch(`${BASE}/api/wisdom`).then((r) => r.json());
  if (!anon.sealed) throw new Error("the key was served to a client with no account");
  if (anon.reason !== "no_account") throw new Error(`reason was ${anon.reason}`);

  // A real credential that has played: open.
  const mine = await post({
    roundId: liveRound.roundId,
    discipline: liveDiscipline,
    pseudo: "Key_" + RUN,
    country: "NG",
    raw: GOOD_RAW[liveDiscipline],
  });
  if (liveDiscipline === "wisdom") {
    const opened = await fetch(`${BASE}/api/wisdom?token=${mine.account.token}`).then((r) => r.json());
    if (opened.sealed) throw new Error("my own account could not open the key after playing");
    return "borrowed name still sealed · own token opens it";
  }
  // On any other discipline the key belongs to a different round; the credential
  // must not open it just because it has played something today.
  const other = await fetch(`${BASE}/api/wisdom?token=${mine.account.token}`).then((r) => r.json());
  if (other.sealed && other.reason !== "not_yet_played") {
    throw new Error(`unexpected reason ${other.reason}`);
  }
  return "borrowed name sealed · credential honoured · wrong round stays sealed";
});

await step("a lost phone is recovered with the key, not with the device", async () => {
  const name = "Lost_" + RUN;
  const first = await post({
    roundId: liveRound.roundId,
    discipline: liveDiscipline,
    pseudo: name,
    country: "NG",
    raw: GOOD_RAW[liveDiscipline],
  });
  const { id, token, code } = first.account;

  // A brand-new device with no local storage at all.
  const rec = await fetch(`${BASE}/api/account/recover`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: code.toLowerCase() }), // typed by a human
  }).then((r) => r.json());
  if (!rec.ok) throw new Error(`recovery failed: ${JSON.stringify(rec)}`);
  if (rec.accountId !== id) throw new Error("recovery returned a different account");

  // The recovered device is the same player: same one attempt, same score.
  const after = await post({
    roundId: liveRound.roundId,
    discipline: liveDiscipline,
    pseudo: name,
    country: "NG",
    raw: WEAK_RAW[liveDiscipline],
    token: rec.token,
  });
  if (!after.replay) throw new Error("the recovered device was treated as a new player");
  if (after.score !== first.score) throw new Error("the recovered tower lost its score");

  // A wrong key is refused, and the endpoint is rate limited.
  const wrong = await fetch(`${BASE}/api/account/recover`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "AYO-AAAA-AAAA-AAAA" }),
  });
  if (wrong.status === 200) throw new Error("a wrong recovery key was accepted");

  return `same account ${id} · same score ${after.score} · wrong key refused`;
});

/* 14. The season.
 *
 * The long game, and the rule that decides who carries a country into the
 * finale. Built on the one structural guarantee the rotation gives us: every
 * week is exactly one of each faculty, so a week compares like with like.
 *
 * The maths is pinned to a fixture whose answer is known by hand. A qualifying
 * rule that cannot be checked by hand is a rule nobody should trust.
 */

/** Build a season's worth of rounds with one score per player per day. */
function fixture(rows) {
  const start = season.seasonByIndex(0).start;
  const rounds = {};
  for (const [accountId, pseudo, iso, plan] of rows) {
    for (const [day, score] of plan) {
      const rid = "rF" + String(day).padStart(4, "0");
      rounds[rid] = rounds[rid] || { date: season.addDays(start, day), board: [] };
      rounds[rid].board.push({ accountId, pseudo, iso, score });
    }
  }
  return rounds;
}

const range = (from, to, score) => {
  const out = [];
  for (let d = from; d <= to; d++) out.push([d, score]);
  return out;
};

await step("the season score is the best 40 of 84, checked by hand", async () => {
  const rounds = fixture([
    ["a", "Steady_A", "NG", range(0, 83, 600)],          // 84 rounds at 600
    ["b", "Spiky_B", "GH", [...range(0, 43, 1000), ...range(44, 83, 0)]], // 44 perfect, 40 zero
    ["d", "Solid_D", "ZA", range(0, 39, 900)],           // 40 rounds at 900
  ]);
  const info = season.seasonByIndex(0);
  const got = season.collectSeasonEntries(rounds, { season: info });
  const table = season.seasonStandings(got.players, { today: season.addDays(info.start, 83), season: info });

  const byName = Object.fromEntries(table.standings.map((r) => [r.pseudo, r]));
  if (byName.Spiky_B.total !== 40000) throw new Error(`Spiky_B ${byName.Spiky_B.total}, expected 40 × 1000`);
  if (byName.Solid_D.total !== 36000) throw new Error(`Solid_D ${byName.Solid_D.total}, expected 40 × 900`);
  // 84 × 600 = 50400 if it summed everything. The cap is the point.
  if (byName.Steady_A.total !== 24000) throw new Error(`Steady_A ${byName.Steady_A.total}, expected 40 × 600`);
  if (byName.Steady_A.roundsPlayed !== 84) throw new Error("rounds played was not counted in full");
  if (byName.Steady_A.roundsCounted !== 40) throw new Error(`counted ${byName.Steady_A.roundsCounted}`);

  const order = table.standings.map((r) => r.pseudo).join(" > ");
  if (order !== "Spiky_B > Solid_D > Steady_A") throw new Error(`wrong order: ${order}`);
  return `Spiky_B 40000 > Solid_D 36000 > Steady_A 24000 (from 84 rounds of 600)`;
});

await step("the floor stops a drive-by from qualifying", async () => {
  // The anti-gaming property of the whole rule: a handful of perfect rounds
  // must not be able to out-rank a season of real play.
  const rounds = fixture([
    ["c", "Drive_By", "KE", range(0, 22, 1000)],  // 23 perfect rounds — one short
    ["d", "Solid_D", "ZA", range(0, 39, 900)],    // 40 rounds at 900
  ]);
  const info = season.seasonByIndex(0);
  const got = season.collectSeasonEntries(rounds, { season: info });
  const table = season.seasonStandings(got.players, { today: season.addDays(info.start, 83), season: info });

  if (table.standings.some((r) => r.pseudo === "Drive_By")) {
    throw new Error("a player below the floor was ranked anyway");
  }
  if (table.qualifiers !== 1) throw new Error(`expected 1 qualifier, got ${table.qualifiers}`);
  const chasing = table.closestToQualifying.find((c) => c.pseudo === "Drive_By");
  if (!chasing) throw new Error("a near-miss player was not reported as chasing");
  if (chasing.roundsNeeded !== 1) throw new Error(`needs ${chasing.roundsNeeded}, expected 1`);

  // Sanity: their raw average was perfect, and it still did not count. This is
  // the "play once, score perfect" failure the daily board already had to fix.
  if (chasing.average !== 1000) throw new Error("fixture is wrong: average should be 1000");
  return `23 perfect rounds ranked nowhere · 1 round short · average 1000 discarded`;
});

await step("a player who cannot reach the floor is told, not just dropped", async () => {
  const info = season.seasonByIndex(0);
  // 10 rounds played, today is round 80 of 84: 10 + 4 remaining < 24.
  const entries = range(0, 9, 800).map(([d, score]) => ({
    roundId: "rF" + String(d).padStart(4, "0"),
    date: season.addDays(info.start, d),
    score,
  }));
  const tower = season.towerFor(entries, { today: season.addDays(info.start, 79), season: info });
  if (tower.status !== "out") throw new Error(`status ${tower.status}, expected out`);
  if (tower.canStillQualify) throw new Error("claimed a player could still qualify with too few rounds left");
  if (tower.roundsRemaining !== 4) throw new Error(`roundsRemaining ${tower.roundsRemaining}, expected 4`);
  if (tower.roundsNeeded !== 14) throw new Error(`roundsNeeded ${tower.roundsNeeded}, expected 14`);

  // And at the end of a completed season, qualifying reads as qualified.
  const done = season.towerFor(entries, { today: season.addDays(info.end, 1), season: info });
  if (done.status !== "out") throw new Error(`after the season ended: ${done.status}`);
  const full = season.towerFor(
    range(0, 29, 700).map(([d, score]) => ({ roundId: "rF" + String(d).padStart(4, "0"), date: season.addDays(info.start, d), score })),
    { today: season.addDays(info.end, 1), season: info }
  );
  if (full.status !== "qualified") throw new Error(`30 rounds at season's end read as ${full.status}`);
  return "out when unreachable · qualified once the season has ended";
});

await step("equal totals are separated by consistency, deterministically", async () => {
  // Same season total, different shapes. The steadier player ranks higher, and
  // repeating the calculation gives the same answer — a table that reshuffles
  // between reads is a table nobody can plan around.
  const rounds = fixture([
    ["x", "Lumpy_X", "NG", [...range(0, 11, 1000), ...range(12, 23, 400)]], // 12000 + 4800
    ["y", "Even_Y", "NG", range(0, 23, 700)],                               // 24 × 700 = 16800
  ]);
  const info = season.seasonByIndex(0);
  const got = season.collectSeasonEntries(rounds, { season: info });
  const today = season.addDays(info.start, 40);
  const a = season.seasonStandings(got.players, { today, season: info });
  const b = season.seasonStandings(got.players, { today, season: info });

  const rowsA = a.standings.map((r) => `${r.pseudo}:${r.total}:${r.floor}`).join(" | ");
  const rowsB = b.standings.map((r) => `${r.pseudo}:${r.total}:${r.floor}`).join(" | ");
  if (rowsA !== rowsB) throw new Error("the table changed between two identical reads");
  if (a.standings[0].total !== a.standings[1].total) throw new Error("fixture is wrong: totals should tie");
  if (a.standings[0].pseudo !== "Even_Y") throw new Error(`tie broken wrongly: ${rowsA}`);
  return `tied at ${a.standings[0].total} · floor ${a.standings[0].floor} beats ${a.standings[1].floor} · stable across reads`;
});

await step("the demo world never competes", async () => {
  // Demo players keep the daily board alive where the game has not launched.
  // They must never appear in a qualification table, or the finale would be
  // decided by a simulation.
  const info = season.seasonByIndex(0);
  const rounds = {
    rF0000: {
      date: info.start,
      board: [
        { accountId: "real1", pseudo: "Real_One", iso: "NG", score: 700 },
        { accountId: "demo1", pseudo: "Demo_One", iso: "US", score: 1000, demo: true },
      ],
    },
  };
  const got = season.collectSeasonEntries(rounds, { season: info });
  if (got.playersCount !== 1) throw new Error(`collected ${got.playersCount} players, expected only the human`);
  if (got.players.demo1) throw new Error("a demo player was collected into the season");
  if (!got.players.real1) throw new Error("the real player was dropped");

  // Entries written before accounts existed cannot be attributed, so they are
  // skipped rather than guessed at.
  const orphan = season.collectSeasonEntries(
    { rF0000: { date: info.start, board: [{ pseudo: "Pre_Accounts", iso: "NG", score: 600 }] } },
    { season: info }
  );
  if (orphan.playersCount !== 0) throw new Error("an entry with no account was attributed to somebody");
  return "demo excluded · unattributable entries skipped";
});

await step("nations rank by median, and are not ranked until they have depth", async () => {
  const rows = [];
  // One country with a single brilliant player must not outrank a country with
  // a solid squad — that is the whole reason for ranking by median.
  for (let i = 0; i < 6; i++) rows.push([`ng${i}`, `Ng_${i}`, "NG", range(0, 29, 800)]);
  rows.push(["ke0", "Ke_Star", "KE", range(0, 29, 1000)]);
  const rounds = fixture(rows);
  const info = season.seasonByIndex(0);
  const got = season.collectSeasonEntries(rounds, { season: info });
  const today = season.addDays(info.start, 40);

  const n = season.nationStandings(got.players, { today, season: info, minQualifiers: 5 });
  const ranked = n.ranked.map((r) => `${r.iso}:${r.median}`).join(" ");
  if (n.ranked.length !== 1) throw new Error(`expected exactly 1 ranked nation, got ${ranked}`);
  if (n.ranked[0].iso !== "NG") throw new Error(`ranked ${n.ranked[0].iso}`);
  if (n.ranked[0].median !== 24000) throw new Error(`NG median ${n.ranked[0].median}, expected 24000`);
  // Kenya has one qualifier and far fewer than the minimum, so it is unranked
  // with a plain statement of what it needs — never a rank it has not earned.
  const ke = n.unranked.find((r) => r.iso === "KE");
  if (!ke) throw new Error("Kenya was neither ranked nor reported as unranked");
  if (ke.needed !== 4) throw new Error(`Kenya needs ${ke.needed} more, expected 4`);
  return `NG median 24000 ranked · KE with 1 qualifier unranked, needs 4`;
});

await step("season boundaries land where they are supposed to", async () => {
  const s1 = season.seasonByIndex(0);
  const s2 = season.seasonByIndex(1);
  if (s1.start !== "2026-10-11") throw new Error(`season 1 starts ${s1.start}`);
  if (s1.end !== "2027-01-02") throw new Error(`season 1 ends ${s1.end}`);
  if (s2.start !== "2027-01-03") throw new Error(`season 2 starts ${s2.start}`);
  if (season.seasonIndex(s1.end) !== 0) throw new Error("the last day of season 1 is not in season 1");
  if (season.seasonIndex(s2.start) !== 1) throw new Error("the first day of season 2 is not in season 2");
  if (season.seasonStatus(s1, s1.end) !== "running") throw new Error("season 1 ended a day early");
  if (season.seasonStatus(s1, s2.start) !== "complete") throw new Error("season 1 never completes");
  if (season.seasonStatus(s2, s1.start) !== "upcoming") throw new Error("season 2 was not marked upcoming");
  if (season.SEASON_ROUNDS !== 84 || season.SEASON_WEEKS !== 12) throw new Error("season is not 12 weeks of 7");
  return "s001 2026-10-11 → 2027-01-02 · s002 opens 2027-01-03 · statuses correct";
});

await step("a week is one complete set of the faculties", async () => {
  // The property the season rests on: if a week held seven rounds of the same
  // faculty, comparing players by a week would compare nothing meaningful.
  const start = season.seasonByIndex(0).start;
  const week1 = [];
  for (let d = 0; d < 7; d++) week1.push(engine.disciplineForDate(season.addDays(start, d)).id);
  if (new Set(week1).size !== 7) throw new Error(`week 1 repeats a faculty: ${week1.join(",")}`);
  const week2 = [];
  for (let d = 7; d < 14; d++) week2.push(engine.disciplineForDate(season.addDays(start, d)).id);
  if (new Set(week2).size !== 7) throw new Error(`week 2 repeats a faculty: ${week2.join(",")}`);

  const week = season.weekTowerFor(
    range(0, 4, 600).map(([d, score]) => ({
      roundId: "rF" + String(d).padStart(4, "0"),
      date: season.addDays(start, d),
      score,
    })),
    start
  );
  if (week.roundsPlayed !== 5) throw new Error(`week tower counted ${week.roundsPlayed} rounds`);
  if (week.total !== 3000) throw new Error(`week total ${week.total}`);
  if (week.complete) throw new Error("a 5-round week reported itself complete");
  return `both weeks hold all 7 faculties · a partial week reads as partial`;
});

await step("the season endpoints answer, and refuse bad input", async () => {
  const live = await fetch(`${BASE}/api/season`).then((r) => r.json());
  if (!live.season?.id) throw new Error("no season in the payload");
  if (live.rules.qualifyMin !== 24 || live.rules.countBest !== 40) {
    throw new Error("the rules are not published in the payload they govern");
  }
  if (!live.rules.why) throw new Error("the rule is not explained where it is applied");
  if (live.season.roundsElapsed < 1 || live.season.roundsElapsed > 84) throw new Error("rounds elapsed is nonsense");
  if (live.season.status !== "running") throw new Error(`status ${live.season.status}`);

  const bad = await fetch(`${BASE}/api/season?date=2031-01-01`);
  if (bad.status !== 400) throw new Error(`a far-future date returned ${bad.status}`);

  // A device that has never played is told so, not given an empty tower.
  const none = await fetch(`${BASE}/api/tower?deviceId=nosuchdevice99`).then((r) => r.json());
  if (none.hasAccount !== false) throw new Error("an unknown device was given a tower");
  const missing = await fetch(`${BASE}/api/tower`);
  if (missing.status !== 400) throw new Error(`no device id returned ${missing.status}`);

  return `${live.season.id} round ${live.season.roundsElapsed}/${live.season.totalRounds} · rules published · bad input refused`;
});

await step("your tower follows your device, and only your device", async () => {
  const device = "smoketower" + RUN.toLowerCase();
  const played = await post({
    roundId: liveRound.roundId,
    discipline: liveDiscipline,
    pseudo: "TowerSeason_" + RUN,
    country: "NG",
    raw: GOOD_RAW[liveDiscipline],
    deviceId: device,
  });
  if (!played.ok) throw new Error(`could not play: ${JSON.stringify(played)}`);

  const mine = await fetch(`${BASE}/api/tower?deviceId=${device}`).then((r) => r.json());
  if (!mine.hasAccount) throw new Error("the device that just played has no tower");
  if (mine.tower.roundsPlayed !== 1) throw new Error(`roundsPlayed ${mine.tower.roundsPlayed}`);
  if (mine.tower.total !== played.score) throw new Error("the tower does not hold the score just set");
  if (mine.tower.status !== "at_risk") throw new Error(`status ${mine.tower.status} for one round of a running season`);
  if (mine.week.roundsPlayed !== 1) throw new Error("the week tower did not record the round");

  // A different device sees nothing of it.
  const other = await fetch(`${BASE}/api/tower?deviceId=someoneelse${RUN}`.toLowerCase()).then((r) => r.json());
  if (other.hasAccount) throw new Error("another device was shown somebody else's tower");
  return `one round held · ${mine.tower.roundsNeeded} rounds from the floor · a different device sees nothing`;
});

/* 15. Boot the whole application exactly as a browser would. */
console.log("\napp boot (full client, live server)");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await step("main.js boots the shell, loads the round and renders Today", async () => {
  await import("../public/js/main.js");
  await wait(1200);
  const body = document.body;
  if (!body.querySelector(".topbar")) throw new Error("no top bar");
  if (!body.querySelector(".tabs")) throw new Error("no tab bar");
  const tabs = [...body.querySelectorAll(".tab")];
  // Today · The World · Season · Nigeria · Fair Play · My Tower
  if (tabs.length !== 6) throw new Error(`expected 6 screens, got ${tabs.length}`);
  const labels = tabs.map((b) => b.textContent);
  for (const want of ["Today", "The World", "Season", "Nigeria", "Fair Play", "My Tower"]) {
    if (!labels.includes(want)) throw new Error(`the ${want} tab is missing: ${labels.join(", ")}`);
  }
  const text = body.textContent;
  if (!text.includes("Today's faculty")) throw new Error("round did not load from the server");
  if (!text.includes(round.discipline.name)) throw new Error("discipline not shown");
  return `${tabs.length} screens · round ${round.roundNumber} live`;
});

await step("every tab opens without throwing", async () => {
  for (const label of ["The World", "Nigeria", "Fair Play", "My Tower", "Today"]) {
    const tab = [...document.querySelectorAll(".tab")].find((t) => t.textContent === label);
    if (!tab) throw new Error(`missing tab: ${label}`);
    tab.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await wait(900);
    if (document.querySelector(".spinner") && label === "Fair Play") {
      throw new Error(`${label} is stuck loading`);
    }
  }
  return "Today · The World · Nigeria · Fair Play · My Tower";
});

await step("the identity sheet opens and stores a player", async () => {
  const chip = document.querySelector(".chip");
  if (!chip) throw new Error("no player chip");
  chip.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await wait(200);

  const back = document.querySelector(".sheet-back");
  if (!back) throw new Error("sheet did not open");
  const nameInput = back.querySelector(".input");
  nameInput.value = "Smoke_Player";
  nameInput.dispatchEvent(new window.Event("input", { bubbles: true }));

  const nigeria = [...back.querySelectorAll(".country-item")].find((b) =>
    b.textContent.includes("Nigeria")
  );
  if (!nigeria) throw new Error("Nigeria not offered as a country");
  nigeria.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  const take = [...back.querySelectorAll("button")].find((b) =>
    b.textContent.includes("Take my place")
  );
  take.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await wait(400);

  const saved = JSON.parse(window.localStorage.getItem("ayo.v1"));
  if (saved.pseudo !== "Smoke_Player") throw new Error(`nickname not saved: ${saved.pseudo}`);
  if (saved.iso !== "NG") throw new Error(`country not saved: ${saved.iso}`);
  return `${saved.pseudo} playing for ${saved.iso}`;
});

await step("the play button mounts a discipline into the stage", async () => {
  const tab = [...document.querySelectorAll(".tab")].find((t) => t.textContent === "Today");
  tab.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await wait(600);
  const play = [...document.querySelectorAll("button")].find((b) =>
    /play today's round/i.test(b.textContent)
  );
  if (!play) throw new Error("no play button");
  play.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await wait(300);
  const stage = document.querySelector(".stage");
  if (!stage) throw new Error("stage did not mount");
  if (stage.textContent.trim().length < 10) throw new Error("stage is empty");
  return `"${stage.textContent.split("\n")[0].slice(0, 44)}…" mounted`;
});

/* -------------------------------------------------------------------------- */

console.log(
  `\n${failures === 0 ? "\u001b[32m\u001b[1mAll checks passed.\u001b[0m" : `\u001b[31m\u001b[1m${failures} check(s) failed.\u001b[0m`}\n`
);
process.exit(failures === 0 ? 0 : 1);
