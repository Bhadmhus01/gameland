/**
 * AYO — app shell.
 * Tabs, data loading, and the daily flow. No framework, no build step.
 */


import { flag, nameOf } from "./countries.js";
import { api } from "./api.js";
import { store } from "./store.js";
import { h, mount, toast } from "./ui.js";
import { track, trackOpen, installLifecycle, flush as flushEvents } from "./analytics.js";
import {
  viewToday,
  viewBoard,
  viewNigeria,
  viewRules,
  viewSeason,
  viewCareer,
  openIdentitySheet,
  liveCountdown,
} from "./views.js";

const TABS = [
  ["today", "Today"],
  ["board", "The World"],
  ["season", "Season"],
  ["nigeria", "Nigeria"],
  ["rules", "Fair Play"],
  ["career", "My Tower"],
];

/**
 * ?date=YYYY-MM-DD pins the round, for previewing a day that has not arrived.
 * Without it the server decides what "today" is, which is the normal path.
 */
const pinnedDate = (() => {
  try {
    const d = new URLSearchParams(location.search).get("date") || "";
    return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : "";
  } catch {
    return "";
  }
})();

const app = {
  state: {
    tab: "today",
    date: pinnedDate,
    round: null,
    board: null,
    boardPlayers: null,
    myResult: null,
    season: null,
    tower: null,
    nigeria: null,
    nigeriaSelf: null,
    boardScope: "world",
    nationalIso: "",
    loading: true,
  },
  go(tab) {
    if (this.state.tab === tab) return;
    this.state.tab = tab;
    location.hash = tab;
    render();
    loadTab(tab);
    window.scrollTo({ top: 0, behavior: "smooth" });
  },
  refresh(opts = {}) {
    return loadAll(opts).then(render);
  },
  rerender: () => render(),
};

/* ------------------------------------------------------------------- layout */

const topbarChip = h("div", { class: "chip", dataset: { empty: "1" } });
const tabBar = h("div", { class: "tabs", role: "tablist" });
const viewHost = h("div", { class: "view-host" });
const main = h("main", {}, h("div", { class: "wrap" }, tabBar, viewHost));
const footNext = h("span", { class: "mono" });

let cleanups = [];

function renderTopbar() {
  const id = store.identity;
  if (!store.hasIdentity) {
    topbarChip.dataset.empty = "1";
    mount(
      topbarChip,
      h("span", { text: "👤 Take your place" }),
    );
    topbarChip.onclick = () => openIdentitySheet(app, () => render());
  } else {
    topbarChip.dataset.empty = "0";
    mount(
      topbarChip,
      h("span", { class: "flag", text: flag(id.iso) }),
      h("b", { text: id.pseudo }),
      h("span", { class: "tiny muted", text: id.iso })
    );
    topbarChip.onclick = () => app.go("career");
  }
}

function renderTabs() {
  mount(
    tabBar,
    TABS.map(([id, label]) =>
      h("button", {
        class: "tab",
        role: "tab",
        "aria-selected": String(app.state.tab === id),
        text: label,
        onclick: () => app.go(id),
      })
    )
  );
}

const VIEWS = {
  today: viewToday,
  board: viewBoard,
  season: viewSeason,
  nigeria: viewNigeria,
  rules: viewRules,
  career: viewCareer,
};

function render() {
  cleanups.forEach((fn) => fn?.());
  cleanups = [];
  renderTopbar();
  renderTabs();

  const view = VIEWS[app.state.tab](app);
  // Keep the view's own cleanup list live: a game mounted later, when the player
  // presses Play, registers its teardown in the same array this reference holds.
  cleanups = view._cleanups || (view._cleanups = []);

  mount(
    viewHost,
    h("div", { class: "band-soft", style: { marginBottom: "18px" } }),
    view
  );
}

/* --------------------------------------------------------------------- data */

