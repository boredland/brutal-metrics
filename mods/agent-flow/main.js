// Flow tab: who messages whom in the selected space, as a vertical flowchart. The orchestrator (Chief of
// Staff) sits on top with a line to every agent; agents that message each other get a lane on the right.
// Every send fires a pulse that runs the line from sender to receiver. Only real sends are drawn: while the
// feed is missing, failed or stale the tab says so (no simulated sends).
// Animation is native (.transition, .loop). The timers here only poll data and mount or unmount pulses.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, HoverCard } from "gpui-base";
import { spaces, agents, terminals, panes, focused, theme, run, settings, shared, setShared, openOverlay } from "herdr";
import { SCOPE_KEY, SCOPES, normDir, inScope } from "./scope.js";
import { agentAvatar, activeEdge, needsTick } from "./active.js";
import { plan, lengthOf } from "./flow.js";
import * as source from "./source.js";

const MONO = "JetBrains Mono";
// Palette swatches (RECIPE): idle line, fired line (sand), pulse (sky); the orchestrator block as the Metrics summary.
const LINE = "#3d3f34", FIRE = "#b09270", PULSE = "#adc1cc", INK = "#0a1312", HERO = "#7a8076", HERO_EDGE = "#95a7a7";
const POLL_MS = 1000;     // new events (data, not animation)
const HOT_MS = 8000;      // a fired route stays sand at least this long after the pulse fires, then fades
const FADE_MS = 1500;     // sand back to the idle line
const SPEED = 0.1;        // pulse speed, px per ms
const SEG_MIN = 1000, SEG_MAX = 2600; // ms per straight run of a route
const MOUNT_MS = 150;     // the pulse is painted at the sender before it gets its target (else no transition)
// Pulse: a glow, the head, and a fading trail behind it ([lag ms, size px, opacity]).
const TRAIL = [[0, 12, 0.3], [0, 6, 1], [140, 5, 0.75], [280, 4, 0.5], [420, 3, 0.3]];

// A node's short name, in caps: its tab's name (top-level agents; Herdr's default `tb...` ids don't count),
// else the terminal's hc name, else its role label, else the terminal code. Cut with "…" only past NAME_MAX.
const NAME_MAX = 18;
function shortName(tab, name, role, address) {
  const usable = (s) => (typeof s === "string" && s.trim() && !/^tb[0-9a-f]+$/i.test(s.trim()) ? s.trim() : null);
  const s = (usable(tab) ?? usable(name) ?? usable(role) ?? address).replace(/\s+/g, " ").toUpperCase();
  return s.length > NAME_MAX ? s.slice(0, NAME_MAX - 1).trimEnd() + "…" : s;
}
const ROLE_TITLE = "CHIEF OF STAFF";
// The agent's detail dialog is drawn by agent-metrics (role "detail"): the same one the Metrics cards open.
const openDetail = (address) => openOverlay({ mod: "agent-metrics", kind: "dialog", props: { role: "detail", address }, width: 560, height: 600 });

export default class AgentFlow extends View {
  init(_props, cx) {
    this.size = { width: 368, height: 600 };
    this.seen = null;       // event ids already drawn; null until the first poll so history doesn't replay
    this.pulses = [];       // sends on screen: { key, from, to, pts, chunks, transit, fade, stage, arrived }
    this.geom = null;       // last plan(), for routing new pulses
    this.tick = 0; this.anim = false;
    cx.timer.every(POLL_MS, (cx) => this.poll(cx));
    if (needsTick) cx.timer.every(200, (cx) => { if (this.anim) { this.tick++; cx.notify(); } });
  }

