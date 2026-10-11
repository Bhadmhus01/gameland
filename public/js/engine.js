/**
 * AYO — The Everyday Games
 * The rules engine. Shared by the browser and the Node server.
 *
 * DESIGN INVARIANTS
 *  1. One round per day, identical discipline for every human on Earth.
 *  2. A discipline's raw result maps to a 0-1000 scale calibrated so that a
 *     median player on Earth scores ~500. (V1 curves: literature-based priors.
 *     V2: re-calibrated from live data at the end of every season.)
 *  3. Every week contains all seven faculties exactly once.
 *  4. Colour is never the dimension being tested in any discipline, and every
 *     discipline declares what it demands of a player's body in `needs`.
 */

/* ---------------------------------------------------------------- utilities */

export function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * Deterministic PRNG (mulberry32), with proper seed avalanche and warm-up.
 *
 * Neighbouring seed strings — "week-0", "week-1", … — must produce
 * uncorrelated streams, otherwise the global schedule visibly repeats. FNV-1a
 * alone leaves the low bits correlated, so the hash is avalanched and the first
 * few outputs are discarded before anyone reads the stream.
 */
export function rng(seedStr) {
  let a = hash32(String(seedStr));
  a ^= a >>> 16;
  a = Math.imul(a, 0x7feb352d);
  a ^= a >>> 15;
  a = Math.imul(a, 0x846ca68b);
  a ^= a >>> 16;

  const next = function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  for (let i = 0; i < 5; i++) next();
  return next;
}

export function shuffled(arr, seedStr) {
  const out = arr.slice();
  const next = rng(seedStr);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* --------------------------------------------------------------- faculties */

export const DISCIPLINES = [
  {
    id: "time",
    name: "The Inner Clock",
    faculty: "Time sense",
    blurb: "Feel ten seconds. No clock. No counting tricks that work.",
    how: "Press start, then press stop when you believe exactly 10 seconds have passed. The closer you are, the higher you score.",
    why: "Every human carries a body clock. Rich or poor, north or south — nobody can buy a better one.",
    needs: ["touch"],
    shareable: false,
  },
  {
    id: "jar",
    name: "The Jar",
    faculty: "Estimation",
    blurb: "A flash of grains. How many were there?",
    how: "A jar is shown for just over two seconds. Then estimate how many were inside. Relative accuracy decides your score.",
    why: "Estimation is the oldest human maths — older than writing, older than money, shared by every culture.",
    needs: ["sight"],
    shareable: false,
  },
  {
    id: "sequence",
    name: "The Chain",
    faculty: "Memory",
    blurb: "Watch the pattern. Repeat it until it breaks.",
    how: "Symbols light up in order. Repeat each growing chain. One mistake ends the round.",
    why: "Working memory is the purest measure of raw mind, and it is distributed evenly across the planet.",
    needs: ["sight"],
    shareable: false,
  },
  {
    id: "pulse",
    name: "The Pulse",
    faculty: "Rhythm",
    blurb: "The drum stops. Keep the beat alive.",
    how: "Tap along with four guided beats. The guide then disappears and you must keep tapping in perfect time for twelve beats.",
    why: "Rhythm is universal. Every society on Earth has a drum, and nobody needs to read to feel time.",
    needs: ["touch", "sight or hearing"],
    shareable: false,
  },
  {
    id: "odd",
    name: "The Odd One Out",
    faculty: "Attention",
    blurb: "Sixty-four shapes. One of them is wrong.",
    how: "A grid appears with a single shape slightly out of place. Find it. Speed and accuracy both count.",
    why: "Noticing what is out of place is survival skill, not schooling.",
    needs: ["sight"],
    shareable: true,
  },
  {
    id: "pattern",
    name: "What Comes Next",
    faculty: "Pattern",
    blurb: "Find the rule. Name the future.",
    how: "A sequence of shapes obeys a hidden rule. Choose what comes next. Answer faster for more points.",
    why: "Culturally neutral shapes only — no flags, no letters, no money, no brand knowledge.",
    needs: ["sight"],
    shareable: true,
  },
  {
    id: "wisdom",
    name: "Think Like Earth",
    faculty: "Social intuition",
    blurb: "Can you think like eight billion people at once?",
    how: "Answer one human question. You then score how closely your answer matched humanity's dominant answer — the answer key does not exist until the world has written it.",
    why: "The only game where the answer key does not exist until humanity writes it — together.",
    needs: ["reading or listening"],
    shareable: true,
  },
];

export const DISCIPLINE_BY_ID = new Map(DISCIPLINES.map((d) => [d.id, d]));

/** The game goes live on this UTC date. Round 1. */
export const ROUND_EPOCH = "2026-10-11";

const DAY_MS = 86400000;

export function utcDateString(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
    .toISOString()
    .slice(0, 10);
}

export function dayIndexOf(dateStr) {
  const a = Date.parse(ROUND_EPOCH + "T00:00:00Z");
  const b = Date.parse(dateStr + "T00:00:00Z");
  return Math.round((b - a) / DAY_MS);
}

export function roundIdOf(dateStr) {
  return "r" + String(dayIndexOf(dateStr) + 1).padStart(4, "0");
}

export function roundNumberOf(roundId) {
  return parseInt(String(roundId).replace(/[^0-9]/g, ""), 10) || 0;
}

/**
 * Which faculty does the world play on a given day?
 * Each 7-day cycle is a deterministic shuffle of all seven faculties,
 * so every week contains every discipline exactly once — worldwide.
 */
export function disciplineForDate(dateStr) {
  const dayIndex = dayIndexOf(dateStr);
  const week = Math.floor(dayIndex / 7);
  const slot = ((dayIndex % 7) + 7) % 7;
  const order = shuffled(DISCIPLINES.map((d) => d.id), "week-" + week);
  return DISCIPLINE_BY_ID.get(order[slot]);
}

export function weekIdOf(dateStr) {
  const dayIndex = dayIndexOf(dateStr);
  return "w" + String(Math.floor(dayIndex / 7) + 1).padStart(3, "0");
}

/** Seconds until the global window closes (23:59:59 UTC — after the last timezone). */
export function secondsUntilReveal(now = new Date()) {
  const close = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59)
  );
  return Math.max(0, Math.round((close - now) / 1000));
}

