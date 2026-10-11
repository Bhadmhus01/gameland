/**
 * The five screens.
 * Today · The Global Board · Nigeria → The World · The Fairness Charter · Your Tower
 */

import { COUNTRIES, REGIONS, flag, nameOf, BY_ISO } from "./countries.js";
import {
  DISCIPLINES,
  DISCIPLINE_BY_ID,
  percentile,
  secondsUntilReveal,
  roundIdOf,
} from "./engine.js";
import { api } from "./api.js";
import { store } from "./store.js";
import { h, mount, sheet, toast, confetti, fmt, ordinal, buzz } from "./ui.js";
import { buildGame } from "./games.js";

/**
 * Is this board row me?
 *
 * By account id where both sides have one, because that is what identity now
 * means and it survives a rename. The name pair is the fallback for rows
 * written before accounts existed.
 */
function isMe(row) {
  const acc = store.account;
  if (acc.id && row.accountId) return row.accountId === acc.id;
  return row.pseudo === store.identity.pseudo && row.iso === store.identity.iso;
}

/**
 * The name rules, mirrored from the server so a player is told before they
 * play rather than after. The server is still the authority — this only moves
 * the bad news earlier. Keep the two in step: `cleanName` in server.mjs.
 */
const NAME_OK = /^[\p{L}\p{M}\p{N} '._-]{3,18}$/u;
const NAME_BLOCKED = /nigg|fagg|kike|spic|chink|wetback|tranny|rape|paedo|pedo|nazi|hitler|kkk|jihad|terroris|fuck|fck|shit|sh1t|cunt|whore|slut|porn|viagra|casino/;
const NAME_RESERVED = /(^|[^a-z])(ayo|official|admin|support|moderator|staff|helpdesk)([^a-z]|$)/;

function nameProblem(raw) {
  const name = String(raw || "").trim().replace(/\s+/g, " ");
  if (name.length < 3) return "A nickname needs at least 3 characters.";
  if (name.length > 18) return "A nickname can be at most 18 characters.";
  if (!NAME_OK.test(name)) return "Letters, numbers, spaces and _ - . ' only — no symbols.";
  const letters = [...name.matchAll(/\p{L}/gu)].map((m) => m[0].toLowerCase());
  if (letters.length < 3) return "A nickname needs at least 3 letters.";
  if (new Set(letters).size < 3) return "Try a name with a bit more variety than that.";
  const flat = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (NAME_BLOCKED.test(flat)) return "That nickname is not allowed. Please pick another.";
  const words = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.some((w) => NAME_RESERVED.test(w))) return "That nickname is reserved. Please pick another.";
  return "";
}
import * as analytics from "./analytics.js";

/* ------------------------------------------------------------------ helpers */

function countdownText(secs) {
  if (secs <= 0) return "closing now";
  const hh = Math.floor(secs / 3600);
  const mm = Math.floor((secs % 3600) / 60);
  const ss = secs % 60;
  return hh > 0 ? `${hh}h ${mm}m` : `${mm}m ${String(ss).padStart(2, "0")}s`;
}

export function liveCountdown() {
  const el = h("span", { class: "countdown" });
  const tick = () => {
    el.textContent = countdownText(secondsUntilReveal());
  };
  tick();
  const id = setInterval(tick, 1000);
  el._stop = () => clearInterval(id);
  return el;
}

export function openIdentitySheet(app, onDone) {
  const guessRegion = (() => {
    try {
      return new Intl.Locale(navigator.language).region || "";
    } catch {
      return "";
    }
  })();

  let selected = store.identity.iso || (BY_ISO.has(guessRegion) ? guessRegion : "");
  let pseudo = store.identity.pseudo || "";

  const searchInput = h("input", {
    class: "input",
    placeholder: "Search 190+ countries…",
    value: "",
  });
  const list = h("div", { class: "country-list" });
  const chosenChip = h("div", { class: "pill gold", text: selected ? `${flag(selected)} ${nameOf(selected)}` : "No country selected" });

  function renderList(filter = "") {
    const f = filter.trim().toLowerCase();
    const matching = COUNTRIES.filter(
      (c) => !f || c[0].toLowerCase().includes(f) || c[1].toLowerCase() === f
    ).sort((a, b) => {
      if (a[1] === "NG") return -1;
      if (b[1] === "NG") return 1;
      return a[0].localeCompare(b[0]);
    });
    const top = [];
    if (!f && !matching.some((c) => c[1] === "NG")) top.push(["Nigeria", "NG", 232, "AF"]);
    mount(
      list,
      [...top, ...matching].slice(0, 200).map((c) =>
        h(
          "button",
          {
            class: `country-item ${c[1] === selected ? "pinned" : ""} ${c[1] === "NG" ? "pinned" : ""}`,
            onclick: () => {
              selected = c[1];
              chatUpdate();
            },
          },
          h("span", { class: "flag", text: flag(c[1]) }),
          h("span", { text: c[0] }),
          h("span", { class: "iso", text: c[1] + (c[1] === "NG" ? " · home" : "") })
        )
      )
    );
  }

  function chatUpdate() {
    mount(chosenChip, h("span", { text: `${flag(selected)} ${nameOf(selected)}` }));
    renderList(searchInput.value);
  }

  searchInput.addEventListener("input", () => renderList(searchInput.value));

  const body = h(
    "div",
    {},
    h(
      "div",
      { class: "field" },
      h("label", { text: "Your nickname" }),
      h("input", {
        class: "input",
        maxlength: "18",
        placeholder: "e.g. Ada_of_Lagos",
        value: pseudo,
        oninput: (e) => (pseudo = e.target.value),
      }),
      h("div", {
        class: "tiny muted",
        style: { marginTop: "6px" },
        text: "No email. No phone number. No password. Just a name and a nation.",
      })
    ),
    h("div", { class: "field" }, h("label", { text: "Your country" }), chosenChip),
    searchInput,
    h("div", { style: { height: "10px" } }),
    list
  );

  let panelRef;
  const footer = h(
    "div",
    { style: { marginTop: "16px", display: "flex", gap: "10px" } },
    h("button", {
      class: "btn btn-primary btn-block",
      text: "Take my place",
      onclick: () => {
        const p = String(pseudo || "").trim().replace(/\s+/g, " ");
        // Checked here as well as on the server, because finding out after
        // playing a round that your name is not allowed means losing the round.
        const why = nameProblem(p);
        if (why) return toast(why, "err");
        if (!selected || !BY_ISO.has(selected)) return toast("Choose your country.", "err");
        store.setIdentity(p, selected);
        toast(`Welcome, ${p}. Playing for ${nameOf(selected)}.`, "ok");
        panelRef?.close();
        onDone?.();
        app?.rerender?.();
      },
    })
  );
  body.append(footer);

  renderList("");
  const s = sheet({
    title: "Take your place",
    subtitle: "You compete for one country. Choose it once — you can change it later.",
    body,
  });
  panelRef = s;
}