  // Agents of the selected space and their live sub-agent terminals, with a Metrics-style state.
  graph() {
    const space = spaces().find((s) => s.active);
    const all = terminals();
    const term = (addr) => all.find((x) => x.address === addr);
    const tabNames = new Map();
    for (const s of spaces()) for (const tb of s.tabs ?? []) tabNames.set(tb.id, tb.name);
    const list = [];
    // One node per terminal, ever: `agents()` also lists sub-agents, which walk() places under their parent.
    const placed = new Set();
    const add = (x, a, depth) => {
      if (placed.has(x?.address ?? a.address)) return;
      placed.add(x?.address ?? a.address);
      const labels = x?.labels ?? {};
      // Only a top-level agent owns its tab; a sub-agent in the same tab would take its parent's name.
      const tab = depth === 0 ? tabNames.get(labels["herdr.tab"]) : null;
      list.push({
        address: x?.address ?? a.address, status: a?.status ?? x?.status, focused: Boolean(a?.focused), depth,
        name: shortName(tab, x?.name, source.roleOf(labels), x?.address ?? a.address),
        title: (a?.title || x?.title || "").trim(), labels,
      });
    };
    const walk = (addr, depth) => {
      for (const x of all.filter((x) => x.parent === addr && x.state === "live")) { add(x, null, depth); walk(x.address, depth + 1); }
    };
    // The same scope switch as the Metrics tab (shared state): the shown space, the focused folder, or everything.
    const scope = shared(SCOPE_KEY) ?? "space";
    const paneDir = Object.fromEntries(panes().map((p) => [p.terminal, p.cwd]));
    const projectDir = normDir(focused()?.cwd ?? space?.folder);
    const here0 = agents().filter((a) => inScope(scope, { spaceId: space?.id, projectDir, agentSpace: a.space, agentDir: normDir(paneDir[a.address] ?? term(a.address)?.cwd) }));
    // Addresses that sit under some agent of this space (any depth): they are drawn nested, not as top-level nodes.
    const nested = new Set();
    const under = (addr, seen) => {
      for (const x of all.filter((x) => x.parent === addr && x.state === "live" && !seen.has(x.address))) { seen.add(x.address); nested.add(x.address); under(x.address, seen); }
    };
    for (const a of here0) under(a.address, new Set([a.address]));
    for (const a of here0) { if (nested.has(a.address)) continue; add(term(a.address), a, 0); walk(a.address, 1); }
    for (const n of list) {
      const busyKids = all.filter((x) => x.parent === n.address && x.state === "live" && (x.status === "working" || x.status === "blocked")).length;
      n.kids = busyKids;
      n.state = n.status === "blocked" ? "blocked" : busyKids > 0 ? "waiting" : n.status;
      n.active = n.state === "working" || n.state === "waiting" || n.status === "working";
    }
    // The feed covers every space; keep the sends between the nodes in scope.
    const here = new Set(list.map((n) => n.address));
    const evs = source.withKinds(source.events()).filter((e) => here.has(e.from) && here.has(e.to));
    return { space, scope, nodes: list, evs, orchestrator: source.orchestratorOf(list, evs) };
  }

  poll(cx) {
    // On the first poll, and whenever the feed goes live or stops being live, take the window as already seen:
    // history must not fire a burst of pulses. Nothing fires while the feed is not live.
    const real = source.live();
    if (!this.seen || real !== this.real) { this.seen = new Set(source.events().map((e) => e.id)); this.real = real; cx.notify(); }
    const fresh = real ? source.events().filter((e) => !this.seen.has(e.id)) : [];
    // Pulses start one after another, so a burst stays readable.
    fresh.forEach((e, i) => { this.seen.add(e.id); this.fire(e, cx, i * 1200); });
  }