/* ----------------------------------------------------------------- scoring */

export const SCORING = {
  /** err = |elapsed - target| in seconds. Median human error ~1.35s -> ~500. */
  time(raw) {
    const err = Math.abs(raw.elapsed - raw.target);
    return Math.round(1000 / (1 + Math.pow(err / 1.35, 1.6)));
  },
  /** Relative error of an estimate. Median human epsilon ~0.25 -> ~500. */
  jar(raw) {
    const eps = Math.abs(raw.guess - raw.count) / Math.max(1, raw.count);
    return Math.round(1000 * Math.exp(-2.2 * Math.pow(eps, 0.85)));
  },
  /** Items correctly recalled. Median span ~7 -> 500. */
  sequence(raw) {
    return Math.round(clamp((raw.length - 3) * 125, 0, 1000));
  },
  /** Tempo error + consistency (coefficient of variation of intervals). */
  pulse(raw) {
    const target = raw.period;
    const tempoErr = Math.abs(raw.meanInterval - target) / target;
    const cv = raw.meanInterval > 0 ? raw.sdInterval / raw.meanInterval : 1;
    const s = 1000 * Math.exp(-3.2 * tempoErr) * Math.exp(-2.6 * clamp(cv, 0, 2));
    return Math.round(clamp(s, 0, 1000));
  },
  /** Five hidden-shape puzzles. Accuracy first, then speed. */
  odd(raw) {
    const acc = clamp(raw.solved / 5, 0, 1);
    const speed = clamp(1 - (raw.totalSeconds - 10) / 40, 0.55, 1);
    return Math.round(clamp(1000 * acc * speed, 0, 1000));
  },
  /** Six pattern puzzles. Accuracy first, then speed. */
  pattern(raw) {
    const acc = clamp(raw.solved / 6, 0, 1);
    const speed = clamp(1 - (raw.totalSeconds - 24) / 60, 0.55, 1);
    return Math.round(clamp(1000 * acc * speed, 0, 1000));
  },
  /**
   * Social intuition.
   *
   * Scoring the raw share of agreement would break comparability: with four
   * options a share is only ever ~25-35%, so every player would score ~300
   * while the other six disciplines centre on 500. Instead the share is placed
   * on the spread humanity actually produced that day — the least common answer
   * scores 200, the dominant answer scores 900, and everything between is
   * proportional, so the curve adapts to every question however divided or
   * united the world turns out to be.
   *
   * The final 100 points are held back for genuine consensus. Without that, the
   * dominant answer would score exactly 1000 and a third of humanity would tie
   * at the ceiling every time — which would make this discipline worth more than
   * the other six in a season average.
   */
  wisdom(raw) {
    const span = Math.max(1e-6, raw.maxShare - raw.minShare);
    const rel = clamp((raw.share - raw.minShare) / span, 0, 1);
    const consensus = clamp((raw.share - 0.4) / 0.3, 0, 1); // 40% -> 0, 70% -> full
    return Math.round(clamp(200 + 700 * rel + 100 * consensus, 0, 1000));
  },
};