/* ==========================================================================
   TODAY
   ========================================================================== */

export function viewToday(app) {
  const { round, myResult } = app.state;
  const root = h("div", { class: "stack" });

  if (!round) {
    root.append(
      h(
        "div",
        { class: "card center" },
        h("div", { class: "spinner", style: { margin: "0 auto 14px" } }),
        h("p", { class: "muted", text: "Loading today's round…" })
      )
    );
    return root;
  }

  const d = round.discipline;
  const meta = DISCIPLINE_BY_ID.get(d.id);
  const played = !!myResult;

  /* ---------------------------------------------------------------- hero */
  const cdown = liveCountdown();
  root._cleanups = [() => cdown._stop?.()];

  const hero = h(
    "div",
    { class: "hero" },
    h(
      "div",
      { class: "card glow" },
      h(
        "div",
        { class: "round-tag" },
        h("span", { class: "dot" }),
        `Round ${round.roundNumber} · ${round.date}`,
        h("span", { style: { opacity: 0.5 } }, "·"),
        h("span", {}, "closes in ", cdown)
      ),
      h("div", { class: "eyebrow", text: `Today's faculty · ${meta.faculty}` }),
      h("h1", { text: d.name }),
      h("p", { class: "lede", style: { marginTop: "14px" }, text: d.blurb }),
      h("div", { class: "band-soft", style: { margin: "18px 0" } }),
      h("p", { class: "muted small", text: d.why }),
      h(
        "div",
        { class: "row wraprow", style: { marginTop: "20px" } },
        h("span", { class: "pill green", text: meta.shareable ? "Same task worldwide" : "Unshareable by design" }),
        h("span", { class: "pill", text: `${fmt(round.playerCount)} humans tonight` }),
        h("span", { class: "pill", text: `${fmt(round.countryCount)} nations` })
      )
    ),
    h(
      "div",
      { class: "card", style: { display: "flex", flexDirection: "column", gap: "14px" } },
      h("div", { class: "tiny-up muted", text: "The rules of this game" }),
      h("p", { class: "small", style: { color: "#c8d2f2" }, text: d.how }),
      h("div", { class: "band-soft" }),
      played
        ? h(
            "div",
            { class: "stack", style: { gap: "10px" } },
            h("div", { class: "tiny-up muted", text: "Tonight you scored" }),
            h("div", {
              class: "reveal-score",
              style: { fontSize: "clamp(3rem,14vw,4.6rem)" },
              text: String(myResult.score),
            }),
            h("div", { class: "row" }, h("span", { class: "pill gold", text: `Top ${(100 - myResult.percentile).toFixed(1)}% globally` })),
            h("button", {
              class: "btn btn-ghost btn-block",
              text: "Practise again (unscored)",
              onclick: () => startGame(app, { practice: true }),
            })
          )
        : h(
            "div",
            { class: "stack", style: { gap: "12px" } },
            h("button", {
              class: "btn btn-primary btn-lg btn-block",
              text: "Play today's round",
              onclick: () => startGame(app, { practice: false }),
            }),
            h("div", {
              class: "tiny muted center",
              text: "One scored attempt per day. Practising later never overwrites it.",
            })
          )
    )
  );
  root.append(hero);

  /* -------------------------------------------------------------- stage */
  const stageHost = h("div", { class: "stack", id: "stageHost" });
  root.append(stageHost);

  function startGame(appRef, { practice }) {
    if (!store.hasIdentity) {
      openIdentitySheet(appRef, () => startGame(appRef, { practice }));
      return;
    }
    const host = stageHost;
    const stage = h("div", { class: "stage" });
    mount(host, stage);

    let game;
    const ctx = {
      roundId: round.roundId,
      seed: round.seed,
      question: round.question,
      onFinish: async (raw) => {
        game?.destroy();
        stage.remove();
        if (practice) {
          toast("That was practice — your scored attempt stands.", "ok");
          return;
        }
        await submit(appRef, raw, host);
      },
    };
    if (!practice) analytics.track("start");
    game = buildGame(d.id, ctx);
    mount(stage, game.el);
    // Mounted first, scrolled second: if scrolling is unavailable the game is
    // still playable rather than stranded off-screen.
    try {
      stage.scrollIntoView?.({ behavior: "smooth", block: "center" });
    } catch {
      /* not supported — the round still works */
    }
    (root._cleanups || (root._cleanups = [])).push(() => game?.destroy());
  }

  async function submit(appRef, raw, host) {
    const loading = h(
      "div",
      { class: "stage center" },
      h("div", { class: "spinner", style: { margin: "0 auto 16px" } }),
      h("p", { class: "muted", text: "The world is counting…" })
    );
    mount(host, loading);

    const identity = store.identity;
    try {
      const res = await api.submit({
        date: round.date,
        roundId: round.roundId,
        discipline: d.id,
        pseudo: identity.pseudo,
        country: identity.iso,
        raw,
        // The credential, if this device has one. No token at all is what makes
        // a new account; a wrong token is refused rather than quietly becoming
        // one, which is what stops it buying a second attempt.
        token: store.account.token || undefined,
      });
      // A first score is when the server issues an account. Keep it, and show
      // the recovery code once, while the player is looking at the screen.
      if (res.account) {
        store.setAccount(res.account);
        appRef.state.freshCode = res.account.code;
      }
      const streak = store.bumpStreak(round.date);
      analytics.track("finish");
      store.saveResult(round.roundId, {
        score: res.score,
        percentile: res.percentile,
        discipline: d.id,
        raw,
      });
      appRef.state.myResult = store.todayResult(round.date);
      appRef.state.myResult.streak = streak;
      mount(host, reveal(appRef, res, streak));
      if (res.score >= 700) confetti();
      appRef.refresh({ silent: true });
    } catch (err) {
      if (err.queued) {
        mount(
          host,
          h(
            "div",
            { class: "card center" },
            h("h3", { text: "Saved on your device" }),
            h("p", {
              class: "muted",
              text: "The connection dropped. Your result is stored and will be sent the moment you are back online — it will still count for today.",
            })
          )
        );
        return;
      }
      mount(
        host,
        h(
          "div",
          { class: "card center" },
          h("h3", { text: "That did not go through" }),
          h("p", { class: "muted", text: String(err.message || err) }),
          h("button", { class: "btn btn-ghost", text: "Try again", onclick: () => submit(appRef, raw, host) })
        )
      );
    }
  }

  return root;
}

/* ------------------------------------------------------------ the reveal */

