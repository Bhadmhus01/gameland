/**
 * Seed the board with named players so a first run is never a ghost town.
 *
 *   node tools/seed.mjs                     # against http://127.0.0.1:3000
 *   BASE=http://host:port node tools/seed.mjs
 *
 * Discipline-agnostic: it reads today's round from the server and invents a
 * plausible raw result for whatever discipline is live, so it works on any day
 * of the rotation. These are demonstration humans — distinct from the simulated
 * "demo world", which the server generates itself and labels as simulated
 * everywhere it appears.
 *
 * Each player carries a `quality` in 0..1, which is inverted through the real
 * scoring curve to produce a result worth roughly that share of 1000. That keeps
 * the seeded distribution honest instead of clustering at the top.
 */

const BASE = process.env.BASE || "http://127.0.0.1:3000";

/** [nickname, iso, quality 0..1] — Nigeria deliberately deep, not top-heavy. */
const PLAYERS = [
  // Nigeria — the home team
  ["Ada_of_Lagos", "NG", 0.93],
  ["Tunde_Kano", "NG", 0.88],
  ["Chidi_Enugu", "NG", 0.85],
  ["Amaka_Owerri", "NG", 0.79],
  ["Zainab_Kaduna", "NG", 0.84],
  ["Efe_Benin", "NG", 0.74],
  ["Bola_Ibadan", "NG", 0.90],
  ["Ifeanyi_Onitsha", "NG", 0.68],
  ["Sade_Lekki", "NG", 0.86],
  ["Kunle_Abeokuta", "NG", 0.61],
  ["Ngozi_Jos", "NG", 0.80],
  ["Yemi_Akure", "NG", 0.55],
  ["Halima_Maiduguri", "NG", 0.72],
  ["Segun_Ilorin", "NG", 0.91],
  ["Damilola_Gbagada", "NG", 0.66],
  ["Kelechi_Aba", "NG", 0.83],
  // Africa
  ["Kwame_Accra", "GH", 0.87],
  ["Ama_Kumasi", "GH", 0.70],
  ["Wanjiru_Nairobi", "KE", 0.82],
  ["Kofi_Kampala", "UG", 0.64],
  ["Sipho_Joburg", "ZA", 0.77],
  ["Naledi_Gaborone", "BW", 0.58],
  ["Amina_Dakar", "SN", 0.78],
  ["Musa_Bamako", "ML", 0.48],
  ["Thabo_Maseru", "LS", 0.69],
  // Asia
  ["Priya_Mumbai", "IN", 0.81],
  ["Arjun_Delhi", "IN", 0.63],
  ["Wei_Shanghai", "CN", 0.71],
  ["Mei_Chengdu", "CN", 0.88],
  ["Yuki_Tokyo", "JP", 0.94],
  ["Putra_Jakarta", "ID", 0.67],
  ["Minh_Hanoi", "VN", 0.79],
  ["Rafiq_Dhaka", "BD", 0.53],
  // Europe
  ["Elena_Rome", "IT", 0.84],
  ["Lars_Oslo", "NO", 0.75],
  ["Sofia_Lisbon", "PT", 0.86],
  ["Marco_Madrid", "ES", 0.62],
  ["Anouk_Amsterdam", "NL", 0.80],
  // Americas & Oceania
  ["Ana_SaoPaulo", "BR", 0.83],
  ["Diego_Bogota", "CO", 0.65],
  ["Camila_Lima", "PE", 0.59],
  ["Grace_London", "GB", 0.82],
  ["Noah_Texas", "US", 0.76],
  ["Ruby_Sydney", "AU", 0.70],
];

/* ---------------------------------------------------------------- raw results
 * Each function inverts the published curve in engine.js, so a seeded score
 * lands where the quality value says it should.
 */