async function loadAll(opts = {}) {
  if (app.state.date) app.state.myResult = store.todayResult(app.state.date);
  try {
    const [round, board, season] = await Promise.all([
      api.today(app.state.date || undefined, store.identity.deviceId),
      api.leaderboard(app.state.date || undefined, "world"),
      api.season(app.state.date || undefined),
    ]);
    app.state.season = season;

    // The player's own tower, only once this device has an account. A failure
    // here must never take the season table down with it, so it is separate.
    if (store.hasAccount) {
      try {
        app.state.tower = await api.tower(store.identity.deviceId);
      } catch {
        app.state.tower = null;
      }
    } else {
      app.state.tower = null;
    }
    // Adopt the server's notion of the current round, so a pinned preview day
    // and the normal daily path behave identically from here on.
    app.state.date = round.date;
    app.state.myResult = store.todayResult(round.date);
    app.state.round = round;
    app.state.board = board;
    app.state.boardPlayers = board.players;
    app.state.loading = false;
  } catch (err) {
    if (!opts.silent) toast("Could not reach the world. Retrying…", "err");
    setTimeout(() => loadAll({ silent: true }).then(render), 4000);
  }
}

async function loadTab(tab) {
  if (tab === "nigeria") {
    try {
      const [nig, board] = await Promise.all([
        api.country("NG"),
        api.leaderboard(app.state.date, "country", "NG"),
      ]);
      app.state.nigeria = nig;
      if (!app.state.boardPlayers) app.state.boardPlayers = board.players;
      // Merge any Nigerian players beyond the world top-100.
      const merged = [...(app.state.boardPlayers || [])];
      for (const p of board.players) {
        if (!merged.some((m) => m.pseudo === p.pseudo && m.iso === p.iso)) merged.push(p);
      }
      app.state.boardPlayers = merged;
      render();
    } catch {
      toast("Nigeria's table is unavailable right now.", "err");
    }
  }
  if (tab === "career" && store.hasIdentity) {
    try {
      app.state.nigeriaSelf = await api.me(store.identity.pseudo, store.identity.iso);
      render();
    } catch {
      /* local history still renders */
    }
  }
  if (tab === "board" && !app.state.board) {
    loadAll().then(render);
  }
}

/* ------------------------------------------------------------------ startup */

function startup() {
  document.body.append(
    h("div", { class: "band thick" }),
    h(
      "div",
      { class: "shell" },
      h(
        "header",
        { class: "topbar" },
        h(
          "div",
          { class: "wrap topbar-inner" },
          h(
            "div",
            { class: "brand", onclick: () => app.go("today") },
            h("div", { class: "brand-mark", text: "AY" }),
            h(
              "div",
              { class: "brand-text" },
              h("b", { text: "AYO" }),
              h("span", { text: "The Everyday Games" })
            )
          ),
          topbarChip
        )
      ),
      main,
      h(
        "footer",
        { class: "footer" },
        h(
          "div",
          { class: "wrap" },
          h("div", { class: "band-soft", style: { marginBottom: "20px" } }),
          h(
            "div",
            { class: "spread", style: { flexWrap: "wrap", alignItems: "flex-start" } },
            h(
              "div",
              {},
              h("b", { style: { color: "#c8d2f2" }, text: "AYO — The Everyday Games" }),
              h("div", { text: "Made in Lagos. Played everywhere. One round a day, midnight UTC." }),
              h("div", { text: "Free forever. No pay-to-win. Simulated demo nations are always labelled ⚡." })
            ),
            h(
              "div",
              { style: { textAlign: "right" } },
              h("div", {}, "Next round closes in ", footNext),
              h("div", { style: { marginTop: "6px" } }, h("a", { href: "#rules", onclick: () => app.go("rules") }, "Read the Fairness Charter"))
            )
          )
        )
      )
    )
  );

  const fc = liveCountdown();
  mount(footNext.parentElement, "Next round closes in ", fc);

  const hash = location.hash.replace("#", "");
  if (TABS.some(([id]) => id === hash)) app.state.tab = hash;

  render();
  loadAll().then(() => {
    render();
    loadTab(app.state.tab);
  });

  // Flush anything queued while offline.
  api.flush();

  // The return signal, recorded as early in boot as possible: if anything
  // below fails, we still know the player opened the game today.
  trackOpen();
  // A round screen that was opened and then left without a score is the
  // single most useful failure the funnel can show us.
  window.addEventListener("beforeunload", () => {
    if (app.state.tab === "today" && !app.state.myResult) track("abandon");
    flushEvents();
  });
  installLifecycle();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
}

startup();