function reveal(app, res, streak) {
  const d = DISCIPLINE_BY_ID.get(res.discipline);
  const topPct = (100 - res.percentile).toFixed(1);
  const shareText =
    `AYO — Round ${app.state.round.roundNumber} · ${d?.name || res.discipline}\n` +
    `${flag(store.identity.iso)} ${nameOf(store.identity.iso)} · ${store.identity.pseudo}\n` +
    `Scored ${res.score}/1000 — better than ${res.percentile}% of the world tonight.\n` +
    `Can your country out-think mine? ${location.origin}`;

  const wrap = h("div", { class: "stack" });

  const dist = app.state.board?.distribution || null;

  // The one moment the recovery code is shown without being asked for: right
  // after a player's first score, when they have something worth keeping. It
  // stays in My Tower afterwards.
  if (app.state.freshCode) {
    const code = app.state.freshCode;
    app.state.freshCode = null;
    wrap.append(
      h(
        "div",
        { class: "card", style: { borderColor: "rgba(255,212,0,.45)" } },
        h("div", { class: "eyebrow", text: "Save this" }),
        h("h3", { text: "Your tower needs a key" }),
        h("p", {
          class: "small muted",
          style: { marginTop: "8px" },
          text:
            "This is your account — one line of text. Write it down or send it to yourself. " +
            "If you lose this phone, or clear your browser, this code is the only way back to " +
            "your scores and your streak. It is not a password you can reset, because we never " +
            "asked you for an email.",
        }),
        h("div", {
          text: code,
          style: {
            fontFamily: "Anton, sans-serif",
            fontSize: "clamp(18px,5vw,26px)",
            letterSpacing: ".08em",
            margin: "12px 0",
            wordBreak: "break-all",
          },
        }),
        h("button", {
          class: "btn ghost small",
          text: "Copy my key",
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(code);
              toast("Key copied. Keep it somewhere you will find it.", "ok");
            } catch {
              toast("Select the code and copy it by hand.", "err");
            }
          },
        })
      )
    );
  }

  wrap.append(
    h(
      "div",
      { class: "card glow", style: { textAlign: "center" } },
      h("div", { class: "tiny-up muted", text: `${d?.name || res.discipline} · Round ${app.state.round.roundNumber}` }),
      h("div", { class: "reveal-score", text: String(res.score) }),
      h("div", { class: "verdict", text: res.verdict }),
      h(
        "div",
        { class: "row", style: { justifyContent: "center", marginTop: "10px", flexWrap: "wrap" } },
        h("span", { class: "pill gold", text: `Top ${topPct}% of the world` }),
        res.rank ? h("span", { class: "pill green", text: `${ordinal(res.rank)} of ${fmt(res.scoreable)} tonight` }) : null,
        resumeStreakPill(streak)
      ),
      h(
        "div",
        { class: "stat-row", style: { marginTop: "22px", textAlign: "left" } },
        h("div", { class: "stat gold" }, h("b", { text: String(res.score) }), h("span", { text: "Your score" })),
        h("div", { class: "stat green" }, h("b", { text: fmt(res.world.players) }), h("span", { text: "Humans tonight" })),
        h("div", { class: "stat" }, h("b", { text: fmt(res.world.countries) }), h("span", { text: "Nations" })),
        h("div", { class: "stat coral" }, h("b", { text: fmt(res.world.median) }), h("span", { text: "World median" }))
      ),
      h(
        "div",
        { class: "share-strip", style: { marginTop: "22px" } },
        h("button", {
          class: "btn btn-green",
          text: "Challenge your country",
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(shareText);
              toast("Copied. Now paste it where your people will see it.", "ok");
            } catch {
              toast(shareText, "ok");
            }
          },
        }),
        h("button", {
          class: "btn btn-ghost",
          text: "See the global board",
          onclick: () => app.go("board"),
        })
      )
    )
  );

  if (res.wisdom) {
    const total = res.wisdom.reduce((a, b) => a + b, 0) || 1;
    const q = app.state.round.question;
    wrap.append(
      h(
        "div",
        { class: "card" },
        h("div", { class: "eyebrow", text: "How Earth answered" }),
        h("h3", { style: { marginBottom: "16px" }, text: q.q }),
        h(
          "div",
          { class: "stack", style: { gap: "14px" } },
          q.options.map((opt, i) => {
            const pctv = Math.round((res.wisdom[i] / total) * 1000) / 10;
            return h(
              "div",
              {},
              h(
                "div",
                { class: "spread", style: { marginBottom: "6px" } },
                h("span", { class: "small", style: { fontWeight: 700 }, text: opt }),
                h("span", { class: "mono small", text: `${pctv}%` })
              ),
              h("div", { class: "meter" }, h("i", { style: { width: pctv + "%" } }))
            );
          })
        ),
        h("p", {
          class: "muted small",
          style: { marginTop: "16px" },
          text: "This answer key did not exist until humanity wrote it, hour by hour, around the planet.",
        })
      )
    );
  }

  if (dist && dist.reduce((a, b) => a + b, 0) > 0) {
    const labels = ["0–199", "200–399", "400–599", "600–799", "800–1000"];
    const max = Math.max(...dist);
    const bucket = Math.min(4, Math.floor(res.score / 200));
    wrap.append(
      h(
        "div",
        { class: "card" },
        h("div", { class: "eyebrow", text: "Where you stand tonight" }),
        h(
          "div",
          {
            class: "row",
            style: { alignItems: "flex-end", gap: "10px", height: "140px", marginTop: "10px" },
          },
          dist.map((n, i) =>
            h(
              "div",
              { style: { flex: "1", display: "flex", flexDirection: "column", justifyContent: "flex-end", gap: "6px", height: "100%" } },
              h("div", {
                style: {
                  height: Math.max(4, (n / max) * 100) + "%",
                  borderRadius: "8px 8px 4px 4px",
                  background:
                    i === bucket
                      ? "linear-gradient(180deg, #ffd469, #f7b32b)"
                      : "linear-gradient(180deg, rgba(42,53,96,.95), rgba(21,29,59,.7))",
                  border: i === bucket ? "1px solid #ffd469" : "1px solid var(--line-soft)",
                },
              }),
              h("div", { class: "tiny muted center", text: labels[i] })
            )
          )
        ),
        h("p", { class: "muted small", style: { marginTop: "12px" }, text: "Bars show every player tonight — humans and demo nations combined." })
      )
    );
  }

  return wrap;
}

function resumeStreakPill(streak) {
  if (!streak || streak < 2) return null;
  return h("span", { class: "pill coral", text: `${streak}-day streak` });
}

/* ==========================================================================
   THE GLOBAL BOARD
   ========================================================================== */