  // One send. Its route turns sand at once, the pulse runs it from sender to receiver, the route stays sand
  // until HOT_MS and then fades back. All motion is .transition: the elements mount at their start values
  // (stage 0), and after MOUNT_MS get their end values (stage 1) with per-property durations and delays.
  // The task only mounts, flips the stage, and removes; it never steps the animation.
  fire(ev, cx, delay) {
    const pts = this.geom?.route(ev.from, ev.to);
    if (!pts) return;
    // Segments, then chunks of at most two (one vertical, one horizontal): one element per chunk can run
    // both with `top` and `left` on separate delays, so no dot is left behind at a corner.
    const segs = [];
    let at = 0;
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1], b = pts[k], dur = Math.min(SEG_MAX, Math.max(SEG_MIN, lengthOf(a, b) / SPEED));
      segs.push({ axis: a.x === b.x ? "top" : "left", dur, delay: at }); at += dur;
    }
    const chunks = [];
    for (let k = 0; k < segs.length; k += 2) {
      const part = segs.slice(k, k + 2);
      chunks.push({ start: pts[k], end: pts[k + part.length], segs: part, from: part[0].delay, to: part[part.length - 1].delay + part[part.length - 1].dur });
    }
    const transit = at + TRAIL[TRAIL.length - 1][0];
    const fade = Math.max(transit + 1500, HOT_MS - FADE_MS);
    const p = { key: ev.id.replace(/[^A-Za-z0-9]/g, "_"), from: ev.from, to: ev.to, pts, chunks, transit, fade, stage: 0, arrived: false };
    cx.spawn(async (cx) => {
      if (delay) await cx.sleep(delay);
      this.pulses.push(p); cx.notify();
      await cx.sleep(MOUNT_MS);
      p.stage = 1; cx.notify();
      await cx.sleep(transit);
      p.arrived = true; cx.notify();
      await cx.sleep(fade + FADE_MS - transit + 100);
      this.pulses = this.pulses.filter((x) => x !== p); cx.notify();
    });
  }

  render() {
    const t = theme();
    const { nodes, evs, orchestrator, scope } = this.graph();
    // on_size_change reports window px; Herdr's zoom scales every px we draw, so divide it out.
    const zoom = settings()?.zoom || 1;
    const W = Math.floor(this.size.width / zoom), H = Math.floor(this.size.height / zoom);
    const root = v_flex().id("flow-root").size_full().bg(t.chrome).overflow_hidden()
      .on_size_change((size, cx) => {
        if (Math.abs(size.width - this.size.width) > 1 || Math.abs(size.height - this.size.height) > 1) {
          this.size = { width: size.width, height: size.height }; cx.notify();
        }
      });
    this.anim = nodes.some((n) => n.active);
    // Scope switch (shared with Metrics).
    const scopeRow = h_flex().id("flow-scope").flex_none().items_center().gap(6).mx(8).mt(8)
      .child(div().flex_none().text_size(9).font_family(MONO).font_bold().text_color(t.muted).child("SCOPE"))
      .children(SCOPES.map(([k, label, tip]) => {
        const on = scope === k;
        return div().id(`fscope-${k}`).flex_1().h(18).flex().items_center().justify_center().cursor_pointer()
          .text_size(9.5).font_family(MONO).font_black().border(1).border_color(on ? t.foreground : t.border)
          .bg(on ? t.foreground : "#00000000").text_color(on ? t.background : t.muted).tooltip(tip)
          .on_click((_e, cx) => { cx.stop_propagation(); setShared(SCOPE_KEY, k); cx.notify(); })
          .child(label);
      }));
    // The feed's state, said plainly: reading (pulsing), down or stale (red, with RETRY).
    const st = source.status();
    const bad = st.state === "down" || st.state === "stale";
    const secs = st.at ? Math.max(0, Math.round((Date.now() - st.at) / 1000)) : null;
    const banner = st.state === "live" ? null : h_flex().id("flow-feed").flex_none().items_center().gap(8).mx(8).mt(8).px(8).py(5)
      .border(2).border_color(bad ? t.blocked : t.border).bg(bad ? t.blocked + "26" : t.surface)
      .child(div().flex_1().min_w(0).truncate().text_size(10.5).font_family(MONO).font_bold().text_color(bad ? t.blocked : t.dim)
        .when(!bad, (el) => el.loop("opacity", { from: 0.35, to: 1, period: 1200 }))
        .tooltip(st.error ?? "")
        .child(st.state === "reading" ? "READING…" : st.state === "down" ? `FEED DOWN: ${st.error}` : `STALE · LAST DATA ${secs}s AGO`))
      .when(bad, (el) => el.child(div().id("flow-retry").flex_none().px(6).h(18).flex().items_center().cursor_pointer()
        .text_size(10.5).font_family(MONO).font_black().border(2).border_color(t.blocked).text_color(t.blocked)
        .on_click((_e, cx) => { cx.stop_propagation(); source.retry(); cx.notify(); })
        .child("RETRY")));
    if (nodes.length < 2 || !orchestrator) {
      this.geom = null;
      const where = scope === "all" ? "" : scope === "project" ? " IN THIS FOLDER" : " IN THIS SPACE";
      return root.child(scopeRow).when(Boolean(banner), (el) => el.child(banner)).child(div().p(16).text_size(12).font_family(MONO).font_bold().text_color(t.dim)
        .child(nodes.length ? `FLOW NEEDS 2+ AGENTS${where}` : `NO AGENTS${where}`));
    }
    const cos = nodes.find((n) => n.address === orchestrator);
    const others = nodes.filter((n) => n !== cos);
    const g = plan({ width: W, height: H, orchestrator, others: others.map((n) => n.address), events: evs });
    this.geom = g;

    // Per node: sends out, sends in, and the latest one it took part in.
    const stats = new Map(nodes.map((n) => [n.address, { out: 0, in: 0, last: null, msgs: [] }]));
    for (const e of evs) {
      const f = stats.get(e.from), r = stats.get(e.to);
      const text = (e.summary ?? "").replace(/\s+/g, " ");
      if (f) { f.out++; f.last = `→${e.to} ${text}`; f.msgs.push({ dir: "→", other: e.to, text, ts: e.ts }); }
      if (r) { r.in++; r.last = `${e.kind === "reply" ? "↩" : "←"}${e.from} ${text}`; r.msgs.push({ dir: e.kind === "reply" ? "↩" : "←", other: e.from, text, ts: e.ts }); }
    }

    const seg = (a, b, color, th = 2) => {
      const o = Math.floor(th / 2);
      return a.y === b.y
        ? div().absolute().left(Math.min(a.x, b.x) - o).top(a.y - o).w(Math.abs(b.x - a.x) + th).h(th).bg(color)
        : div().absolute().left(a.x - o).top(Math.min(a.y, b.y) - o).w(th).h(Math.abs(b.y - a.y) + th).bg(color);
    };
    const poly = (pts, color, th) => pts.slice(1).map((b, k) => seg(pts[k], b, color, th));
    // Pixel-art arrowhead (2px columns or rows of 10, 6, 2) at the receiver's end.
    const arrow = (pts, color) => {
      const a = pts[pts.length - 2], b = pts[pts.length - 1];
      const bar = (w, h) => div().flex_none().w(w).h(h).bg(color);
      if (a.y === b.y) {
        const right = b.x > a.x, cells = [bar(2, 10), bar(2, 6), bar(2, 2)];
        return h_flex().absolute().left(right ? b.x - 6 : b.x).top(b.y - 5).w(6).h(10).items_center().children(right ? cells : cells.reverse());
      }
      const down = b.y > a.y, cells = [bar(10, 2), bar(6, 2), bar(2, 2)];
      return v_flex().absolute().left(b.x - 5).top(down ? b.y - 6 : b.y).w(10).h(6).items_center().children(down ? cells : cells.reverse());
    };

    const color = { blocked: t.blocked, waiting: t.accent, working: t.working, done: t.done, idle: t.dim };
    const stamp = (n, onHero) => {
      const c = onHero ? INK : color[n.state] ?? t.dim, solid = n.active || n.state === "blocked";
      const label = n.state === "blocked" ? "NEEDS YOU" : n.state === "waiting" ? `WAITING ${n.kids}` : String(n.state ?? "idle").toUpperCase();
      const el = div().flex_none().px(5).h(16).flex().items_center().text_size(9.5).font_family(MONO).font_black()
        .border(2).border_color(c).bg(solid ? c : "#00000000").text_color(solid ? (onHero ? HERO : t.accent_foreground ?? t.background) : c).child(label);
      if (n.state === "blocked") return el.loop("opacity", { from: 0.2, to: 1, period: 650 });
      if (n.state === "waiting") return el.loop("opacity", { from: 0.45, to: 1, period: 1500 });
      return el;
    };
    // Terminal code: click opens that agent's terminal, as on the Metrics cards.
    const code = (n, ink) => div().id(`fc-${n.address}`).flex_none().cursor_pointer().font_bold().text_color(ink)
      .hover((s) => s.text_color(t.accent).underline()).tooltip(`Open terminal ${n.address}`)
      .on_click((_e, cx) => { cx.stop_propagation(); try { run("agent.focus", { terminal: n.address }); } catch (e) { /* gone */ } })
      .child(n.address);

    // A send on its way to `n`: the sender's code on sand, blinking until the pulse arrives.
    const incoming = (n) => this.pulses.filter((p) => p.to === n.address && !p.arrived).slice(0, 1).map((p) =>
      div().flex_none().self_center().px(4).h(14).flex().items_center().bg(FIRE).text_size(9.5).font_family(MONO).font_black().text_color(INK)
        .loop("opacity", { from: 0.35, to: 1, period: 500 }).child(`◀ ${p.from}`));

    // ↑out ↓in, and on hover the last messages this node took part in (newest first).
    const ago = (ts) => { const sec = Math.max(0, Math.round((Date.now() - (ts ?? Date.now())) / 1000)); return sec < 60 ? `${sec}s` : sec < 3600 ? `${Math.floor(sec / 60)}m` : `${Math.floor(sec / 3600)}h`; };
    const counts = (n, s) => {
      const txt = div().id(`fcnt-${n.address}`).flex_none().child(`↑${s.out} ↓${s.in}`);
      if (!s.msgs.length) return txt;
      const card = v_flex().min_w(200).max_w(320).p(8).gap(5).bg(t.popover).border(1).border_color(t.border).rounded(6)
        .child(div().text_size(9).font_family(MONO).font_bold().text_color(t.dim).child(`LAST MESSAGES · ${n.name}`))
        .children(s.msgs.slice(-6).reverse().map((m) => v_flex().gap(1)
          .child(h_flex().gap(8).items_baseline().font_family(MONO).text_size(10.5)
            .child(div().flex_none().font_bold().text_color(t.foreground).child(`${m.dir} ${m.other}`))
            .child(div().flex_none().text_color(t.dim).child(ago(m.ts))))
          .child(div().text_size(10.5).font_family(MONO).text_color(t.muted).child(m.text))));
      return HoverCard.new(`fhov-${n.address}`).open_delay(250).trigger(txt).content(card);
    };

    const node = (n, box, hero) => {
      const s = stats.get(n.address), hot = n.state === "blocked";
      const edge = hero ? HERO_EDGE : hot ? t.blocked : t.border;
      const ink = hero ? INK : hot ? t.blocked : t.foreground, sub = hero ? INK : t.muted;
      const px = hero ? 5 : g.compact ? 3 : 4, colW = hero ? 56 : g.compact ? 34 : 46;
      return div().id(`fn-${n.address}`).absolute().left(box.x).top(box.y).w(box.w).h(box.h)
        .child(h_flex().size_full().overflow_hidden()
          .border(hero ? 3 : 2).border_color(n.active ? "#00000000" : edge).bg(hero ? HERO : hot ? t.blocked + "26" : t.surface)
          .child(v_flex().flex_none().h_full().w(colW).items_center().justify_center().bg(t.chrome).border_r(2).border_color(hero ? INK : edge)
            .child(agentAvatar(n.address, px, n.state, this.tick)))
          .child(v_flex().flex_1().min_w(0).h_full().px(8).py(hero ? g.cosPadY : g.padY).gap(hero || !g.compact ? 2 : 3).justify_center()
            .child(h_flex().flex_none().gap(6).items_center()
              .child(div().id(`fnm-${n.address}`).flex_1().min_w(0).truncate().cursor_pointer().text_size(hero ? 11 : g.compact ? 11 : 12).font_family(MONO).font_black()
                .text_color(!hero && n.focused ? t.accent : ink).hover((s) => s.text_color(t.accent).underline())
                .tooltip(`${n.title || n.address} · click for details`)
                .on_click((_e, cx) => { cx.stop_propagation(); try { openDetail(n.address); } catch (e) { /* gone */ } })
                .child(hero ? ROLE_TITLE : n.name))
              .child(stamp(n, hero)))
            // The full session title, small, when it says more than the short name (not in compact nodes).
            .when(Boolean(n.title) && n.title.toUpperCase() !== n.name && (hero || !g.compact), (el) => el.child(
              div().flex_none().min_w(0).truncate().text_size(9).font_family(MONO).text_color(hero ? INK : t.dim).child(n.title)))
            .when(hero, (el) => el.child(h_flex().flex_none().gap(8).items_baseline().font_family(MONO).text_color(INK)
              .child(div().text_size(20).font_black().child(`${evs.length} MSGS`))
              .child(div().text_size(10.5).child(code(n, INK)))
              .children(incoming(n))
              .when(g.wide && Boolean(s.last), (e) => e.child(div().flex_1().min_w(0).truncate().text_size(10.5).child(`▸ ${s.last}`)))))
            .when(!hero, (el) => el.child(h_flex().flex_none().gap(8).items_baseline().text_size(10.5).font_family(MONO).text_color(sub)
              .child(code(n, hot ? t.blocked : sub))
              .child(counts(n, s))
              .children(incoming(n))
              .when(g.wide && Boolean(s.last), (e) => e.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`▸ ${s.last}`))))))
          )
        // Over the whole box (not inside its border, which would clip the right and bottom edges).
        .when(n.active, (el) => el.child(activeEdge(box.w, box.h, this.tick)));
    };

    // A fired route: 3px sand over the idle line, with the arrowhead, from the moment of the send; it stays
    // until `fade` and then fades back to the idle line in FADE_MS (opacity transition, native).
    // The pulse lives inside it, so it fades out with the route.
    const fired = (p) => div().id(`ff-${p.key}`).absolute().inset_0()
      .children(poly(p.pts, FIRE, 3)).child(arrow(p.pts, FIRE)).children(pulse(p))
      .opacity(p.stage ? 0 : 1).transition("opacity", { duration: FADE_MS, delay: p.fade });

    // The pulse: per chunk, a glow, the head and a trail, each running the chunk's vertical and horizontal
    // runs with `top` and `left` transitions on their own delays. The first chunk hides when the next one
    // takes over at the corner; the last one stays on the arrow until the route fades.
    const pulse = (p) => p.chunks.flatMap((c, ci) => TRAIL.map(([lag, size, alpha], ti) => {
      const pos = p.stage ? c.end : c.start, first = ci === 0, last = ci === p.chunks.length - 1;
      let el = div().id(`fp-${p.key}-${ci}-${ti}`).absolute().left(pos.x - size / 2).top(pos.y - size / 2).size(size).bg(PULSE);
      for (const s of c.segs) el = el.transition(s.axis, { duration: s.dur, delay: s.delay + lag, easing: "linear" });
      const shown = p.stage ? (last ? alpha : 0) : (first ? alpha : 0);
      const when = p.stage ? (last ? (first ? 0 : c.from + lag) : c.to + lag) : 0;
      return el.opacity(shown).transition("opacity", { duration: 80, delay: when });
    }));

    return root.child(scopeRow).when(Boolean(banner), (el) => el.child(banner)).child(div().id("flow-scroll").flex_1().min_h(0).overflow_y_scrollbar()
      .child(div().relative().w(W).h(g.height)
        .children(g.lines.flatMap((pts) => poly(pts, LINE)))
        .children(this.pulses.map(fired))
        .child(node(cos, g.cos, true))
        .children(others.map((n, i) => node(n, g.boxes[i], false)))));
  }
}
