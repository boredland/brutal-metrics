// Pure rules of the Flow feed (no Herdr imports, so `node --test` can load it): what state the feed is in,
// which sends count as a reply, who the orchestrator is. source.js binds these to Herdr's shared state.

export const STALE_MS = 40000;

// The feed's state, from the value published in shared state (or undefined) and the clock:
//   "reading": nothing published yet     "down": the collector failed (`error` says why)
//   "stale": no write for STALE_MS       "live": fresh
export function feedState(s, now) {
  if (!s) return { state: "reading", error: null, at: null };
  if (!s.ok) return { state: "down", error: s.error ?? "collector failed", at: s.at ?? null };
  if (now - (s.at ?? 0) >= STALE_MS) return { state: "stale", error: null, at: s.at ?? null };
  return { state: "live", error: null, at: s.at ?? null };
}

// `reply` = a send A to B after an earlier B to A in the window (the collector only emits `send`).
export function withKinds(evs) {
  const seen = new Set();
  return evs.map((e) => {
    const kind = e.kind === "send" && seen.has(`${e.to}>${e.from}`) ? "reply" : e.kind;
    seen.add(`${e.from}>${e.to}`);
    return kind === e.kind ? e : { ...e, kind };
  });
}

export const roleOf = (labels) => (Array.isArray(labels) ? labels.find((l) => /^role=/.test(l))?.slice(5) : labels?.role);

// The orchestrator: the published value, else the terminal labelled role=orchestrator
// (`hc label t24 role=orchestrator`), else the first node.
export function pickOrchestrator(nodes, published) {
  const addrs = new Set(nodes.map((n) => n.address));
  if (published && addrs.has(published)) return published;
  const labeled = nodes.find((n) => roleOf(n.labels) === "orchestrator");
  return labeled?.address ?? nodes[0]?.address ?? null;
}

// The sends worth drawing: the receiver is known, and both ends are among `here`.
export const eventsAmong = (evs, here) => evs.filter((e) => e && e.from && e.to && here.has(e.from) && here.has(e.to));