export function viewBoard(app) {
  const root = h("div", { class: "stack" });
  const board = app.state.board;
  if (!board) {
    root.append(h("div", { class: "card center" }, h("div", { class: "spinner", style: { margin: "0 auto" } })));
    return root;
  }

  let scope = app.state.boardScope || "world";

  const tabsRow = h("div", { class: "tabs", role: "tablist" });
  const panel = h("div", { class: "stack" });

  const scopes = [
    ["world", "World"],
    ["country", "National"],
    ["percapita", "Per human"],
  ];

  function renderTabs() {
    mount(
      tabsRow,
      scopes.map(([id, label]) =>
        h("button", {
          class: "tab",
          role: "tab",
          "aria-selected": String(scope === id),
          text: label,
          onclick: () => {
            scope = id;
            app.state.boardScope = id;
            renderTabs();
            renderPanel();
          },
        })
      )
    );
  }

  function renderPanel() {
    if (scope === "percapita") return mount(panel, perCapitaPanel(app, board));
    if (scope === "country") return mount(panel, nationalPanel(app, board));
    return mount(panel, worldPanel(app, board));
  }

  root.append(
    h(
      "div",
      { class: "card" },
      h("div", { class: "eyebrow", text: `Round ${board.roundId.slice(1)} · ${board.date}` }),
      h("h2", { text: "The Global Board" }),
      h("p", {
        class: "muted",
        style: { marginTop: "8px" },
        text: "Every nation that played tonight, ranked. Countries with one player compete on equal terms with countries with a million — that is the whole idea.",
      }),
      h(
        "div",
        { class: "stat-row", style: { marginTop: "18px" } },
        h("div", { class: "stat gold" }, h("b", { text: fmt(board.world.players) }), h("span", { text: "Humans" })),
        h("div", { class: "stat green" }, h("b", { text: fmt(board.world.countries) }), h("span", { text: "Nations" })),
        h("div", { class: "stat" }, h("b", { text: fmt(board.world.avg) }), h("span", { text: "World average" })),
        h("div", { class: "stat coral" }, h("b", { text: fmt(board.medianScore) }), h("span", { text: "World median" }))
      ),
      h("div", {
        class: "tiny muted",
        style: { marginTop: "14px" },
        text: "Nations marked demo have no real players yet — a simulated field keeps their table alive until the game launches there. The Plays column counts real people wherever any exist.",
      })
    )
  );

  renderTabs();
  renderPanel();
  root.append(tabsRow, panel);
  return root;
}

function worldPanel(app, board) {
  const countriesCard = h(
    "div",
    { class: "card" },
    h("div", { class: "spread" }, h("h3", { text: "Nations by median" }),
      h("span", { class: "pill", text: "min. 10 plays" })),
    h("p", { class: "muted small", style: { marginTop: "8px" },
      text: "The median is the exact middle player in a country. Population cannot inflate it and one genius cannot carry it — only depth can move it." }),
    h("div", { style: { height: "12px" } }),
    h(
      "div",
      { class: "scroll-y" },
      h(
        "table",
        { class: "table" },
        h("thead", {}, h("tr", {},
          h("th", { text: "#" }), h("th", { text: "Nation" }),
          h("th", { class: "num", text: "Plays" }), h("th", { class: "num", text: "Median" }),
          h("th", { class: "num", text: "Avg" }))),
        h(
          "tbody",
          {},
          board.countries
            .filter((c) => c.players >= 10)
            .slice(0, 40)
            .map((c, i) =>
              h(
                "tr",
                { class: c.iso === store.identity.iso ? "me" : "" },
                h("td", { class: "rank", text: String(i + 1) }),
                h("td", {}, h("div", { class: "who" },
                  h("span", { class: "flag", text: flag(c.iso) }),
                  h("b", { text: c.country }),
                  c.demo ? h("span", { class: "pill demo", text: "demo" }) : null)),
                h("td", { class: "num small muted", text: c.humans ? fmt(c.humans) : fmt(c.players) }),
                h("td", { class: "num score-cell", text: String(c.median) }),
                h("td", { class: "num muted", text: String(c.avg) })
              )
            )
        )
      )
    )
  );

  const playersCard = h(
    "div",
    { class: "card" },
    h("div", { class: "spread" }, h("h3", { text: "Tonight's top humans" }), h("span", { class: "pill gold", text: "Live" })),
    h("div", { style: { height: "12px" } }),
    h(
      "div",
      { class: "scroll-y" },
      h(
        "table",
        { class: "table" },
        h("thead", {}, h("tr", {},
          h("th", { text: "#" }), h("th", { text: "Player" }),
          h("th", { class: "num", text: "Score" }))),
        h(
          "tbody",
          {},
          (board.topHumans || board.players.filter((p) => !p.demo))
            .slice(0, 40)
            .map((p) =>
              h(
                "tr",
                { class: isMe(p) ? "me" : "" },
                h("td", { class: "rank", text: String(p.rank) }),
                h("td", {}, h("div", { class: "who" },
                  h("span", { class: "flag", text: flag(p.iso) }),
                  h("b", { text: p.pseudo }),
                  h("span", { class: "tiny muted", text: p.iso }))),
                h("td", { class: "num score-cell", text: String(p.score) })
              )
            )
        )
      )
    ),
    (board.topHumans || []).length === 0
      ? h("p", { class: "muted small", text: "No real players have finished tonight's round yet. Be the very first." })
      : null
  );

  const demoCard = h(
    "div",
    { class: "card" },
    h("div", { class: "spread" }, h("h3", { text: "Demo nations" }), h("span", { class: "pill demo", text: "Simulated" })),
    h("p", {
      class: "muted small",
      style: { marginTop: "10px" },
      text: "So the board is never a ghost town while the game rolls out. Blended into the ranking above and clearly labelled everywhere.",
    }),
    h("div", { style: { height: "12px" } }),
    h(
      "div",
      { class: "scroll-y", style: { maxHeight: "300px" } },
      h(
        "table",
        { class: "table" },
        h("tbody", {},
          board.players.filter((p) => p.demo).slice(0, 30).map((p) =>
            h("tr", {},
              h("td", { class: "rank", text: String(p.rank) }),
              h("td", {}, h("div", { class: "who" },
                h("span", { class: "flag", text: flag(p.iso) }),
                h("b", { text: p.pseudo }),
                h("span", { class: "pill demo", text: "demo" }))),
              h("td", { class: "num score-cell", text: String(p.score) })))
        )
      )
    )
  );

  return h("div", { class: "grid-2" }, countriesCard, playersCard, demoCard, perCapitaMini(app, board));
}

