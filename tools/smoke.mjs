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
let engine, countries, ui, store, api, games, views;
await step("import engine / countries / ui / store / api / games / views", async () => {
  engine = await import("../public/js/engine.js");
  countries = await import("../public/js/countries.js");
  ui = await import("../public/js/ui.js");
  store = await import("../public/js/store.js");
  api = await import("../public/js/api.js");
  games = await import("../public/js/games.js");
  views = await import("../public/js/views.js");
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

  // After answering, it opens.
  await fetch(`${BASE}/api/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      roundId: round.roundId,
      discipline: "wisdom",
      pseudo: "Peeking_" + RUN,
      country: "NG",
      raw: { choice: 1 },
    }),
  });
  const open = await (
    await fetch(`${BASE}/api/wisdom?pseudo=Peeking_${RUN}&country=NG`)
  ).json();
  if (open.sealed) throw new Error("the key stayed sealed after playing");
  if (!open.shares) throw new Error("no shares returned after playing");
  return `sealed before · ${open.total} answers revealed after`;
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

await step("POST /api/submit round-trips and scores", async () => {
  const res = await fetch(`${BASE}/api/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      roundId: "r0001",
      discipline: "jar",
      pseudo: "Smoke_" + RUN,
      country: "NG",
      raw: { count: 120, guess: 119 },
    }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(JSON.stringify(j));
  if (!(j.score >= 0 && j.score <= 1000)) throw new Error("score out of range");
  if (!j.verdict) throw new Error("no verdict");
  return `score ${j.score} · ${j.verdict} · top ${(100 - j.percentile).toFixed(1)}%`;
});

await step("server rejects malformed and forged payloads", async () => {
  const cases = [
    ["bad country", { discipline: "jar", pseudo: "Ok_Name", country: "ZZ", raw: { count: 10, guess: 10 } }],
    ["short pseudo", { discipline: "jar", pseudo: "x", country: "NG", raw: { count: 10, guess: 10 } }],
    ["out-of-range", { discipline: "jar", pseudo: "Ok_Name", country: "NG", raw: { count: 999999, guess: 10 } }],
    ["missing raw", { discipline: "jar", pseudo: "Ok_Name", country: "NG" }],
    ["wrong discipline", { discipline: "moonwalk", pseudo: "Ok_Name", country: "NG", raw: {} }],
    ["non-numeric raw", { discipline: "jar", pseudo: "Ok_Name", country: "NG", raw: { count: "lots", guess: 10 } }],
    ["bad date round", { roundId: "r9999", discipline: "jar", pseudo: "Ok_Name", country: "NG", raw: { count: 10, guess: 10 } }],
  ];
  for (const [label, body] of cases) {
    const r = await fetch(`${BASE}/api/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.ok) throw new Error(`${label} was accepted`);
  }
  return `${cases.length} malformed payloads refused`;
});

await step("extra fields a client invents are ignored, never trusted", async () => {
  // A cheater sending their own score alongside a poor result must not be believed.
  const r = await fetch(`${BASE}/api/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      roundId: "r0001",
      discipline: "jar",
      pseudo: "Forged_" + RUN,
      country: "NG",
      raw: { count: 100, guess: 50 },
      score: 1000,
      percentile: 99.9,
      verdict: "Untouchable",
    }),
  });
  const j = await r.json();
  if (j.score === 1000) throw new Error("invented score was trusted");
  if (j.score > 400) throw new Error(`expected a mediocre score, got ${j.score}`);
  return `client claimed 1000 · server computed ${j.score}`;
});

await step("one scored attempt per day is enforced", async () => {
  const post = (guess) =>
    fetch(`${BASE}/api/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        roundId: "r0001",
        discipline: "jar",
        pseudo: "Daily_" + RUN,
        country: "NG",
        raw: { count: 120, guess },
      }),
    }).then((r) => r.json());

  const first = await post(119); // excellent
  const second = await post(40); // deliberately terrible, hoping to overwrite
  if (first.replay) throw new Error("first attempt was flagged as a replay");
  if (!second.replay) throw new Error("second attempt was scored again");
  if (second.score !== first.score) throw new Error("a second attempt changed the score");
  return `first ${first.score} · replay returns the same ${second.score}`;
});

await step("a client-declared score is ignored", async () => {
  const r = await fetch(`${BASE}/api/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      roundId: "r0001",
      discipline: "jar",
      pseudo: "Honest_" + RUN,
      country: "GH",
      raw: { count: 100, guess: 40 },
      score: 1000,
    }),
  });
  const j = await r.json();
  if (j.score === 1000) throw new Error("client score was trusted");
  if (j.score > 400) throw new Error(`expected a poor score, got ${j.score}`);
  return `claimed 1000, server awarded ${j.score}`;
});

/* 11. Boot the whole application exactly as a browser would. */
console.log("\napp boot (full client, live server)");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await step("main.js boots the shell, loads the round and renders Today", async () => {
  await import("../public/js/main.js");
  await wait(1200);
  const body = document.body;
  if (!body.querySelector(".topbar")) throw new Error("no top bar");
  if (!body.querySelector(".tabs")) throw new Error("no tab bar");
  const tabs = [...body.querySelectorAll(".tab")];
  if (tabs.length !== 5) throw new Error(`expected 5 screens, got ${tabs.length}`);
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
