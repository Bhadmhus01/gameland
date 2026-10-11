/**
 * Colour vision science, for testing that AYO's palette is fair.
 *
 * This exists so the fairness claim is measured rather than asserted. It is
 * test-only tooling — the game itself never needs to simulate colour blindness,
 * because by design no discipline ever requires colour to be read.
 *
 * Simulation uses the Machado, Oliveira & Fernandes (2009) matrices at full
 * severity, which are the standard published approximation for the three
 * dichromacies. Achromatopsia is handled as relative luminance, which is what
 * someone with no colour perception actually sees.
 */

/* ------------------------------------------------------------ sRGB <-> linear */

const toLinear = (c) =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

const toSrgb = (c) =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;

function hexToRgb(hex) {
  const s = hex.replace("#", "");
  const full =
    s.length === 3
      ? s
          .split("")
          .map((ch) => ch + ch)
          .join("")
      : s;
  return [
    parseInt(full.slice(0, 2), 16) / 255,
    parseInt(full.slice(2, 4), 16) / 255,
    parseInt(full.slice(4, 6), 16) / 255,
  ];
}

/* ------------------------------------------------------------------- CVD sim */

export const CVD = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.011820, 0.042940, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.303900],
  ],
};

const applyMatrix = (m, [r, g, b]) => [
  m[0][0] * r + m[0][1] * g + m[0][2] * b,
  m[1][0] * r + m[1][1] * g + m[1][2] * b,
  m[2][0] * r + m[2][1] * g + m[2][2] * b,
];

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** Simulate a colour as seen with a given vision type. Returns sRGB 0..1. */
export function simulate(hex, type) {
  const rgb = hexToRgb(hex);
  const lin = rgb.map(toLinear);

  if (type === "normal") return rgb;

  if (type === "achromatopsia") {
    // Rec. 709 relative luminance — the world in greys.
    const y = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    return [y, y, y].map((v) => clamp01(toSrgb(clamp01(v))));
  }

  const out = applyMatrix(CVD[type], lin).map((v) => clamp01(v));
  return out.map((v) => clamp01(toSrgb(v)));
}

/* ----------------------------------------------------------- perceptual distance */

const D65 = [0.95047, 1.0, 1.08883];

function rgbToLab([r, g, b]) {
  const lin = [toLinear(r), toLinear(g), toLinear(b)];
  const x = 0.4124564 * lin[0] + 0.3575761 * lin[1] + 0.1804375 * lin[2];
  const y = 0.2126729 * lin[0] + 0.7151522 * lin[1] + 0.072175 * lin[2];
  const z = 0.0193339 * lin[0] + 0.119192 * lin[1] + 0.9503041 * lin[2];

  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x / D65[0]);
  const fy = f(y / D65[1]);
  const fz = f(z / D65[2]);

  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE76 colour difference. ~2.3 is a just-noticeable difference. */
export function deltaE(hexA, hexB, type = "normal") {
  const a = rgbToLab(simulate(hexA, type));
  const b = rgbToLab(simulate(hexB, type));
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** The closest pair in a palette under a given vision type. */
export function closestPair(palette, type = "normal") {
  let worst = { a: null, b: null, dE: Infinity };
  for (let i = 0; i < palette.length; i++) {
    for (let j = i + 1; j < palette.length; j++) {
      const dE = deltaE(palette[i], palette[j], type);
      if (dE < worst.dE) worst = { a: palette[i], b: palette[j], dE };
    }
  }
  return worst;
}

/* --------------------------------------------------------- luminance helper */

export function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export const VISION_TYPES = [
  "normal",
  "protanopia",
  "deuteranopia",
  "tritanopia",
  "achromatopsia",
];