function nationalPanel(app, board) {
  let iso = app.state.nationalIso || store.identity.iso || "NG";
  const panel = h("div", { class: "stack" });

  const picker = h(
    "select",
    {
      class: "input",
      onchange: (e) => {
        iso = e.target.value;
        app.state.nationalIso = iso;
        draw();
      },
    },
    COUNTRIES.slice().sort((a, b) => a[0].localeCompare(b[0])).map((c) =>
      h("option", { value: c[1], selected: c[1] === iso, text: `${flag(c[1])} ${c[0]}` })
    )
  );

  function draw() {
    const country = board.countries.find((c) => c.iso === iso);
    const worldAvg = board.world.avg || 1;
    const myAvg = country?.avg || 0;
    const delta = myAvg - worldAvg;

    mount(
      panel,
      h(
        "div",
        { class: "card" },
        h("div", { class: "eyebrow", text: "National table" }),
        h("div", { class: "row", style: { marginBottom: "16px" } }, h("div", { class: "grow" }, picker)),
        h(
          "div",
          { class: "stat-row" },
          h("div", { class: "stat gold" }, h("b", { text: country ? String(country.median) : "—" }), h("span", { text: "National median" })),
          h("div", { class: "stat green" }, h("b", { text: fmt(country?.players || 0) }), h("span", { text: "Plays tonight" })),
          h("div", { class: "stat" }, h("b", { text: myAvg ? String(myAvg) : "—" }), h("span", { text: "National average" })),
          h("div", { class: delta >= 0 ? "stat green" : "stat coral" },
            h("b", { text: (delta >= 0 ? "+" : "") + Math.round(delta) }),
            h("span", { text: delta >= 0 ? "Above the world" : "Below the world" }))
        )
      ),
      h(
        "div",
        { class: "card" },
        h("h3", { text: "Nations in tonight's round" }),
        h("div", { style: { height: "12px" } }),
        h(
          "div",
          { class: "scroll-y" },
          h(
            "table",
            { class: "table" },
            h("thead", {}, h("tr", {}, h("th", { text: "#" }), h("th", { text: "Nation" }), h("th", { class: "num", text: "Median" }))),
            h("tbody", {},
              board.countries.slice(0, 40).map((c, i) =>
                h("tr", { class: c.iso === iso ? "me" : "" },
                  h("td", { class: "rank", text: String(i + 1) }),
                  h("td", {}, h("div", { class: "who" }, h("span", { class: "flag", text: flag(c.iso) }), h("b", { text: c.country }))),
                  h("td", { class: "num score-cell", text: String(c.median) }))))
          )
        )
      )
    );
  }

  draw();
  return panel;
}

function perCapitaPanel(app, board) {
  const rows = board.perCapita || [];
  const myIso = store.identity.iso;
  const myRow = rows.find((r) => r.iso === myIso);

  return h(
    "div",
    { class: "stack" },
    h(
      "div",
      { class: "card glow" },
      h("div", { class: "eyebrow", text: "The level playing field" }),
      h("h2", { text: "Per human, not per headcount" }),
      h("p", {
        class: "lede",
        style: { marginTop: "12px" },
        text: "Population cannot win a game. So nations are ranked by their best twenty-five players divided by their population to the quarter power — a gentle adjustment, not a lottery. A nation of a few million can genuinely beat a nation of a billion.",
      }),
      h("p", {
        class: "muted small",
        text: "The median column beside it is stricter still: the exact middle player in the country. Only depth moves it.",
      }),
      myRow
        ? h(
            "div",
            { class: "stat-row", style: { marginTop: "18px" } },
            h("div", { class: "stat gold" }, h("b", { text: String(myRow.avgTop25) }), h("span", { text: `${myRow.country} top-25 average` })),
            h("div", { class: "stat green" }, h("b", { text: String(myRow.index) }), h("span", { text: "Per-human index" })),
            h("div", { class: "stat" }, h("b", { text: "#" + (rows.indexOf(myRow) + 1) }), h("span", { text: "Of ranked nations" }))
          )
        : null,
      h("p", { class: "tiny muted", style: { marginTop: "14px" }, text: "Minimum 25 plays to qualify. Population is floored at one million so no nation wins merely for being tiny." })
    ),
    h(
      "div",
      { class: "card" },
      h("h3", { text: "Per-human index" }),
      h("div", { style: { height: "12px" } }),
      h(
        "div",
        { class: "scroll-y" },
        h(
          "table",
          { class: "table" },
          h("thead", {}, h("tr", {},
            h("th", { text: "#" }), h("th", { text: "Nation" }),
            h("th", { class: "num", text: "Plays" }), h("th", { class: "num", text: "Median" }),
            h("th", { class: "num", text: "Index" }))),
          h("tbody", {},
            rows.slice(0, 40).map((r, i) =>
              h("tr", { class: r.iso === myIso ? "me" : "" },
                h("td", { class: "rank", text: String(i + 1) }),
                h("td", {}, h("div", { class: "who" }, h("span", { class: "flag", text: flag(r.iso) }), h("b", { text: r.country }))),
                h("td", { class: "num small muted", text: fmt(r.players) }),
                h("td", { class: "num muted", text: String(r.median) }),
                h("td", { class: "num score-cell", text: String(r.index) }))))
        )
      )
    )
  );
}

function perCapitaMini(app, board) {
  const rows = (board.perCapita || []).slice(0, 5);
  return h(
    "div",
    { class: "card" },
    h("div", { class: "spread" }, h("h3", { text: "Per human, top 5" }), h("span", { class: "pill green", text: "Population-proof" })),
    h("div", { style: { height: "12px" } }),
    h(
      "table",
      { class: "table" },
      h("tbody", {},
        rows.map((r, i) =>
          h("tr", {},
            h("td", { class: "rank", text: String(i + 1) }),
            h("td", {}, h("div", { class: "who" }, h("span", { class: "flag", text: flag(r.iso) }), h("b", { text: r.country }))),
            h("td", { class: "num score-cell", text: String(r.index) }))))
    ),
    h("p", { class: "tiny muted", style: { marginTop: "10px" }, text: "Best 25 scores ÷ population^¼. Minimum 25 plays." })
  );
}

/* ==========================================================================
   NIGERIA → THE WORLD
   ========================================================================== */

