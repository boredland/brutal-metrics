// Per-agent usage metrics for the selected space: context, tokens, cache, and a blink
// for agents that need a human (blocked) or are waiting on other agents.
// Data: Claude Code transcripts and Codex rollouts, read in WSL by collect.py. Read-only; no network.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { avatar, animated } from "./avatar.js";
import { HIGH, winOf, kindOfApp, isCodex, fmt, moneyOf, costTip, costOf, acctName, acctKey, turnOf, wslPath, turnsLeft, age, normPath, matchSessions } from "./model.js";
import { spaces, agents, terminals, panes, focused, exec, hc, appHome, home, window, theme, run, shared, setShared, settings } from "herdr";

// Feed for the Flow tab (agent-flow): the collector's message events, `to` resolved here by match().
const FLOW_KEY = "flow.events", FLOW_HEARTBEAT_MS = 15000;

const DISTRO = "Ubuntu";
const REFRESH_MS = 5000;
const AUTO_MS = 8000; // play: how long each tab stays before the next
// Herdr stops an exec after 30s unless told otherwise, and a first read of many long transcripts can pass that.
const COLLECT_MS = 120000;
const STUCK_MS = COLLECT_MS + 15000; // a collector run older than this is treated as hung
const scriptPath = () => wslPath(appHome()) + "/mods/agent-metrics/collect.py";

// Low-poly rainbow border for a working agent's card: flat rainbow facets, alternately lit and shaded,
// stepping one facet per tick (the avatar's 200ms timer). An overlay: no size change, takes no clicks.
const RAINBOW = ["#ff4d4d", "#ff9f43", "#ffd93d", "#4ade80", "#38bdf8", "#818cf8", "#c084fc"];
const shade = (hex, k) => "#" + [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * k).toString(16).padStart(2, "0")).join("");
const FX = 14, FY = 5, EDGE = 3;
function rainbowEdge(tick) {
  const n = 2 * (FX + FY);
  const at = (p) => { const i = (((p - tick) % n) + n) % n, b = RAINBOW[i % RAINBOW.length]; return i % 2 ? shade(b, 0.72) : b; };
  // Facets need an explicit cross size: a row centers its children instead of stretching them, so a facet
  // with only flex_1 is 0px tall and the top and bottom edges vanish.
  const hsegs = (count, pos) => Array.from({ length: count }, (_, i) => div().flex_1().h_full().bg(at(pos(i))));
  const vsegs = (count, pos) => Array.from({ length: count }, (_, i) => div().flex_1().w_full().bg(at(pos(i))));
  // One absolute strip per edge, so all four always draw: top and bottom run the width, left and right the height.
  return div().absolute().inset_0().overflow_hidden()
    .child(v_flex().absolute().inset_0().child(h_flex().w_full().h(EDGE).children(hsegs(FX, (i) => i))))
    .child(h_flex().absolute().inset_0().justify_end().child(v_flex().h_full().w(EDGE).children(vsegs(FY, (i) => FX + i))))
    .child(v_flex().absolute().inset_0().justify_end().child(h_flex().w_full().h(EDGE).children(hsegs(FX, (i) => FX + FY + (FX - 1 - i)))))
    .child(h_flex().absolute().inset_0().child(v_flex().h_full().w(EDGE).children(vsegs(FY, (i) => 2 * FX + FY + (FY - 1 - i)))));
}

export default class AgentMetrics extends View {
  init(_props, cx) {
    this.data = null;      // last collector output
    this.error = null;
    this.created = {};     // terminal address -> created_ms (never changes)
    this.width = 300;
    this.busy = false;
    this.tick = 0; this.anim = false;
    this.auto = false; this.autoAt = 0; // play/pause: rotate the tabs
    this.scope = "space"; // which agents: "space" (the shown one), "project" (the focused folder, any space), "all"
    this.view = "total"; // "total" = whole session (default), "turn" = last turn, "cost" = session cost
    // Avatars step through their poses only while some agent is active (each tick redraws the window).
    cx.timer.every(200, (cx) => { if (this.anim) { this.tick++; cx.notify(); } });
    cx.timer.every(1000, (cx) => {
      if (!this.auto || Date.now() - this.autoAt < AUTO_MS) return;
      const order = ["total", "turn", "cost"];
      this.view = order[(order.indexOf(this.view) + 1) % order.length];
      this.autoAt = Date.now();
      cx.notify();
    });
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
    this.refresh(cx);
  }