export function scoreRound(disciplineId, raw) {
  const fn = SCORING[disciplineId];
  if (!fn) return 0;
  return clamp(Math.round(fn(raw)), 0, 1000);
}

/** Approximate percentile of a 0-1000 score on a normal-ish global curve. */
export function percentile(score) {
  const z = (score - 500) / 190;
  // Abramowitz & Stegun 7.1.26 error-function approximation.
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-z * z / 2);
  const p = 0.5 * (1 + (z >= 0 ? y : -y));
  return clamp(Math.round(p * 1000) / 10, 0.1, 99.9);
}

/* -------------------------------------------------------- wisdom question bank
 * Culture-neutral prompts only. No flags, no brands, no trivia, no schooling.
 * The global answer key is written by the players themselves.
 */
export const WISDOM_BANK = [
  {
    q: "Which would you rather lose for one week?",
    options: ["Your phone", "Your sense of smell", "Your shoes", "Your favourite food"],
  },
  {
    q: "Which is harder to do?",
    options: ["Start something new", "Finish something old", "Both are equal", "Neither is hard"],
  },
  {
    q: "Is it kinder to tell a painful truth or a comfortable lie?",
    options: ["Painful truth", "Comfortable lie", "Depends who asks", "Never lie at all"],
  },
  {
    q: "What do most people regret more?",
    options: ["Things they did", "Things they never did", "Neither", "Both equally"],
  },
  {
    q: "If you had one free hour every day, what would the world spend it on?",
    options: ["Sleep", "Family", "Money", "Screens"],
  },
  {
    q: "Which disappears fastest?",
    options: ["Money", "Time", "Trust", "Youth"],
  },
  {
    q: "Which would the world find harder to give up?",
    options: ["Music", "Sport", "Religion", "Food"],
  },
  {
    q: "When someone is late, what is the most likely reason?",
    options: ["They forgot", "Traffic", "They were busy", "They did not want to come"],
  },
  {
    q: "Which is a stronger bond?",
    options: ["Blood family", "Chosen friends", "Shared language", "Shared hardship"],
  },
  {
    q: "Which is the better teacher?",
    options: ["Failure", "Success", "Other people", "Time"],
  },
  {
    q: "Which is hardest to keep?",
    options: ["A promise", "A secret", "A temper", "A friendship"],
  },
  {
    q: "Which is the loudest thing in the world?",
    options: ["A crowd", "Silence between two people", "A mother's warning", "Your own thoughts"],
  },
  {
    q: "What makes someone trustworthy?",
    options: ["They keep small promises", "They admit mistakes", "They never gossip", "They are generous"],
  },
  {
    q: "Which is more valuable in a stranger?",
    options: ["Honesty", "Kindness", "Competence", "Humour"],
  },
  {
    q: "Which do people lie about most often?",
    options: ["How they feel", "How much they earn", "How busy they are", "How much they know"],
  },
  {
    q: "What is the first thing a person looks at in a room?",
    options: ["The exit", "The people", "The food", "The windows"],
  },
  {
    q: "Which is the real measure of a country?",
    options: ["How it treats its children", "How it treats its elders", "How it treats strangers", "How it treats failure"],
  },
  {
    q: "Which is hardest to say?",
    options: ["I was wrong", "I need help", "I forgive you", "Goodbye"],
  },
  {
    q: "What does a person miss most when far from home?",
    options: ["The food", "The language", "The people", "The weather"],
  },
  {
    q: "Which belongs to everyone equally?",
    options: ["Sunlight", "Music", "Hope", "Rain"],
  },
  {
    q: "Which is stronger?",
    options: ["Fear of losing", "Desire to win", "Habit", "Love"],
  },
  {
    q: "Which makes a long queue bearable?",
    options: ["Company", "A phone", "Patience", "Anger"],
  },
  {
    q: "Which is the best time of day?",
    options: ["Early morning", "Midday", "Evening", "Late night"],
  },
  {
    q: "Which skill will matter most in fifty years?",
    options: ["Learning fast", "Working with people", "Making things", "Staying calm"],
  },
];

export function wisdomQuestionFor(roundId) {
  const next = rng("wisdom-" + roundId);
  return WISDOM_BANK[Math.floor(next() * WISDOM_BANK.length)];
}

/* ------------------------------------------------- per-player variant seeding
 * Type A disciplines are identical for everyone (unshareable — you cannot
 * copy another person's internal clock).
 * Type B disciplines are multiple-choice, so each player receives an
 * equivalent variant drawn from the same family. Sharing an answer is useless.
 */
export function variantSeed(roundId, deviceId) {
  return `${roundId}::${String(deviceId || "anon").slice(0, 24)}`;
}
