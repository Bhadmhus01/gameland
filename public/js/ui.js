/** Tiny DOM helpers — no framework, no build step. */

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k === "text") el.textContent = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on") && typeof v === "function") {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === "dataset" && typeof v === "object") {
      Object.assign(el.dataset, v);
    } else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(9)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function mount(el, ...kids) {
  clear(el);
  el.append(...kids.flat(9).filter(Boolean));
  return el;
}

/* ------------------------------------------------------------------- toasts */

let toastWrap = null;

export function toast(message, kind = "") {
  if (!toastWrap) {
    toastWrap = h("div", { class: "toast-wrap" });
    document.body.append(toastWrap);
  }
  const t = h("div", { class: `toast ${kind}`, text: message });
  toastWrap.append(t);
  setTimeout(() => {
    t.style.transition = "opacity .3s, transform .3s";
    t.style.opacity = "0";
    t.style.transform = "translateY(10px)";
    setTimeout(() => t.remove(), 320);
  }, 2800);
  return t;
}

/* -------------------------------------------------------------------- sheet */

export function sheet({ title, subtitle, body, onClose }) {
  const back = h("div", { class: "sheet-back" });
  const panel = h(
    "div",
    { class: "sheet" },
    h(
      "div",
      { class: "sheet-head" },
      h(
        "div",
        { class: "spread" },
        h(
          "div",
          {},
          title ? h("h3", { text: title }) : null,
          subtitle ? h("div", { class: "muted small", style: { marginTop: "6px" }, text: subtitle }) : null
        ),
        h("button", {
          class: "btn btn-ghost btn-sm",
          text: "Close",
          onclick: () => close(),
        })
      )
    ),
    h("div", { class: "sheet-body" }, body)
  );
  back.append(panel);

  function close() {
    back.style.opacity = "0";
    setTimeout(() => back.remove(), 160);
    document.removeEventListener("keydown", onKey);
    onClose?.();
  }
  function onKey(e) {
    if (e.key === "Escape") close();
  }
  back.addEventListener("click", (e) => {
    if (e.target === back) close();
  });
  document.addEventListener("keydown", onKey);
  document.body.append(back);
  return { close, el: panel };
}

/* ------------------------------------------------------------------ effects */

export function buzz(ms = 12) {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* not supported */
  }
}

export function confetti(colors = ["#f7b32b", "#00a651", "#ff6b4a", "#7c5cff", "#f4f7ff"]) {
  const canvas = h("canvas", { class: "confetti" });
  document.body.append(canvas);
  const ctx = canvas.getContext("2d");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = (canvas.width = canvas.clientWidth * dpr);
  const hgt = (canvas.height = canvas.clientHeight * dpr);

  const parts = Array.from({ length: 130 }, () => ({
    x: Math.random() * w,
    y: -Math.random() * hgt * 0.4,
    vx: (Math.random() - 0.5) * 2.4 * dpr,
    vy: (2 + Math.random() * 3.4) * dpr,
    s: (3 + Math.random() * 5) * dpr,
    r: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.24,
    c: colors[Math.floor(Math.random() * colors.length)],
  }));

  const start = performance.now();
  function frame(t) {
    if (t - start > 2600) {
      canvas.remove();
      return;
    }
    ctx.clearRect(0, 0, w, hgt);
    for (const p of parts) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.035 * dpr;
      p.r += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      ctx.fillStyle = p.c;
      ctx.globalAlpha = Math.max(0, 1 - (t - start) / 2600);
      ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.62);
      ctx.restore();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/* ------------------------------------------------------------------ helpers */

export function shuffle(arr, rnd = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function pick(arr, rnd = Math.random) {
  return arr[Math.floor(rnd() * arr.length)];
}

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export function fmt(n) {
  return Number(n || 0).toLocaleString("en-US");
}

export function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