  refresh(cx) {
    // A run that hangs (hc or exec never answers) must not freeze the numbers for good: after STUCK_MS the
    // next tick starts a new run, and the stale one is ignored when it finally ends.
    if (this.busy && Date.now() - this.busySince < STUCK_MS) return;
    this.busy = true;
    this.busySince = Date.now();
    const run = (this.run = (this.run ?? 0) + 1);
    cx.spawn(async (cx) => {
      // cx.sleep is the runtime's timer (there is no setTimeout in a mod).
      const within = (p, ms) => Promise.race([p, cx.sleep(ms).then(() => { throw new Error("timeout"); })]);
      try {
        for (const a of terminals().filter((x) => x.state === "live")) {
          if (this.created[a.address]) continue;
          try { this.created[a.address] = JSON.parse((await within(hc(["get", a.address, "--json"]), 10000)).stdout).created_ms ?? 0; }
          catch (e) { this.created[a.address] = 0; }
        }
        const win = window()?.platform === "windows";
        const r = await within(win
          ? exec("wsl.exe", ["-d", DISTRO, "python3", scriptPath(), wslPath(home()) + "/.claude"], { timeout: COLLECT_MS })
          : exec("python3", [scriptPath(), home() + "/.claude"], { timeout: COLLECT_MS }), COLLECT_MS + 5000);
        if (run !== this.run) return;
        if (r.code !== 0) throw new Error((r.stderr || "collector failed").split("\n").slice(-2).join(" "));
        this.data = JSON.parse(r.stdout);
        this.error = null;
        this.publishFlow();
      } catch (e) {
        this.error = String(e?.message ?? e);
        // The Flow tab falls back to simulated sends while the feed is down.
        if (shared(FLOW_KEY)?.ok) { this.flowSig = null; setShared(FLOW_KEY, { ok: false, at: Date.now(), error: this.error, events: [] }); }
      }
      if (run === this.run) this.busy = false;
      cx.notify();
    });
  }

  // Publishes the collector's events (contract: id, seq, ts, from, from_name, to, to_session, kind, summary)
  // for agent-flow. The collector knows only the receiver's session; the terminal comes from match(), over
  // every agent of every space and their live sub-agents. Unresolved events are dropped. Written when the
  // events change, and at least every FLOW_HEARTBEAT_MS so the Flow tab can tell a live feed from a stale one.
  publishFlow() {
    const evs = this.data?.events;
    if (!Array.isArray(evs)) return;
    const all = terminals(), list = [];
    const walk = (addr, depth) => {
      for (const x of all.filter((x) => x.parent === addr && x.state === "live")) { list.push({ address: x.address, depth }); walk(x.address, depth + 1); }
    };
    for (const a of agents()) { list.push({ address: a.address, depth: 0 }); walk(a.address, 1); }
    const bySession = {};
    for (const [addr, s] of Object.entries(this.match(list))) bySession[s.session] = addr;
    const events = evs
      .map((e) => ({ ...e, to: e.to ?? bySession[e.to_session] ?? null }))
      .filter((e) => e.from && e.to && e.from !== e.to);
    const sig = events.map((e) => `${e.id}>${e.to}`).join(",");
    if (sig === this.flowSig && Date.now() - (this.flowAt ?? 0) < FLOW_HEARTBEAT_MS) return;
    this.flowSig = sig; this.flowAt = Date.now();
    setShared(FLOW_KEY, { ok: true, at: this.flowAt, orchestrator: null, events });
  }

  // terminal address -> collector session (the rules live in model.js: matchSessions).
  match(list) {
    const cwds = Object.fromEntries(panes().map((p) => [p.terminal, p.cwd]));
    const kinds = Object.fromEntries([...panes(), ...agents()].filter((x) => x.app).map((x) => [x.terminal ?? x.address, kindOfApp(x.app)]));
    const titleOf = (addr) => agents().find((a) => a.address === addr)?.title
      || panes().find((p) => p.terminal === addr)?.title
      || terminals().find((x) => x.address === addr)?.title;
    const folderOf = (addr) => normPath(cwds[addr] ?? terminals().find((x) => x.address === addr)?.cwd);
    return matchSessions(this.data?.sessions ?? [], list, { created: this.created, titleOf, folderOf, kinds });
  }