export function viewNigeria(app) {
  const root = h("div", { class: "stack" });
  const data = app.state.nigeria;
  const iso = store.identity.iso;
  const onHomeTeam = iso === "NG";

  root.append(
    h(
      "div",
      { class: "card glow hero" },
      h(
        "div",
        {},
        h("div", { class: "eyebrow", text: "Made in Lagos · Built for the world" }),
        h("h1", { text: "Nigeria → The World" }),
        h("p", {
          class: "lede",
          style: { marginTop: "14px" },
          text: "AYO was built in Nigeria, for one reason: a game that is fair to everybody has to be invented somewhere that has never been the default. The mechanic is universal. The point of view is ours.",
        }),
        h(
          "div",
          { class: "row wraprow", style: { marginTop: "18px" } },
          h("span", { class: "pill green", text: "🇳🇬 Nigeria is the home team" }),
          h("span", { class: "pill gold", text: "Launch nation" })
        )
      ),
      h(
        "div",
        { class: "card flat", style: { background: "rgba(7,11,24,.5)" } },
        h("div", { class: "tiny-up muted", text: "If you are Nigerian" }),
        h("p", { class: "small", style: { marginTop: "10px", color: "#c8d2f2" },
          text: "Your country needs depth, not heroes. One spectacular player cannot carry a nation here — the formula rewards the twenty-fifth best Nigerian. Recruit your group chat. That is how a country climbs." }),
        h("button", {
          class: "btn btn-ghost btn-sm",
          text: onHomeTeam ? "Change my country" : "Play for Nigeria",
          onclick: () => openIdentitySheet(app, () => app.refresh()),
        })
      )
    )
  );

  if (!data) {
    root.append(h("div", { class: "card center" }, h("div", { class: "spinner", style: { margin: "0 auto" } })));
    return root;
  }

  root.append(
    h(
      "div",
      { class: "card" },
      h("div", { class: "eyebrow", text: "Tonight" }),
      h(
        "div",
        { class: "stat-row" },
        h("div", { class: "stat green" }, h("b", { text: fmt(data.todayPlays) }), h("span", { text: "Nigerian plays tonight" })),
        h("div", { class: "stat gold" }, h("b", { text: data.todayAvg ? String(data.todayAvg) : "—" }), h("span", { text: "Nigeria's average" })),
        h("div", { class: "stat" }, h("b", { text: data.rank ? "#" + data.rank : "—" }), h("span", { text: "All-time world rank" })),
        h("div", { class: "stat coral" }, h("b", { text: fmt(data.totalRounds) }), h("span", { text: "Rounds played" }))
      )
    )
  );

  if (data.faculty?.length) {
    root.append(
      h(
        "div",
        { class: "card" },
        h("div", { class: "eyebrow", text: "Nigeria's tower" }),
        h("h3", { text: "Which faculty do we own?" }),
        h("div", { style: { height: "14px" } }),
        h(
          "div",
          {},
          data.faculty.map((f) =>
            h(
              "div",
              { class: "faculty-row" },
              h("span", { class: "nm", text: f.faculty }),
              h("div", { class: "meter grow" }, h("i", { style: { width: (f.avg / 10) + "%" } })),
              h("span", { class: "mono small", style: { width: "52px", textAlign: "right" }, text: String(f.avg) }),
              h("span", { class: "tiny muted", style: { width: "58px", textAlign: "right" }, text: `${f.rounds} rds` })
            )
          )
        )
      )
    );
  }

  root.append(
    h(
      "div",
      { class: "grid-2" },
      h(
        "div",
        { class: "card" },
        h("div", { class: "spread" }, h("h3", { text: "Nations, all-time" }), h("span", { class: "pill", text: "Average of round averages" })),
        h("div", { style: { height: "12px" } }),
        h(
          "div",
          { class: "scroll-y" },
          h(
            "table",
            { class: "table" },
            h("tbody", {},
              (data.peerRanking || []).map((r, i) =>
                h("tr", { class: r.iso === "NG" ? "me" : r.iso === iso ? "me" : "" },
                  h("td", { class: "rank", text: String(i + 1) }),
                  h("td", {}, h("div", { class: "who" },
                    h("span", { class: "flag", text: flag(r.iso) }),
                    h("b", { text: r.country }),
                    r.iso === "NG" ? h("span", { class: "pill green", text: "home" }) : null)),
                  h("td", { class: "num score-cell", text: String(r.avg) }))))
          )
        )
      ),
      h(
        "div",
        { class: "card" },
        h("div", { class: "spread" }, h("h3", { text: "Nigerian wall" }), h("span", { class: "pill gold", text: "Live" })),
        h("p", { class: "muted small", style: { marginTop: "8px" }, text: "Every Nigerian who has finished tonight's round, as it happens." }),
        h("div", { style: { height: "10px" } }),
        h(
          "div",
          { class: "scroll-y", style: { maxHeight: "420px" } },
          h(
            "table",
            { class: "table" },
            h("tbody", {},
              (app.state.board?.players || [])
                .filter((p) => p.iso === "NG")
                .slice(0, 60)
                .map((p) =>
                  h("tr", {},
                    h("td", { class: "rank", text: String(p.rank) }),
                    h("td", {}, h("div", { class: "who" },
                      h("b", { text: p.pseudo }),
                      p.demo ? h("span", { class: "pill demo", text: "demo" }) : null)),
                    h("td", { class: "num score-cell", text: String(p.score) }))))
          )
        ),
        h("div", { style: { height: "12px" } }),
        h("button", {
          class: "btn btn-green btn-block",
          text: "Bring one more Nigerian",
          onclick: async () => {
            const txt = `AYO — the world plays one round every day at midnight UTC.\nI'm playing for Nigeria. Nation needs your score, not your excuses.\n${location.origin}`;
            try {
              await navigator.clipboard.writeText(txt);
              toast("Copied. Send it to your people.", "ok");
            } catch {
              toast(txt, "ok");
            }
          },
        })
      )
    )
  );

  if (data.series?.length) {
    root.append(
      h(
        "div",
        { class: "card" },
        h("div", { class: "eyebrow", text: "Nigeria's record" }),
        h("h3", { text: "Every round we have played" }),
        h("div", { style: { height: "12px" } }),
        h(
          "div",
          { class: "scroll-y" },
          h(
            "table",
            { class: "table" },
            h("thead", {}, h("tr", {},
              h("th", { text: "Round" }), h("th", { text: "Discipline" }),
              h("th", { class: "num", text: "Plays" }), h("th", { class: "num", text: "Average" }))),
            h("tbody", {},
              data.series.slice().reverse().map((s) =>
                h("tr", {},
                  h("td", { class: "rank", text: "#" + s.roundNumber }),
                  h("td", {}, h("div", { class: "who" },
                    h("b", { text: s.disciplineName }),
                    h("span", { class: "tiny muted", text: s.faculty }))),
                  h("td", { class: "num small muted", text: fmt(s.plays) }),
                  h("td", { class: "num score-cell", text: String(s.avg) }))))
          )
        )
      )
    );
  }

  return root;
}

/* ==========================================================================
   THE FAIRNESS CHARTER
   ========================================================================== */

