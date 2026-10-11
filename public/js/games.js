/**
 * The seven disciplines.
 *
 * Every game is generated from a per-player seed, runs entirely on the device
 * (so it works on 2G), and ends by handing a raw measurement to the scorer.
 * The browser never decides its own points — the server re-computes them.
 *
 * Two families, and the difference matters for fairness:
 *   TYPE A — unshareable. You cannot borrow another person's inner clock,
 *            memory span or rhythm. Everyone gets the identical task.
 *   TYPE B — equivalent variants. Multiple-choice disciplines are drawn per
 *            player from the same family, so copying an answer is useless.
 */

import { rng, variantSeed } from "./engine.js";
import { h, mount, buzz, clear } from "./ui.js";

/* ------------------------------------------------------------- audio utils */

let actx = null;
function beep(freq = 880, dur = 0.06, gain = 0.22) {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === "suspended") actx.resume();
    const o = actx.createOscillator();
    const g = actx.createGain();
    o.type = "sine";
    o.frequency.value = freq;
    const t = actx.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(actx.destination);
    o.start(t);
    o.stop(t + dur + 0.03);
  } catch {
    /* audio is a bonus, never a requirement */
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ---------------------------------------------------------------- shared ui */

function shell(children) {
  const el = h("div", { class: "stack", style: { alignItems: "center", width: "100%" } });
  mount(el, children);
  return el;
}

function primaryBtn(label, onclick, cls = "btn btn-primary btn-lg") {
  return h("button", { class: cls, onclick, text: label });
}

function note(text) {
  return h("p", { class: "tiny muted", style: { letterSpacing: ".08em" }, text });
}

/**
 * A shrinking timer bar.
 * Holds a direct reference to its own node and can be cancelled, so a timer can
 * never fire into a stage the player has already left.
 */
function timedBar(width, seconds) {
  const fill = h("i", { style: { width: "100%" } });
  const wrap = h("div", { class: "meter", style: { width } }, fill);
  let frame = 0;
  let live = true;
  return {
    el: wrap,
    start() {
      frame = requestAnimationFrame(() => {
        if (!live || !fill.isConnected) return;
        fill.style.transition = `width ${seconds}s linear`;
        fill.style.width = "0%";
      });
    },
    stop() {
      live = false;
      cancelAnimationFrame(frame);
    },
  };
}

/* =========================================================================
   1. THE INNER CLOCK — time sense  (TYPE A)
   ========================================================================= */

function makeTime(ctx) {
  let t0 = 0;
  let running = false;
  let alive = true;
  const el = shell([]);
  let timerId = 0;
  let pulseNode = null;

  function ready() {
    mount(
      el,
      h("h3", { text: "The Inner Clock" }),
      h("p", {
        class: "instr",
        text: "Press START. Wait until you feel exactly 10 seconds have passed. Then press STOP.",
      }),
      h("div", { class: "pill gold", text: "No clock · No counting out loud" }),
      h("div", { style: { marginTop: "22px" } }, primaryBtn("Start", start)),
      note("One attempt. Trust your body, not your maths.")
    );
  }

  function start() {
    t0 = performance.now();
    running = true;
    buzz(15);
    pulseNode = h(
      "div",
      { class: "tapzone hot", onclick: stop },
      h(
        "div",
        {},
        h("div", { class: "label", text: "STOP" }),
        h("div", { class: "sub", text: "when you feel 10s" })
      )
    );
    mount(
      el,
      h("h3", { text: "Feel ten seconds" }),
      pulseNode,
      note("Eyes on the circle. The seconds are inside you.")
    );
    timerId = window.setInterval(() => {
      // Gentle reminder that time is passing — without ever showing a number.
      if (!alive || !running || !pulseNode?.isConnected) return;
      pulseNode.style.transform = `scale(${1 + Math.sin(performance.now() / 700) * 0.012})`;
    }, 60);
  }

  function stop() {
    if (!running) return;
    running = false;
    clearInterval(timerId);
    const elapsed = (performance.now() - t0) / 1000;
    if (elapsed < 2) {
      toastLike("Too fast — really feel the seconds. Try again.");
      ready();
      return;
    }
    buzz(20);
    ctx.onFinish({ elapsed });
  }

  function toastLike(msg) {
    const n = h("div", { class: "pill coral", text: msg, style: { marginTop: "12px" } });
    el.append(n);
    setTimeout(() => n.remove(), 2600);
  }

  const onKey = (e) => {
    if (e.code === "Space" || e.code === "Enter") {
      e.preventDefault();
      if (running) stop();
      else start();
    }
  };
  document.addEventListener("keydown", onKey);
  ready();

  return {
    el,
    destroy: () => {
      alive = false;
      running = false;
      clearInterval(timerId);
      document.removeEventListener("keydown", onKey);
    },
  };
}

/* =========================================================================
   2. THE JAR — estimation  (TYPE A)
   ========================================================================= */

const GRAIN_COLORS = ["#f7b32b", "#00a651", "#ff6b4a", "#7c5cff", "#f4f7ff", "#2fd07b"];

function makeJar(ctx) {
  const next = rng(ctx.seed + ":jar");
  const count = 42 + Math.floor(next() * 118); // 42 – 159
  const grains = [];
  for (let i = 0; i < count; i++) {
    grains.push({
      x: 8 + next() * 84,
      y: 7 + next() * 86,
      s: 0.62 + next() * 0.7,
      c: GRAIN_COLORS[Math.floor(next() * GRAIN_COLORS.length)],
      d: 0.6 + next() * 0.8,
    });
  }

  let guess = "";
  const el = shell([]);
  const timeouts = [];
  let alive = true;

  function jarNode() {
    const jar = h("div", { class: "jar-viz" });
    for (const g of grains) {
      jar.append(
        h("span", {
          class: "jar-grain",
          style: {
            left: g.x + "%",
            top: g.y + "%",
            width: 9 * g.s + "px",
            height: 9 * g.s + "px",
            background: g.c,
            boxShadow: `0 0 6px ${g.c}55`,
          },
        })
      );
    }
    return jar;
  }

  function ready() {
    mount(
      el,
      h("h3", { text: "The Jar" }),
      h("p", {
        class: "instr",
        text: "A jar of grains will appear for a little over two seconds. Count what you can — then estimate the rest. Nobody counts every grain.",
      }),
      primaryBtn("Show me the jar", flash, "btn btn-green btn-lg"),
      note("Estimation, not counting. Your eyes are the instrument.")
    );
  }

  function flash() {
    const jar = jarNode();
    const bar = h("i", { style: { width: "100%" } });
    mount(
      el,
      h("h3", { text: "Two seconds…" }),
      jar,
      h("div", { class: "meter", style: { width: "min(360px,84vw)", marginTop: "16px" } }, bar)
    );
    requestAnimationFrame(() => {
      bar.style.transition = "width 2.3s linear";
      bar.style.width = "0%";
    });
    beep(660, 0.05, 0.14);
    timeouts.push(
      setTimeout(() => {
        if (!alive) return;
        beep(440, 0.05, 0.14);
        ask();
      }, 2350)
    );
  }

  function ask() {
    const readout = h("div", { class: "num-input mono", text: "0" });
    const pad = h("div", { class: "pad" });
    for (const k of ["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "OK"]) {
      pad.append(
        h("button", {
          text: k,
          onclick: () => {
            buzz(8);
            if (k === "⌫") guess = guess.slice(0, -1);
            else if (k === "OK") return done();
            else if (guess.length < 4) guess += k;
            readout.textContent = guess || "0";
          },
        })
      );
    }
    mount(
      el,
      h("h3", { text: "How many grains?" }),
      readout,
      pad,
      note("The jar is gone. Go with your gut — first instinct beats second-guessing.")
    );

    const onKey = (e) => {
      if (/^[0-9]$/.test(e.key) && guess.length < 4) guess += e.key;
      else if (e.key === "Backspace") guess = guess.slice(0, -1);
      else if (e.key === "Enter") return done();
      else return;
      readout.textContent = guess || "0";
    };
    document.addEventListener("keydown", onKey);
    el._cleanupKey = () => document.removeEventListener("keydown", onKey);
  }

  function done() {
    if (!guess || Number(guess) <= 0) return;
    beep(880, 0.06, 0.18);
    ctx.onFinish({ count, guess: Number(guess) });
  }

  ready();
  return {
    el,
    destroy() {
      alive = false;
      timeouts.forEach(clearTimeout);
      el._cleanupKey?.();
    },
  };
}

/* =========================================================================
   3. THE CHAIN — working memory  (TYPE A)
   ========================================================================= */

const SYMBOLS = ["●", "▲", "■", "★", "◆", "✦", "✚", "⬟", "◤"];
const FLASH_ON = 560;
const FLASH_GAP = 210;
const MAX_LENGTH = 15;

function makeSequence(ctx) {
  const next = rng(ctx.seed + ":sequence");
  let seq = [Math.floor(next() * 9), Math.floor(next() * 9), Math.floor(next() * 9)];
  let inputIndex = 0;
  let locked = true;
  let best = 0;
  let alive = true;
  let statusNode = null;
  const el = shell([]);

  const cells = SYMBOLS.map((sym, i) =>
    h("div", {
      class: "simon-cell",
      dataset: { i: String(i) },
      text: sym,
      onclick: () => tap(i),
    })
  );

  function lit(i) {
    const c = cells[i];
    if (!c) return;
    c.classList.add("lit");
    beep(520 + i * 42, 0.1, 0.16);
    setTimeout(() => c.classList.remove("lit"), FLASH_ON - 60);
  }

  async function play() {
    if (!alive) return;
    locked = true;
    inputIndex = 0;
    statusNode = h("div", { class: "tiny-up muted", text: "Watch…" });
    mount(
      el,
      h("h3", { text: `Chain of ${seq.length}` }),
      h("p", { class: "instr", text: "Watch closely. Then repeat it back." }),
      h("div", { class: "simon-grid" }, cells),
      statusNode
    );
    await sleep(620);
    if (!alive) return;
    for (const idx of seq) {
      lit(idx);
      await sleep(FLASH_ON + FLASH_GAP);
      if (!alive) return;
    }
    if (statusNode?.isConnected) statusNode.textContent = "Your turn";
    locked = false;
  }

  async function tap(i) {
    if (locked || !alive) return;
    buzz(8);
    if (i === seq[inputIndex]) {
      lit(i);
      inputIndex++;
      if (inputIndex === seq.length) {
        best = seq.length;
        locked = true;
        if (statusNode?.isConnected) statusNode.textContent = "Correct";
        await sleep(620);
        if (!alive) return;
        if (seq.length >= MAX_LENGTH) return ctx.onFinish({ length: seq.length });
        seq = [...seq, Math.floor(rng(ctx.seed + ":x" + seq.length)() * 9)];
        play();
      }
    } else {
      cells[i].classList.add("wrong");
      beep(180, 0.18, 0.2);
      locked = true;
      if (statusNode?.isConnected) statusNode.textContent = "Chain broken";
      await sleep(700);
      if (!alive) return;
      ctx.onFinish({ length: best });
    }
  }

  function ready() {
    mount(
      el,
      h("h3", { text: "The Chain" }),
      h("p", {
        class: "instr",
        text: "Symbols will light up in a pattern. Repeat the pattern back. Each round adds one more. One mistake ends the game.",
      }),
      primaryBtn("Begin", play, "btn btn-green btn-lg"),
      note("Working memory. Nobody can train this in a day — which is exactly the point.")
    );
  }

  ready();
  return {
    el,
    destroy() {
      alive = false;
      locked = true;
    },
  };
}

/* =========================================================================
   4. THE PULSE — rhythm  (TYPE A)
   ========================================================================= */

const PULSE_PERIOD = 640;
const GUIDED_BEATS = 5;
const SILENT_TAPS = 12;

function makePulse(ctx) {
  let taps = [];
  let running = false;
  let alive = true;
  let countNode = null;
  const el = shell([]);
  const dots = Array.from({ length: 4 }, () => h("div", { class: "beat-dot" }));

  function litDot(i) {
    dots.forEach((d, n) => d.classList.toggle("on", n === i % 4));
  }

  async function ready() {
    mount(
      el,
      h("h3", { text: "The Pulse" }),
      h("p", {
        class: "instr",
        text: `Tap along with ${GUIDED_BEATS} guided beats. The guide then goes silent — keep tapping in exactly the same rhythm for ${SILENT_TAPS} beats.`,
      }),
      h("div", { class: "beat-dots" }, dots),
      primaryBtn("Start the drum", guide, "btn btn-green btn-lg"),
      note("Sound on for the best result. Rhythm lives in the ear, not the eye.")
    );
  }

  async function guide() {
    mount(
      el,
      h("h3", { text: "Follow the drum" }),
      h("div", { class: "beat-dots" }, dots),
      h("p", { class: "tiny-up muted", style: { marginTop: "18px" }, text: "Tap along — feel the spacing" })
    );
    await sleep(500);
    for (let i = 0; i < GUIDED_BEATS; i++) {
      if (!alive) return;
      beep(760, 0.07, 0.2);
      litDot(i);
      buzz(10);
      await sleep(PULSE_PERIOD);
    }
    if (!alive) return;
    dots.forEach((d) => d.classList.remove("on"));
    beginSilent();
  }

  function beginSilent() {
    if (!alive) return;
    taps = [];
    running = true;
    countNode = h("span", {
      class: "tiny-up",
      style: { position: "absolute", bottom: "8px", left: "0", right: "0", textAlign: "center", color: "var(--muted)" },
      text: `0 / ${SILENT_TAPS}`,
    });
    const bar = h(
      "div",
      { class: "tap-bar" },
      h("div", { class: "beat-dots" }, dots),
      countNode
    );
    mount(
      el,
      h("h3", { text: "Keep it alive" }),
      h("p", { class: "instr", text: `Guide has stopped. Tap ${SILENT_TAPS} times, in perfect time.` }),
      bar,
      note("Do not rush. Same spacing as the drum.")
    );
    bar.addEventListener("pointerdown", onTap);
  }

  function onTap(e) {
    e.preventDefault();
    if (!running || !alive) return;
    const t = performance.now();
    taps.push(t);
    buzz(8);
    litDot(taps.length % 4);
    setTimeout(() => {
      if (alive) dots.forEach((d) => d.classList.remove("on"));
    }, 150);
    beep(560, 0.035, 0.1);
    if (countNode?.isConnected) {
      countNode.textContent = `${Math.min(taps.length, SILENT_TAPS)} / ${SILENT_TAPS}`;
    }
    if (taps.length >= SILENT_TAPS) finish();
  }

  function finish() {
    running = false;
    alive = false;
    const intervals = [];
    for (let i = 1; i < taps.length; i++) intervals.push(taps[i] - taps[i - 1]);
    if (intervals.length < 4) return ctx.onFinish({ period: PULSE_PERIOD, meanInterval: PULSE_PERIOD, sdInterval: 600 });
    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const sd = Math.sqrt(intervals.reduce((a, b) => a + (b - mean) ** 2, 0) / intervals.length);
    // Clamp into the range the server accepts.
    const meanInterval = Math.max(180, Math.min(2400, mean));
    const sdInterval = Math.max(0, Math.min(1800, sd));
    beep(880, 0.1, 0.18);
    ctx.onFinish({ period: PULSE_PERIOD, meanInterval, sdInterval });
  }

  ready();
  return {
    el,
    destroy() {
      alive = false;
      running = false;
    },
  };
}

/* =========================================================================
   5. THE ODD ONE OUT — attention  (TYPE B, per-player variant)
   ========================================================================= */

const ODD_GLYPHS = ["▲", "◆", "⬟", "◤", "✚", "❖"];
const ODD_PUZZLES = 5;
const ODD_GRID = 8;
const ODD_LIMIT_MS = 9000;

function makeOdd(ctx) {
  const next = rng(ctx.seed + ":odd");
  let puzzle = 0;
  let solved = 0;
  let t0 = performance.now();
  let current = null;
  let liveBar = null;
  let timer = 0;
  let alive = true;
  const el = shell([]);

  function makePuzzle() {
    const glyph = ODD_GLYPHS[Math.floor(next() * ODD_GLYPHS.length)];
    const angle = [30, 25, 20, 15, 11][puzzle] ?? 12;
    const dir = next() > 0.5 ? 1 : -1;
    const oddIndex = Math.floor(next() * ODD_GRID * ODD_GRID);
    return { glyph, angle: angle * dir, oddIndex };
  }

  function render(p) {
    const grid = h("div", {
      class: "odd-grid",
      style: { gridTemplateColumns: `repeat(${ODD_GRID}, 1fr)` },
    });
    const cells = [];
    for (let i = 0; i < ODD_GRID * ODD_GRID; i++) {
      const isOdd = i === p.oddIndex;
      const span = h("span", {
        text: p.glyph,
        style: {
          display: "inline-block",
          transform: isOdd ? `rotate(${p.angle}deg)` : "none",
          fontSize: "clamp(13px,3.6vw,24px)",
          color: isOdd ? "#ffd469" : "#a9b6e0",
          lineHeight: "1",
        },
      });
      const cell = h("div", { class: "odd-cell", onclick: () => choose(i, cells) }, span);
      cells.push(cell);
      grid.append(cell);
    }
    liveBar = timedBar("min(460px,92vw)", ODD_LIMIT_MS / 1000);
    liveBar.el.style.marginTop = "14px";
    mount(
      el,
      h("h3", { text: `Puzzle ${puzzle + 1} of ${ODD_PUZZLES}` }),
      h("p", { class: "instr", text: "Sixty-four shapes. One is turned. Find it." }),
      grid,
      liveBar.el,
      note(`${solved} found · Speed earns points`)
    );
    liveBar.start();
    timer = window.setTimeout(() => choose(-1, cells), ODD_LIMIT_MS);
  }

  function choose(i, cells) {
    clearTimeout(timer);
    liveBar?.stop();
    if (!alive) return;
    if (i === current.oddIndex) {
      solved++;
      cells?.[i]?.classList.add("hit");
      beep(880, 0.08, 0.18);
    } else {
      cells?.[current.oddIndex]?.classList.add("miss");
      beep(200, 0.16, 0.18);
    }
    puzzle++;
    timer = setTimeout(() => {
      if (!alive) return;
      if (puzzle >= ODD_PUZZLES) {
        const totalSeconds = (performance.now() - t0) / 1000;
        return ctx.onFinish({ solved, totalSeconds: Math.round(totalSeconds * 10) / 10 });
      }
      current = makePuzzle();
      render(current);
    }, 720);
  }

  function ready() {
    mount(
      el,
      h("h3", { text: "The Odd One Out" }),
      h("p", {
        class: "instr",
        text: `Five grids. In each one, a single shape is very slightly rotated. Find it before the bar runs out. Later grids are harder.`,
      }),
      primaryBtn("Begin", begin, "btn btn-green btn-lg"),
      note("Attention, not schooling. This tests the eye you were born with.")
    );
  }

  function begin() {
    t0 = performance.now();
    puzzle = 0;
    solved = 0;
    current = makePuzzle();
    render(current);
  }

  ready();
  return {
    el,
    destroy() {
      alive = false;
      clearTimeout(timer);
      liveBar?.stop();
    },
  };
}

/* =========================================================================
   6. WHAT COMES NEXT — pattern  (TYPE B, per-player variant)
   ========================================================================= */

const P_SHAPES = ["●", "▲", "■", "◆", "★", "✦"];
const P_COLORS = ["#f7b32b", "#00a651", "#ff6b4a", "#7c5cff", "#4aa8ff"];
const PATTERN_COUNT = 6;

function shapeNode(sym, color, size = 1, rot = 0) {
  return h("span", {
    text: sym,
    style: {
      color,
      fontSize: `calc(clamp(20px, 6vw, 34px) * ${size})`,
      display: "inline-block",
      transform: `rotate(${rot}deg)`,
      lineHeight: "1",
    },
  });
}

/** Six culturally-neutral pattern families. Shapes, colour, size, count only. */
function makePatternPuzzle(next, idx) {
  const family = idx % 6;
  const A = P_SHAPES[Math.floor(next() * P_SHAPES.length)];
  let B = P_SHAPES[Math.floor(next() * P_SHAPES.length)];
  while (B === A) B = P_SHAPES[Math.floor(next() * P_SHAPES.length)];
  const c1 = P_COLORS[Math.floor(next() * P_COLORS.length)];
  let c2 = P_COLORS[Math.floor(next() * P_COLORS.length)];
  while (c2 === c1) c2 = P_COLORS[Math.floor(next() * P_COLORS.length)];

  const items = [];
  let answer;
  const distractors = [];

  if (family === 0) {
    // Colour cycles through three.
    const colours = [c1, c2, P_COLORS[(P_COLORS.indexOf(c1) + 2) % P_COLORS.length]];
    for (let i = 0; i < 5; i++) items.push(shapeNode(A, colours[i % 3]));
    answer = shapeNode(A, colours[5 % 3]);
    for (const c of P_COLORS) if (c !== colours[5 % 3]) distractors.push(shapeNode(A, c));
  } else if (family === 1) {
    // Two shapes alternating.
    for (let i = 0; i < 5; i++) items.push(shapeNode(i % 2 ? B : A, c1));
    answer = shapeNode(A, c1);
    for (const s of P_SHAPES) if (s !== A) distractors.push(shapeNode(s, c1));
  } else if (family === 2) {
    // Growing, then resetting to small.
    const sizes = [1, 1.25, 1.5, 1.75, 1];
    for (let i = 0; i < 5; i++) items.push(shapeNode(A, c1, sizes[i]));
    answer = shapeNode(A, c1, 1.25);
    distractors.push(shapeNode(A, c1, 1), shapeNode(A, c1, 1.5), shapeNode(A, c1, 1.75));
  } else if (family === 3) {
    // Repeating count of 1,2,3.
    const groups = [1, 2, 3, 1];
    for (let g = 0; g < 4; g++) {
      const wrap = h("span", {
        style: {
          display: "inline-flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "2px",
        },
      });
      for (let k = 0; k < groups[g]; k++) wrap.append(shapeNode(A, c1, 0.8));
      items.push(wrap);
    }
    answer = (() => {
      const w = h("span", { style: { display: "inline-flex", flexDirection: "column", alignItems: "center", gap: "2px" } });
      for (let k = 0; k < 2; k++) w.append(shapeNode(A, c1, 0.8));
      return w;
    })();
    for (const g of [1, 2, 3]) {
      const w = h("span", { style: { display: "inline-flex", flexDirection: "column", alignItems: "center", gap: "2px" } });
      for (let k = 0; k < g; k++) w.append(shapeNode(A, c1, 0.8));
      if (g !== 2) distractors.push(w);
    }
  } else if (family === 4) {
    // Rotation stepping 0, 45, 90, 135, 180 → 225.
    for (let i = 0; i < 5; i++) items.push(shapeNode("▲", c1, 1, i * 45));
    answer = shapeNode("▲", c1, 1, 225);
    for (const a of [45, 90, 315]) distractors.push(shapeNode("▲", c1, 1, a));
  } else {
    // Shape and colour both step together through a 3-cycle.
    const shapes = [A, B, P_SHAPES[(P_SHAPES.indexOf(A) + 3) % P_SHAPES.length]];
    const cols = [c1, c2, P_COLORS[(P_COLORS.indexOf(c2) + 1) % P_COLORS.length]];
    for (let i = 0; i < 5; i++) items.push(shapeNode(shapes[i % 3], cols[i % 3]));
    answer = shapeNode(shapes[2], cols[2]);
    distractors.push(
      shapeNode(shapes[2], cols[0]),
      shapeNode(shapes[0], cols[2]),
      shapeNode(shapes[1], cols[1])
    );
  }

  // Keep only genuinely different distractors, then top up.
  const seen = new Set([answer.outerHTML]);
  const opts = [answer];
  for (const d of distractors) {
    if (opts.length >= 4) break;
    if (seen.has(d.outerHTML)) continue;
    seen.add(d.outerHTML);
    opts.push(d);
  }
  let guard = 0;
  while (opts.length < 4 && guard++ < 40) {
    const filler = shapeNode(
      P_SHAPES[Math.floor(next() * P_SHAPES.length)],
      P_COLORS[Math.floor(next() * P_COLORS.length)],
      1,
      Math.floor(next() * 8) * 45
    );
    if (seen.has(filler.outerHTML)) continue;
    seen.add(filler.outerHTML);
    opts.push(filler);
  }

  // Shuffle options, remembering the correct one.
  const order = [];
  for (let i = 0; i < opts.length; i++) order.push(i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const shuffled = order.map((i) => opts[i]);
  const correctIndex = shuffled.indexOf(answer);

  return { items, options: shuffled, correctIndex };
}

function makePattern(ctx) {
  const next = rng(ctx.seed + ":pattern");
  let puzzle = 0;
  let solved = 0;
  let t0 = performance.now();
  let current = null;
  let liveBar = null;
  let timer = 0;
  let alive = true;
  const el = shell([]);

  function render(p) {
    const strip = h("div", {
      class: "row",
      style: { gap: "clamp(6px,2.4vw,18px)", justifyContent: "center", margin: "8px 0 4px" },
    });
    p.items.forEach((it) => strip.append(h("span", { style: { display: "inline-flex" } }, it)));
    strip.append(
      h("span", {
        text: "?",
        style: {
          color: "#f7b32b",
          fontSize: "clamp(24px,7vw,40px)",
          display: "inline-block",
          fontFamily: "Anton, sans-serif",
        },
      })
    );

    const grid = h("div", { class: "choice-grid", style: { maxWidth: "520px", gridTemplateColumns: "1fr 1fr" } });
    p.options.forEach((opt, i) => {
      grid.append(
        h(
          "button",
          { class: "choice", style: { justifyContent: "center", minHeight: "72px" }, onclick: () => choose(i, grid) },
          h("span", { class: "key", text: String(i + 1) }),
          h("span", { style: { display: "inline-flex" } }, opt)
        )
      );
    });

    liveBar = timedBar("min(520px,92vw)", 20);
    liveBar.el.style.margin = "12px 0";
    mount(
      el,
      h("h3", { text: `Rule ${puzzle + 1} of ${PATTERN_COUNT}` }),
      h("p", { class: "instr", text: "What comes next?" }),
      strip,
      liveBar.el,
      grid,
      note(`${solved} correct · Faster answers score higher`)
    );
    liveBar.start();
    timer = window.setTimeout(() => choose(-1), 20200);

    const onKey = (ev) => {
      if (/^[1-4]$/.test(ev.key)) choose(Number(ev.key) - 1, grid);
    };
    document.addEventListener("keydown", onKey);
    el._cleanupKey = () => document.removeEventListener("keydown", onKey);
  }

  function choose(i, grid) {
    clearTimeout(timer);
    liveBar?.stop();
    el._cleanupKey?.();
    if (!alive) return;
    const hit = i === current.correctIndex;
    if (hit) solved++;
    const btns = grid ? [...grid.querySelectorAll("button")] : [];
    if (btns.length) {
      btns.forEach((b, n) => {
        if (n === current.correctIndex) b.style.borderColor = "var(--ng-green)";
        else if (n === i) b.style.borderColor = "var(--bad)";
      });
    }
    beep(hit ? 880 : 200, 0.1, 0.18);
    puzzle++;
    timer = setTimeout(() => {
      if (!alive) return;
      if (puzzle >= PATTERN_COUNT) {
        const totalSeconds = (performance.now() - t0) / 1000;
        return ctx.onFinish({ solved, totalSeconds: Math.round(totalSeconds * 10) / 10 });
      }
      current = makePatternPuzzle(next, puzzle);
      render(current);
    }, 850);
  }

  function ready() {
    mount(
      el,
      h("h3", { text: "What Comes Next" }),
      h("p", {
        class: "instr",
        text: "Six sequences, each obeying a hidden rule. Work out the rule and choose what comes next. Shapes and colours only — no words, no numbers, no flags.",
      }),
      primaryBtn("Begin", begin, "btn btn-green btn-lg"),
      note("Culturally neutral by design. The same puzzle is fair in every country.")
    );
  }

  function begin() {
    t0 = performance.now();
    puzzle = 0;
    solved = 0;
    current = makePatternPuzzle(next, 0);
    render(current);
  }

  ready();
  return {
    el,
    destroy() {
      alive = false;
      clearTimeout(timer);
      liveBar?.stop();
      el._cleanupKey?.();
    },
  };
}

/* =========================================================================
   7. THINK LIKE EARTH — social intuition  (TYPE B)
   ========================================================================= */

function makeWisdom(ctx) {
  let timer = 0;
  let alive = true;
  let liveBar = null;
  const el = shell([]);

  function render(question) {
    liveBar = timedBar("min(460px,92vw)", 20);
    liveBar.el.style.marginTop = "10px";
    const grid = h("div", { class: "choice-grid" });
    question.options.forEach((opt, i) => {
      grid.append(
        h(
          "button",
          { class: "choice", onclick: () => choose(i) },
          h("span", { class: "key", text: String(i + 1) }),
          h("span", { text: opt })
        )
      );
    });
    mount(
      el,
      h("h3", { text: "Think Like Earth" }),
      h("p", { class: "instr", style: { fontSize: "1.12rem", color: "#f4f7ff" }, text: question.q }),
      grid,
      liveBar.el,
      note("Answer for yourself — then you score the share of the world that agreed with you.")
    );
    liveBar.start();
    timer = window.setTimeout(() => choose(0), 20400);

    const onKey = (e) => {
      if (/^[1-4]$/.test(e.key)) choose(Number(e.key) - 1);
    };
    document.addEventListener("keydown", onKey);
    el._cleanupKey = () => document.removeEventListener("keydown", onKey);
  }

  function choose(i) {
    clearTimeout(timer);
    liveBar?.stop();
    el._cleanupKey?.();
    if (!alive) return;
    beep(760, 0.08, 0.18);
    ctx.onFinish({ choice: i });
  }

  render(ctx.question);
  return {
    el,
    destroy() {
      alive = false;
      clearTimeout(timer);
      liveBar?.stop();
      el._cleanupKey?.();
    },
  };
}

/* ---------------------------------------------------------------- registry */

export function buildGame(disciplineId, ctx) {
  const seed = ctx.seed || variantSeed(ctx.roundId, "world");
  const full = { ...ctx, seed };
  switch (disciplineId) {
    case "time": return makeTime(full);
    case "jar": return makeJar(full);
    case "sequence": return makeSequence(full);
    case "pulse": return makePulse(full);
    case "odd": return makeOdd(full);
    case "pattern": return makePattern(full);
    case "wisdom": return makeWisdom(full);
    default: {
      const el = h("div", { class: "muted", text: "This discipline is not available yet." });
      return { el, destroy() {} };
    }
  }
}