  // Brutalist summary: big mono numbers, thick borders, solid blocks. Turns red and blinks when someone is needed.
  hero(t, { space, rows, loading, totalTok, totalUsd, totalEst, cachePct, ctxPct, cfg, needs, waiting, accounts }) {
    const MONO = "JetBrains Mono";
    // Agent-kind tag: Claude's brand orange, muted; a cool light silver for Codex (the palette's #adc1cc).
    const KIND_CLAUDE = "#c9744f", KIND_CODEX = "#adc1cc";
    const ACCT = "#7f8f9a"; // account tag: a cool, dim slate between the palette's #7a8076 and #95a7a7
    const hot = needs > 0;
    // Palette grays from the reference still; rust (#95553a) when someone is needed.
    const bg = hot ? "#95553a" : "#7a8076", fg = "#0a1312", edge = hot ? "#b09270" : "#95a7a7";
    // Compact stat cell: value over label, centered, thin rule on the right. `warn` tints the value.
    const cell = (value, label, last, warn) => v_flex().flex_1().min_w(0).px(4).py(4).items_center()
      .when(!last, (el) => el.border_r(2).border_color(fg))
      .child(div().text_size(15).font_family(MONO).font_black().text_color(warn ? "#522d1b" : fg).truncate().child(value))
      .child(div().text_size(9).font_family(MONO).font_bold().text_color(fg).child(label));
    return div().flex_none().p(8).child(v_flex().w_full().border(3).border_color(edge).bg(bg)
      .when(hot || waiting > 0, (el) => el.child(h_flex().px(10).pt(6).items_center().gap(8)
        .child(div().flex_1())
        .when(hot, (el) => el.child(div().px(6).bg(fg).text_size(11).font_family(MONO).font_black().text_color(bg).loop("opacity", { from: 0.25, to: 1, period: 650 }).child(`${needs} NEEDS YOU`)))
        .when(!hot && waiting > 0, (el) => el.child(div().px(6).border(2).border_color(fg).text_size(11).font_family(MONO).font_black().text_color(fg).loop("opacity", { from: 0.4, to: 1, period: 1500 }).child(`${waiting} WAITING`)))))
      .child(h_flex().px(10).pt(6).pb(2).gap(6)
        .children([["total", "SESSION"], ["turn", "LAST TURN"], ["cost", "COST"]].map(([k, label]) => {
          const on = this.view === k;
          return div().id(`view-${k}`).flex_1().h(18).flex().items_center().justify_center().cursor_pointer()
            .text_size(10).font_family(MONO).font_black().border(2).border_color(fg)
            .bg(on ? fg : "#00000000").text_color(on ? bg : fg)
            .tooltip(k === "turn" ? "Tokens and cache since the last prompt" : k === "cost" ? "Estimated API-equivalent cost of the whole session" : "Tokens and cache of the whole session")
            .on_click((_e, cx) => { cx.stop_propagation(); this.view = k; this.autoAt = Date.now(); cx.notify(); })
            .child(label);
        }))
        // Play/pause: cycles SESSION > LAST TURN > COST on a timer.
        .child(div().id("view-auto").flex_none().w(22).h(18).flex().items_center().justify_center().cursor_pointer()
          .border(2).border_color(fg).bg(this.auto ? fg : "#00000000").text_color(this.auto ? bg : fg)
          .tooltip(this.auto ? "Pause: stop cycling the tabs" : `Play: cycle SESSION, LAST TURN and COST every ${AUTO_MS / 1000}s`)
          .on_click((_e, cx) => { cx.stop_propagation(); this.auto = !this.auto; this.autoAt = Date.now(); cx.notify(); })
          .child(svg(this.auto ? "mods/agent-metrics/pause.svg" : "mods/agent-metrics/play.svg").size(10))))
      // Headline row: tokens, with the agent and plugin counts big beside it.
      .child(h_flex().items_stretch()
        .child(v_flex().id("tokens-total").flex_1().min_w(0).px(10).justify_center()
          .tooltip(this.view === "cost" ? costTip(totalEst) : "Tokens (input + output + cache writes) of the selected view")
          .child(div().text_size(42).font_family(MONO).font_black().text_color(fg).truncate().child(loading ? "…" : this.view === "cost" ? moneyOf(totalUsd, totalEst) : fmt(totalTok)))
          .child(div().text_size(9).font_family(MONO).font_bold().text_color(fg).child(this.view === "cost" ? "EST. COST" : "TOKENS")))
        .children([[rows.length, "AGENTS"], [loading ? "…" : cfg.plugins, "PLUGINS"]].map(([n, label]) =>
          v_flex().id(`head-${label}`).flex_none().w(66).items_center().justify_center().py(4)
            .child(div().text_size(30).font_family(MONO).font_black().text_color(fg).child(String(n)))
            .child(div().text_size(9).font_family(MONO).font_bold().text_color(fg).child(label)))))
      .child(h_flex().border_t(2).border_color(fg)
        .child(cell(loading ? "…" : `${cachePct}%`, "CACHE"))
        .child(cell(loading ? "…" : `${Math.round(ctxPct * 100)}%`, "CTX MAX", true, !loading && ctxPct >= HIGH)))
      .child(h_flex().border_t(2).border_color(fg)
        .child(cell(loading ? "…" : String(cfg.mcp), "MCP"))
        .child(cell(loading ? "…" : String(cfg.hooks), "HOOKS", true)))
      .child(h_flex().border_t(2).border_color(fg).px(10).py(5).gap(8).items_start()
        .child(div().flex_none().text_size(10).font_family(MONO).font_bold().text_color(fg).child(accounts.length > 1 ? `${accounts.length} CONTAS` : (accounts[0]?.org ?? "CONTA").toUpperCase()))
        .child(v_flex().flex_1().min_w(0)
          .children((accounts.length ? accounts : [{ name: "?" }]).map((x) =>
            div().truncate().text_size(11).font_family(MONO).font_black().text_color(fg).child(accounts.length > 1 ? `${x.name} ×${x.n}` : x.name)))))
      .child(h_flex().border_t(2).border_color(fg).px(10).py(5).gap(6).items_center()
        .child(div().flex_none().text_size(9).font_family(MONO).font_bold().text_color(fg).child("SCOPE"))
        .children([["space", "SPACE", "Agents of the shown space"], ["project", "PROJECT", "Agents in the focused terminal's folder, in any space"], ["all", "ALL", "Every agent in every space"]].map(([k, label, tip]) => {
          const on = this.scope === k;
          return div().id(`scope-${k}`).flex_1().h(15).flex().items_center().justify_center().cursor_pointer()
            .text_size(9).font_family(MONO).font_black().border(1).border_color(fg)
            .bg(on ? fg : "#00000000").text_color(on ? bg : fg).tooltip(tip)
            .on_click((_e, cx) => { cx.stop_propagation(); this.scope = k; cx.notify(); })
            .child(label);
        })))
    );
  }