export function viewRules(app) {
  const root = h("div", { class: "stack" });

  root.append(
    h(
      "div",
      { class: "card" },
      h("div", { class: "eyebrow", text: "The Fairness Charter" }),
      h("h1", { text: "Why this game is fair" }),
      h("p", {
        class: "lede",
        style: { marginTop: "16px" },
        text: "Most games that claim to be global are really games of language, schooling and bandwidth. AYO is built so that a farmer in Kebbi and a banker in Zurich start the same round with the same chance.",
      })
    )
  );

  const charter = [
    ["1. One world, one round",
      "Every human plays the identical discipline on the same UTC day. No local variants, no regional difficulty, no exceptions."],
    ["2. Nobody can buy a score",
      "Every discipline measures something money cannot fix — time sense, memory span, rhythm, attention, estimation. There is no equipment to upgrade and no subscription to buy."],
    ["3. Free, and light",
      "The whole game runs in a browser on any phone. It works on a slow connection and queues your score when the network drops."],
    ["4. No knowledge required",
      "No letters, no numbers, no flags, no brands, no trivia. Nothing here is taught in any school on Earth, so schooling cannot decide a round."],
    ["5. Population cannot win",
      "Nations are also ranked per human, using the square root of population. A country of forty million can beat a country of a billion."],
    ["6. You cannot copy a country",
      "Half the disciplines are physically unshareable, and the other half are regenerated per player from a private seed."],
    ["7. The answer key is humanity",
      "In Think Like Earth the correct answer is whatever the world actually chose, hour by hour. No expert decides it."],
    ["8. Honest about simulation",
      "While the game rolls out to new territories, simulated demo players keep the board alive. They are labelled ⚡ everywhere, and never called human."],
    ["9. Colour is never the answer",
      "Every shape carries a fixed colour, and no discipline is ever decided by colour. The attention and pattern rounds are provably solvable with colour vision removed — that is enforced by an automated test, not by intention. An earlier version of this game failed that test and was rebuilt."],
    ["10. Honest about ability, too",
      "Six of the seven disciplines need only sight or touch. Think Like Earth is the one whose content is language: its question and all four options can be read aloud on any device that offers speech, so it can be answered without reading. Instructions elsewhere are still text, and translated interfaces are on the roadmap — we would rather say that than imply a barrier has been removed when it has not."],
  ];

  root.append(
    h(
      "div",
      { class: "card" },
      h(
        "div",
        { class: "glossary" },
        charter.flatMap(([t, b]) => [h("dt", { text: t }), h("dd", { text: b })])
      )
    )
  );

  root.append(
    h(
      "div",
      { class: "card" },
      h("div", { class: "eyebrow", text: "The seven faculties" }),
      h("h3", { text: "What the world is tested on" }),
      h("div", { style: { height: "14px" } }),
      h(
        "div",
        { class: "stack", style: { gap: "16px" } },
        DISCIPLINES.map((d) =>
          h(
            "div",
            { class: "faculty-row", style: { alignItems: "flex-start", flexDirection: "column", gap: "4px" } },
            h("div", { class: "row wraprow", style: { width: "100%" } },
              h("span", { class: "pill gold", text: d.faculty }),
              h("b", { style: { fontFamily: "Anton, sans-serif", fontSize: "1.05rem", letterSpacing: ".04em" }, text: d.name }),
              h("span", { class: "pill", style: { marginLeft: "auto" }, text: d.shareable ? "variant per player" : "identical for all" }),
              h("span", { class: "pill green", text: `needs: ${(d.needs || []).join(" + ")}` })),
            h("p", { class: "small muted", style: { margin: "2px 0 0" }, text: d.how }),
            h("p", { class: "tiny", style: { color: "#8b98c6", margin: 0 }, text: d.why })
          )
        )
      )
    )
  );

  /* --- what we count ------------------------------------------------
   * The instrument is described here in the same place as the charter,
   * because a game that asks to be trusted about fairness should be equally
   * upfront about being watched. It is switchable, in one tap. */
  root.append(
    h(
      "div",
      { class: "card" },
      h("div", { class: "eyebrow", text: "Counting" }),
      h("h3", { text: "What we measure, and what we never do" }),
      h("p", {
        class: "small muted",
        style: { marginTop: "10px" },
        text:
          "To know whether this game is worth your time tomorrow, we count one thing: " +
          "whether people come back. That is four fields — an event, a time, the round, " +
          "and a random id made on your device. No name, no country, no score, and no " +
          "third party of any kind. Nothing is sold, and nothing is shared.",
      }),
      h(
        "div",
        { class: "row wraprow", style: { marginTop: "14px", gap: "10px" } },
        (() => {
          const label = h("span", { class: "pill", text: "" });
          const paint = () => {
            const on = analytics.currentPreference();
            label.textContent = on ? "counting: on" : "counting: off";
            label.className = "pill " + (on ? "green" : "coral");
          };
          paint();
          const caption = (on) => (on ? "Turn counting off" : "Turn counting on");
          const btn = h("button", {
            class: "btn ghost small",
            text: caption(analytics.currentPreference()),
            onclick: () => {
              const now = !analytics.currentPreference();
              analytics.setPreference(now);
              btn.textContent = caption(now);
              paint();
              toast(
                now
                  ? "Thank you — that is genuinely useful."
                  : "Counting off. Nothing you do is recorded.",
                "ok"
              );
            },
          });
          return [label, btn];
        })()
      ),
      h("p", {
        class: "tiny",
        style: { marginTop: "10px", color: "#8b98c6" },
        text: "Do Not Track is honoured automatically, and turning counting off deletes anything queued immediately. The operator's own report never contains an id.",
      })
    )
  );

  root.append(
    h(
      "div",
      { class: "grid-2" },
      h(
        "div",
        { class: "card" },
        h("h3", { text: "What we refuse to do" }),
        h(
          "ul",
          { class: "small", style: { color: "#c8d2f2", paddingLeft: "18px", margin: "12px 0 0", lineHeight: "1.9" } },
          h("li", { text: "No pay-to-win. Ever. Not for a nationality, not for a player." }),
          h("li", { text: "No adverts deciding who is on the board." }),
          h("li", { text: "No selling personal data. There is barely any to sell." }),
          h("li", { text: "No hidden country weighting. The formula is published." }),
          h("li", { text: "No fake humans. Simulated players are labelled." })
        )
      ),
      h(
        "div",
        { class: "card" },
        h("h3", { text: "The calibration promise" }),
        h("p", {
          class: "small",
          style: { color: "#c8d2f2", marginTop: "12px" },
          text: "Every discipline is scored so that the median player on Earth earns about 500 out of 1000, with a published curve based on established human-performance research.",
        }),
        h("p", {
          class: "small",
          style: { color: "#c8d2f2" },
          text: "At the close of each season, the curves are re-fitted to live global data. If a discipline turns out to favour one region for cultural reasons, it is rewritten or retired — in public, with the numbers shown.",
        }),
        h("div", { class: "band-soft", style: { margin: "16px 0" } }),
        h("p", {
          class: "tiny muted",
          text: "This is the promise that makes it a world championship rather than an export: we change the game for the world, not the world for the game.",
        })
      )
    )
  );

  root.append(
    h(
      "div",
      { class: "card center" },
      h("h3", { text: "Ready?" }),
      h("p", { class: "muted", text: "One round. One world. Every day at midnight UTC." }),
      h("button", { class: "btn btn-primary btn-lg", text: "Play today's round", onclick: () => app.go("today") })
    )
  );

  return root;
}

/* ==========================================================================
   YOUR TOWER — personal career
   ========================================================================== */

/**
 * Your account, in the open: the key that brings this tower to another phone,
 * and the way to use one.
 *
 * This exists because accounts make a new promise, and a promise with no visible
 * mechanism is a claim. A player who cannot find their own key does not have one.
 */
