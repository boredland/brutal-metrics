// Where the Flow tab's message events come from: agent-metrics publishes the collector's window, `to` resolved
// by its match(), in shared state KEY as { ok, at, orchestrator, events, error? }. This mod never runs collect.py.
// There is no simulated fallback: while the feed is missing, failed or stale the tab says so, and draws no sends.
// Every event has the collector's contract shape (collect.py `events[]`: id, seq, ts, from, from_name, to,
// to_session, kind, summary), with `to` already resolved to an hc address.
import { shared, setShared } from "herdr";
import { feedState, withKinds, roleOf, pickOrchestrator } from "./feed.js";

export const KEY = "flow.events";
// Asks agent-metrics to read again now (its RETRY button, and the Flow tab's).
export const RETRY_KEY = "metrics.retry";

export { withKinds, roleOf };

// { state: "reading" | "down" | "stale" | "live", error, at }
export const status = () => feedState(shared(KEY), Date.now());
// True when the events are fresh.
export const live = () => status().state === "live";

// The last published window, oldest first, only sends whose receiver is known. A stale window is still shown
// (nothing new is drawn from it); a missing or failed one is empty.
export function events() {
  const s = shared(KEY);
  return s && Array.isArray(s.events) ? s.events.filter((e) => e && e.from && e.to) : [];
}

export const orchestratorOf = (nodes) => pickOrchestrator(nodes, shared(KEY)?.orchestrator);

export const retry = () => setShared(RETRY_KEY, Date.now());