  render() {
    const t = theme();
    const space = spaces().find((s) => s.active);
    const all = terminals();
    // Agents shown in this space, then their sub-agents (terminals an agent started), indented under them.
    // Scope: the shown space, every agent whose folder is the focused terminal's folder (any space), or all agents.
    const normDir = (p) => (p ?? "").replaceAll("\\", "/").replace(/^\/\/wsl[.]localhost\/[^/]+/i, "").replace(/\/+$/, "").toLowerCase();
    const paneDir = Object.fromEntries(panes().map((p) => [p.terminal, p.cwd]));
    const projectDir = normDir(focused()?.cwd ?? space?.folder);
    const inScope = (a) => this.scope === "all" ? true
      : this.scope === "project" ? Boolean(projectDir) && normDir(paneDir[a.address] ?? terminals().find((x) => x.address === a.address)?.cwd) === projectDir
      : a.space === space?.id;
    const top = agents().filter(inScope);
    const list = [];
    // One card per terminal: `agents()` also lists sub-agents, which walk() already nests under their parent.
    const placed = new Set();
    const nested = new Set();
    const under = (addr, seen) => {
      for (const x of all.filter((x) => x.parent === addr && x.state === "live" && !seen.has(x.address))) { seen.add(x.address); nested.add(x.address); under(x.address, seen); }
    };
    for (const a of top) under(a.address, new Set([a.address]));
    const walk = (addr, depth) => {
      for (const x of all.filter((x) => x.parent === addr && x.state === "live" && !placed.has(x.address))) {
        placed.add(x.address);
        list.push({ address: x.address, status: x.status, focused: false, depth, name: x.name });
        walk(x.address, depth + 1);
      }
    };
    for (const a of top) {
      if (nested.has(a.address) || placed.has(a.address)) continue;
      placed.add(a.address);
      list.push({ address: a.address, status: a.status, focused: a.focused, depth: 0, name: all.find((x) => x.address === a.address)?.name || a.title || a.address });
      walk(a.address, 1);
    }
    const sess = this.match(list);

    const rows = list.map((a) => {
      const kids = all.filter((x) => x.parent === a.address && x.state === "live" && (x.status === "working" || x.status === "blocked"));
      const state = a.status === "blocked" ? "blocked" : kids.length > 0 ? "waiting" : a.status;
      const s = sess[a.address];
      const u = this.view === "turn" ? turnOf(s) : s;
      const kind = s?.agent ?? kindOfApp(agents().find((x) => x.address === a.address)?.app);
      // Cost only in the COST tab. Codex runs on a ChatGPT plan: no price table applies (its card shows plan use).
      const { usd, estimated: est } = this.view === "cost" && s && !isCodex(s) ? costOf(s.by_model) : { usd: 0, estimated: false };
      return { a, name: a.name, kids, state, s, u, usd, est, kind };
    });

    // Accounts in this space, from each agent's own session; most used first.
    const tally = new Map();
    for (const r of rows) {
      const k = acctKey(r.s?.account);
      const e = tally.get(k) ?? { name: k === "?" ? "?" : k, org: r.s?.account?.org ?? null, n: 0 };
      e.n++; tally.set(k, e);
    }
    const accounts = [...tally.values()].sort((x, y) => y.n - x.n);
    const mainAcct = accounts[0]?.name;
    this.anim = rows.some((r) => animated(r.state));
    const totalUsd = rows.reduce((x, r) => x + r.usd, 0), totalEst = rows.some((r) => r.est);
    const totalTok = rows.reduce((x, r) => x + (r.u ? r.u.in + r.u.out + r.u.cache_write : 0), 0);
    // Space-wide cache hit (same formula as a card) and the fullest context among its agents.
    const cs = rows.filter((r) => r.s);
    const cachePct = Math.round((cs.reduce((x, r) => x + r.u.cache_read, 0) / Math.max(1, cs.reduce((x, r) => x + r.u.in + r.u.cache_read + r.u.cache_write, 0))) * 100);
    const ctxPct = cs.reduce((x, r) => Math.max(x, r.s.ctx / winOf(r.s)), 0);
    // What the space's folders have configured: the union over its agents, so a shared user setting counts once.
    const union = (k) => new Set(cs.flatMap((r) => r.s.config?.[k] ?? [])).size;
    const cfg = { plugins: union("plugins"), mcp: union("mcp"), hooks: union("hooks") };
    const needs = rows.filter((r) => r.state === "blocked").length;
    const waiting = rows.filter((r) => r.state === "waiting").length;

    // Honest numbers: nothing is zero until the collector has answered once; a failed read keeps the last data.
    const loading = !this.data && !this.error;
    const color = { blocked: t.blocked, waiting: t.accent, working: t.working, done: t.done, idle: t.dim };
    // Brutalist rows: square blocks, 2px borders, mono caps, a solid status stamp, a chunky segmented bar.
    const MONO = "JetBrains Mono";
    // Agent-kind tag: Claude's brand orange, muted; a cool light silver for Codex (the palette's #adc1cc).
    const KIND_CLAUDE = "#c9744f", KIND_CODEX = "#adc1cc";
    const ACCT = "#7f8f9a"; // account tag: a cool, dim slate between the palette's #7a8076 and #95a7a7
    const label = (r) => r.state === "blocked" ? "NEEDS YOU"
      : r.state === "waiting" ? `WAITING ${r.kids.length}`
      : r.state.toUpperCase();

    const stamp = (r) => {
      const c = color[r.state] ?? t.dim, solid = r.state === "blocked" || r.state === "waiting" || r.state === "working";
      const el = div().flex_none().px(6).h(18).flex().items_center().text_size(10.5).font_family(MONO).font_black()
        .border(2).border_color(c).bg(solid ? c : "#00000000").text_color(solid ? (t.accent_foreground ?? t.background) : c).child(label(r));
      if (r.state === "blocked") return el.loop("opacity", { from: 0.2, to: 1, period: 650 });
      if (r.state === "waiting") return el.loop("opacity", { from: 0.45, to: 1, period: 1500 });
      return el;
    };

    // Context bar like /context: base (system prompt, tools, rules, skills, MCP = the session's first turn),
    // conversation (the rest), free. Palette: gray, sand, rust when nearly full.
    const SEGS = 24;
    const BASE_C = "#7a8076", CONV_C = "#b09270", HIGH_C = "#95553a", FREE_C = "#1d1e19";
    const bar = (r) => {
      const ctx = r.s?.ctx ?? 0, win = winOf(r.s), base = Math.min(r.s?.base ?? 0, ctx);
      const nBase = base > 0 ? Math.max(1, Math.round((base / win) * SEGS)) : 0;
      const nUsed = Math.min(SEGS, Math.max(nBase, Math.round((ctx / win) * SEGS)));
      const conv = ctx / win >= HIGH ? HIGH_C : CONV_C;
      return h_flex().h(5).w_full().gap(2).children(Array.from({ length: SEGS }, (_, i) =>
        div().flex_1().h_full().bg(i < nBase ? BASE_C : i < nUsed ? conv : FREE_C)));
    };

    // /clear: types /clear into the agent's terminal, starting a fresh context. It throws the conversation
    // away, so the first click arms it (CONFIRM?) and a second click within 3s sends it. Codex has /clear too.
    const ARM_MS = 3000;
    const clearBtn = (r) => {
      const armed = this.armed?.address === r.a.address && Date.now() - this.armed.at < ARM_MS;
      const cmd = "/clear";
      return div().id(`clr-${r.a.address}`).flex_none().px(6).h(18).flex().items_center()
        .text_size(10.5).font_family(MONO).font_black().cursor_pointer()
        .border(2).border_color(armed ? t.blocked : t.border)
        .bg(armed ? t.blocked : "#00000000").text_color(armed ? (t.accent_foreground ?? t.background) : t.muted)
        .hover((s) => s.border_color(armed ? t.blocked : t.foreground).text_color(armed ? (t.accent_foreground ?? t.background) : t.foreground))
        .tooltip(armed ? "Click again to clear this agent's context" : `Run ${cmd} in this agent`)
        .on_click((_e, cx) => {
          cx.stop_propagation();
          if (armed) {
            this.armed = null;
            hc(["send", r.a.address, cmd]).catch((e) => { this.error = String(e?.message ?? e); });
          } else {
            this.armed = { address: r.a.address, at: Date.now() };
          }
          cx.notify();
        })
        .child(armed ? "CONFIRM?" : cmd.toUpperCase());
    };

    // /compact: summarizes the conversation in place, so nothing is lost and one click is enough.
    const compactBtn = (r) => div().id(`cmp-${r.a.address}`).flex_none().px(6).h(18).flex().items_center()
      .text_size(10.5).font_family(MONO).font_black().cursor_pointer()
      .border(2).border_color(t.border).text_color(t.muted)
      .hover((s) => s.border_color(t.foreground).text_color(t.foreground))
      .tooltip("Run /compact in this agent")
      .on_click((_e, cx) => {
        cx.stop_propagation();
        hc(["send", r.a.address, "/compact"]).catch((e) => { this.error = String(e?.message ?? e); cx.notify(); });
      })
      .child("/COMPACT");

    const row = (r) => {
      const c = color[r.state] ?? t.dim, hot = r.state === "blocked", s = r.s, ctx = s?.ctx ?? 0;
      const ink = hot ? c : t.foreground, win = winOf(s), pct = s ? ctx / win : 0;
      // Codex: the share of the plan's rate limit used (its primary window).
      const plan = isCodex(s) ? s.plan : null;
      const planPct = plan?.used != null ? Math.round(plan.used) : null;
      const left = turnsLeft(s);
      const cache = s ? Math.round((r.u.cache_read / Math.max(1, r.u.in + r.u.cache_read + r.u.cache_write)) * 100) : 0;
      const active = r.state === "working" || r.state === "blocked" || r.state === "waiting";
      // Processing: working itself, or a parent whose sub-agents are working (shown as WAITING).
      const working = r.state === "working" || r.state === "waiting" || r.a.status === "working";
      return h_flex().id(`m-${r.a.address}`).w_full().ml(r.a.depth * 12).relative()
        .border(2).border_color(working ? "#00000000" : hot ? c : t.border).bg(hot ? c + "26" : t.surface)
        .child(v_flex().flex_none().self_stretch().w(r.a.depth > 0 ? 46 : 60).pl(2).items_center().pb(4).bg(t.chrome).border_r(2).border_color(hot ? c : t.border)
          .child(div().flex_1().flex().items_center().justify_center()
            .child(avatar(r.a.address, r.a.depth > 0 ? 4 : 5, r.state, this.tick)))
          // which agent this is: CLAUDE or CODEX, small and dim, just above the terminal code;
          // nothing when neither the session nor the terminal says
          .when(Boolean(r.kind), (el) => el.child(div().id(`kind-${r.a.address}`).flex_none()
            .text_size(r.a.depth > 0 ? 7.5 : 8).font_family(MONO).font_bold().text_color(r.kind === "codex" ? KIND_CODEX : KIND_CLAUDE)
            .tooltip(r.kind === "codex" ? `Codex${s?.model ? " · " + s.model : ""}` : `Claude Code${s?.model ? " · " + s.model : ""}`)
            .child(r.kind.toUpperCase())))
          // terminal code (hc address), pinned to the bottom of the avatar column
          // click: open (focus) this agent's terminal; sub-agents without a pane get one
          .child(div().id(`term-${r.a.address}`).flex_none().px(3).cursor_pointer()
            .text_size(r.a.depth > 0 ? 9 : 10).font_family(MONO).font_bold().text_color(hot ? c : t.muted)
            .hover((s) => s.text_color(t.accent).underline())
            .tooltip(`Open terminal ${r.a.address}`)
            .on_click((_e, cx) => {
              cx.stop_propagation();
              try { run("agent.focus", { terminal: r.a.address }); }
              catch (e) { this.error = String(e?.message ?? e); cx.notify(); }
            })
            .child(r.a.address)))
        .child(v_flex().flex_1().min_w(0).p(8).gap(6)
          .child(h_flex().gap(8).items_center()
            .child(div().flex_1().min_w(0).truncate().text_size(r.a.depth > 0 ? 11 : 12).font_family(MONO).font_black().text_color(r.a.focused ? t.accent : ink).child(r.name.toUpperCase()))
            .child(stamp(r)))
          .child(s ? bar(r) : div().h(5).border(2).border_color(t.border))
          .child(h_flex().gap(8).items_baseline().text_size(11).font_family(MONO).text_color(t.muted)
            .when(!s, (el) => el.child(div().font_bold().text_color(ink).when(loading, (e) => e.loop("opacity", { from: 0.35, to: 1, period: 1200 })).child(loading ? "READING…" : "NO DATA")))
            .when(Boolean(s), (el) => {
              // Narrow panels: context and the right-hand figure always show; the secondary items give way first,
              // elapsed time, then turns left, then cache (estimated mono widths against the room).
              const ctxTxt = `${fmt(ctx)}/${fmt(win)}`, rightTxt = isCodex(s) ? (planPct === null ? "—" : `${planPct}%`) : this.view === "cost" ? moneyOf(r.usd, r.est) : fmt(r.u.in + r.u.out + r.u.cache_write);
              const extras = [
                { txt: `⚡${cache}%`, el: div().flex_none().child(`⚡${cache}%`) },
                left !== null && { txt: `~${left > 99 ? "99+" : left}T`, el: div().flex_none().text_color(left <= 10 ? "#b09270" : t.muted).font_bold().child(`~${left > 99 ? "99+" : left}T`) },
                s.mtime && { txt: age(Date.now() - s.mtime), el: div().flex_none().child(age(Date.now() - s.mtime)) },
              ].filter(Boolean);
              const room = this.width / (settings()?.zoom || 1) - 16 - r.a.depth * 12 - 4 - (r.a.depth > 0 ? 46 : 60) - 16;
              const wOf = (txt, size) => String(txt).length * size * 0.62;
              let used = wOf(ctxTxt, 11) + wOf(rightTxt, 15) + 8;
              const keep = extras.filter((x) => { used += 8 + wOf(x.txt, 11); return used <= room; });
              return el
              .child(div().flex_none().font_bold().text_color(pct >= HIGH ? t.blocked : ink).child(ctxTxt))
              .child(h_flex().flex_1().min_w(0).gap(8).items_baseline().overflow_hidden().children(keep.map((x) => x.el)))
              .when(!isCodex(s), (e) => e.child(div().flex_none().id(`tok-${r.a.address}`).text_size(15).font_black().text_color(t.foreground)
                .tooltip(this.view === "cost" ? costTip(r.est) : "Tokens (input + output + cache writes) of the selected view").child(rightTxt)))
              .when(isCodex(s), (e) => e.child(div().flex_none().id(`plan-${r.a.address}`).text_size(15).font_black().text_color(planPct >= 80 ? t.blocked : t.foreground)
                .tooltip(`${plan?.type ? plan.type.toUpperCase() + " plan" : "Plan"}: ${planPct ?? "?"}% of the ${plan?.window_min ? Math.round(plan.window_min / 1440) + "-day" : ""} limit used`)
                .child(planPct === null ? "—" : `${planPct}%`)));
            }))
          .when(Boolean(s?.tool) && active, (el) => el.child(div().truncate().text_size(10.5).font_family(MONO).text_color(hot ? c : t.dim).child(`▸ ${s.tool}`)))
          // Bottom row: the account (only when it is not the main one), small and dim on the left, cut
          // with an ellipsis before it can push the buttons; the buttons stay right-aligned.
          .child(h_flex().items_center().gap(6)
            .child(div().flex_1().min_w(0)
              .when(accounts.length > 1 && acctKey(s?.account) !== mainAcct, (el) => el.child(
                div().id(`acct-${r.a.address}`).truncate().text_size(9.5).font_family(MONO).font_bold().text_color(ACCT)
                  .tooltip(`Account: ${acctName(s?.account) ?? "?"}`)
                  .child(`@${(acctName(s?.account) ?? "?").split("@").pop().split(".")[0].toUpperCase()}`))))
            .child(compactBtn(r)).child(clearBtn(r))))
        // Last child: drawn over the avatar column and the content, so all four edges show.
        .when(working, (el) => el.child(rainbowEdge(this.tick)));
    };

    return v_flex().id("metrics-root").size_full().bg(t.chrome).overflow_hidden()
      .on_size_change((size, cx) => { if (Math.abs(size.width - this.width) > 1) { this.width = size.width; cx.notify(); } })
      .child(this.hero(t, { space, rows, loading, totalTok, totalUsd, totalEst, cachePct, ctxPct, cfg, needs, waiting, accounts }))
      .child(v_flex().id("metrics-list").flex_1().min_h(0).px(8).pb(8).gap(8).overflow_y_scrollbar()
        // A failed read: say so beside the data that is still shown, and retry on the next refresh (or now).
        .when(Boolean(this.error), (el) => el.child(h_flex().flex_none().id("metrics-error").items_center().gap(8).px(8).py(5)
          .border(2).border_color(t.blocked).bg(t.blocked + "26")
          .child(div().flex_1().min_w(0).truncate().text_size(10.5).font_family(MONO).font_bold().text_color(t.blocked)
            .tooltip(this.error).child(`${this.data ? "STALE · " : ""}READ FAILED: ${this.error}`))
          .child(div().id("metrics-retry").flex_none().px(6).h(18).flex().items_center().cursor_pointer()
            .text_size(10.5).font_family(MONO).font_black().border(2).border_color(t.blocked).text_color(t.blocked)
            .on_click((_e, cx) => { cx.stop_propagation(); this.busy = false; this.refresh(cx); cx.notify(); })
            .child("RETRY"))))
        // First read pending: the shape of the cards, pulsing, instead of an empty list.
        .when(loading && rows.length === 0, (el) => el.children([0, 1, 2].map((i) =>
          div().id(`skel-${i}`).flex_none().h(86).border(2).border_color(t.border).bg(t.surface).loop("opacity", { from: 0.3, to: 0.8, period: 1200 }))))
        .when(!loading && rows.length === 0, (el) => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.scope === "project" ? "No agents in this folder" : this.scope === "all" ? "No agents" : "No agents in this space")))
        .children(rows.map(row)));
  }
}