function accountCard(app) {
  const card = h("div", { class: "card" });
  const paint = () => {
    const acc = store.account;
    card.replaceChildren(
      h("div", { class: "eyebrow", text: "Your account" }),
      h("h3", { text: "One line of text is your tower" }),
      h("p", {
        class: "small muted",
        style: { marginTop: "8px" },
        text: store.hasAccount
          ? "Your scores belong to this account, not to this phone. If you lose the phone, this key brings them back."
          : "Play one round and you get an account, with a key like this.",
      })
    );

    if (store.hasAccount) {
      card.append(
        h("div", {
          style: {
            fontFamily: "Anton, sans-serif",
            fontSize: "clamp(17px,4.6vw,24px)",
            letterSpacing: ".08em",
            margin: "12px 0",
            wordBreak: "break-all",
          },
          text: acc.code || "(code hidden — recover with the key you saved)",
        }),
        h(
          "div",
          { class: "row wraprow", style: { gap: "10px" } },
          h("button", {
            class: "btn ghost small",
            text: "Copy my key",
            onclick: async () => {
              try {
                await navigator.clipboard.writeText(acc.code);
                toast("Key copied.", "ok");
              } catch {
                toast("Select the code and copy it by hand.", "err");
              }
            },
          }),
          h("span", { class: "pill", text: `id ${acc.id}` })
        )
      );
    }

    // Bring a tower here from another device.
    const input = h("input", {
      class: "input",
      placeholder: "AYO-XXXX-XXXX-XXXX",
      autocapitalize: "characters",
      spellcheck: "false",
      style: { marginTop: "16px", textTransform: "uppercase" },
    });
    const go = h("button", {
      class: "btn btn-primary small",
      text: "Bring it here",
      onclick: async () => {
        const code = String(input.value || "").trim().toUpperCase();
        if (!code) return toast("Type the key from your other device.", "err");
        if (!store.hasAccount) return toast("Take a name and country first.", "err");
        go.disabled = true;
        go.textContent = "Looking…";
        try {
          const res = await api.recover(code);
          store.setAccount({ id: res.accountId, token: res.token, code: res.code });
          toast("Welcome back. This device is now your tower.", "ok");
          paint();
          app?.refresh?.();
        } catch (err) {
          toast(
            err?.data?.error === "bad_code"
              ? "That key did not match an account. Check for typos."
              : "Could not reach the server. Try again in a moment.",
            "err"
          );
        } finally {
          go.disabled = false;
          go.textContent = "Bring it here";
        }
      },
    });
    card.append(
      h("div", { class: "tiny-up muted", style: { marginTop: "18px" }, text: "Playing on a new phone?" }),
      h("div", { class: "row wraprow", style: { gap: "10px", marginTop: "6px" } }, input, go)
    );
  };
  paint();
  return card;
}

export function viewCareer(app) {
  const root = h("div", { class: "stack" });
  const local = store.history(60);
  const id = store.identity;

  root.append(accountCard(app));

  root.append(
    h(
      "div",
      { class: "card" },
      h("div", { class: "eyebrow", text: "Your tower" }),
      h(
        "div",
        { class: "row" },
        h("span", { class: "flag", style: { fontSize: "40px" }, text: flag(id.iso || "NG") }),
        h(
          "div",
          {},
          h("h2", { text: id.pseudo || "Unnamed player" }),
          h("div", { class: "muted small", text: id.iso ? nameOf(id.iso) : "Pick your country" })
        )
      ),
      h("div", { style: { height: "18px" } }),
      h(
        "div",
        { class: "stat-row" },
        h("div", { class: "stat gold" }, h("b", { text: fmt(app.state.nigeriaSelf?.total || local.reduce((a, b) => a + b.score, 0)) }), h("span", { text: "Career points" })),
        h("div", { class: "stat green" }, h("b", { text: String(app.state.nigeriaSelf?.played || local.length) }), h("span", { text: "Rounds played" })),
        h("div", { class: "stat" }, h("b", { text: String(app.state.nigeriaSelf?.average || (local.length ? Math.round(local.reduce((a, b) => a + b.score, 0) / local.length) : 0)) }), h("span", { text: "Your average" })),
        h("div", { class: "stat coral" }, h("b", { text: String(store.all.streak?.count || 0) }), h("span", { text: "Day streak" }))
      ),
      h("div", { style: { height: "14px" } }),
      h("button", {
        class: "btn btn-ghost btn-sm",
        text: "Edit nickname or country",
        onclick: () => openIdentitySheet(app, () => app.refresh()),
      })
    )
  );

  const history = app.state.nigeriaSelf?.history?.length ? app.state.nigeriaSelf.history : local;

  if (!history.length) {
    root.append(
      h(
        "div",
        { class: "card center" },
        h("h3", { text: "No rounds yet" }),
        h("p", { class: "muted", text: "Play today's round and your tower starts to rise." }),
        h("button", { class: "btn btn-primary", text: "Play now", onclick: () => app.go("today") })
      )
    );
    return root;
  }

  const best = Math.max(...history.map((x) => x.score), 1);

  root.append(
    h(
      "div",
      { class: "card" },
      h("div", { class: "eyebrow", text: "Round by round" }),
      h(
        "div",
        { class: "stack", style: { gap: "10px", marginTop: "12px" } },
        history.slice().reverse().map((x) =>
          h(
            "div",
            { class: "row", style: { gap: "14px" } },
            h("span", { class: "mono small muted", style: { width: "52px" }, text: "#" + (x.roundNumber || "—") }),
            h("div", { class: "grow" },
              h("div", { class: "small", style: { fontWeight: 700 }, text: x.disciplineName || DISCIPLINE_BY_ID.get(x.discipline)?.name || x.discipline }),
              h("div", { class: "meter", style: { marginTop: "6px" } }, h("i", { style: { width: (x.score / best) * 100 + "%" } }))),
            h("span", { class: "score-cell", style: { width: "56px", textAlign: "right" }, text: String(x.score) })
          )
        )
      )
    )
  );

  const fac = app.state.nigeriaSelf?.faculty || [];
  if (fac.length) {
    root.append(
      h(
        "div",
        { class: "card" },
        h("div", { class: "eyebrow", text: "Your faculties" }),
        h("p", { class: "muted small", text: "Where you are strongest across the seven disciplines." }),
        h("div", { style: { height: "12px" } }),
        fac.map((f) =>
          h(
            "div",
            { class: "faculty-row" },
            h("span", { class: "nm", text: f.faculty }),
            h("div", { class: "meter grow" }, h("i", { style: { width: f.avg / 10 + "%" } })),
            h("span", { class: "mono small", style: { width: "52px", textAlign: "right" }, text: String(f.avg) })
          )
        )
      )
    );
  }

  root.append(
    h(
      "div",
      { class: "card" },
      h("h3", { text: "Your data, your call" }),
      h("p", {
        class: "muted small",
        style: { marginTop: "10px" },
        text: "Everything on this page lives on this device. The server only ever receives a nickname, a country and a score for the day.",
      }),
      h("button", {
        class: "btn btn-ghost btn-sm",
        text: "Erase everything on this device",
        onclick: () => {
          store.reset();
          toast("Local profile erased.", "ok");
          app.refresh();
        },
      })
    )
  );

  return root;
}