/** Deterministic jitter so results look human rather than synthetic. */
function jitter(seed) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return ((h >>> 8) % 1000) / 1000; // 0..1
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function rawFor(discipline, quality, seed) {
  const j = jitter(seed);
  const target = clamp(180 + quality * 780 + (j - 0.5) * 60, 60, 990);

  switch (discipline) {
    case "time": {
      // score = 1000 / (1 + (err/1.35)^1.6)
      const err = 1.35 * Math.pow(1000 / target - 1, 1 / 1.6);
      const signed = (j > 0.5 ? 1 : -1) * clamp(err, 0.02, 9);
      return { elapsed: clamp(10 + signed, 0.6, 38), target: 10 };
    }
    case "jar": {
      // score = 1000 * exp(-2.2 * eps^0.85)
      const eps = Math.pow(-Math.log(clamp(target, 1, 999) / 1000) / 2.2, 1 / 0.85);
      const count = 42 + Math.round(j * 116); // 42..158
      const signed = (j > 0.45 ? 1 : -1) * clamp(eps, 0.005, 1.4);
      return { count, guess: Math.max(1, Math.round(count * (1 + signed))) };
    }
    case "sequence": {
      // score = (length - 3) * 125
      return { length: clamp(Math.round(target / 125) + 3, 3, 15) };
    }
    case "pulse": {
      // score = 1000 * exp(-3.2 * tempoErr) * exp(-2.6 * cv)
      const cv = 0.06 + j * 0.16;
      const tempoErr = clamp(
        -Math.log(clamp(target, 1, 999) / 1000) / 3.2 - (2.6 * cv) / 3.2,
        0.001,
        0.7
      );
      const period = 640;
      const meanInterval = clamp(period * (1 + (j > 0.5 ? 1 : -1) * tempoErr), 220, 2200);
      return { period, meanInterval, sdInterval: clamp(meanInterval * cv, 0, 1600) };
    }
    case "odd": {
      // score = 1000 * (solved/5) * speed
      const solved = clamp(Math.round((target / 1000) * 5), 0, 5);
      return { solved, totalSeconds: clamp(9 + solved * 4 + j * 8, 4, 150) };
    }
    case "pattern": {
      const solved = clamp(Math.round((target / 1000) * 6), 0, 6);
      return { solved, totalSeconds: clamp(14 + solved * 6 + j * 14, 8, 300) };
    }
    case "wisdom": {
      // The score is the share of the world that agreed, so spread the choices
      // with a deliberate majority — that is what makes the answer key earned.
      const weights = [0.34, 0.27, 0.22, 0.17];
      let acc = 0;
      const r = j;
      for (let i = 0; i < weights.length; i++) {
        acc += weights[i];
        if (r <= acc) return { choice: i };
      }
      return { choice: 0 };
    }
    default:
      return null;
  }
}

/* --------------------------------------------------------------------- run */

const round = await (await fetch(`${BASE}/api/rounds/today`)).json();
const discipline = round.discipline.id;

let ok = 0;
let replay = 0;
let skipped = 0;
let failed = 0;

for (const [pseudo, country, quality] of PLAYERS) {
  const raw = rawFor(discipline, quality, `${pseudo}:${round.roundId}`);
  if (!raw) {
    skipped++;
    continue;
  }
  try {
    const res = await fetch(`${BASE}/api/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roundId: round.roundId, discipline, pseudo, country, raw }),
    });
    const j = await res.json();
    if (j.ok && j.replay) replay++;
    else if (j.ok) ok++;
    else {
      failed++;
      console.error(`  ${pseudo}: ${j.error}`);
    }
  } catch (err) {
    failed++;
    console.error(`  ${pseudo}: ${err.message}`);
  }
}

console.log(
  `Seeded ${ok} players for round ${round.roundId} (${round.discipline.name}).` +
    (replay ? ` ${replay} had already played.` : "") +
    (skipped ? ` ${skipped} skipped (unknown discipline).` : "") +
    (failed ? ` ${failed} failed.` : "")
);
