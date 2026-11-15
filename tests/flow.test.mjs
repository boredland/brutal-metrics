// Tests of the pure parts shared by the Metrics and Flow tabs: feed rules, geometry, scope, detail rows, avatar copies.
// Run: node --test tests/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MODS = join(dirname(fileURLToPath(import.meta.url)), "..", "mods");
const load = (p) => import(pathToFileURL(join(MODS, p)).href);
const feed = await load("agent-flow/feed.js");
const flow = await load("agent-flow/flow.js");
const scope = await load("agent-metrics/scope.js");
const M = await load("agent-metrics/model.js");

// ---- feed.js ----
test("feedState: reading, down, stale, live", () => {
  assert.equal(feed.feedState(undefined, 1000).state, "reading");
  const down = feed.feedState({ ok: false, at: 5, error: "boom" }, 1000);
  assert.equal(down.state, "down");
  assert.equal(down.error, "boom");
  assert.equal(feed.feedState({ ok: true, at: 1000 - feed.STALE_MS - 1, events: [] }, 1000).state, "stale");
  assert.equal(feed.feedState({ ok: true, at: 1000 - 100, events: [] }, 1000).state, "live");
});

test("withKinds marks a send back to the earlier sender as a reply", () => {
  const out = feed.withKinds([
    { id: 1, from: "a", to: "b", kind: "send" },
    { id: 2, from: "b", to: "a", kind: "send" },
    { id: 3, from: "a", to: "b", kind: "send" },
  ]);
  assert.deepEqual(out.map((e) => e.kind), ["send", "reply", "reply"]);
});

test("roleOf reads a role label from an array or an object", () => {
  assert.equal(feed.roleOf(["x=1", "role=orchestrator"]), "orchestrator");
  assert.equal(feed.roleOf({ role: "worker" }), "worker");
  assert.equal(feed.roleOf(undefined), undefined);
});

test("pickOrchestrator: published, else role label, else first", () => {
  const nodes = [{ address: "t1", labels: {} }, { address: "t2", labels: { role: "orchestrator" } }];
  assert.equal(feed.pickOrchestrator(nodes, "t1"), "t1");
  assert.equal(feed.pickOrchestrator(nodes, "gone"), "t2");
  assert.equal(feed.pickOrchestrator([{ address: "t9", labels: {} }], null), "t9");
  assert.equal(feed.pickOrchestrator([], null), null);
});

test("eventsAmong keeps sends with both ends in scope", () => {
  const evs = [{ from: "a", to: "b" }, { from: "a", to: "z" }, { from: "a", to: null }];
  assert.deepEqual(feed.eventsAmong(evs, new Set(["a", "b"])), [{ from: "a", to: "b" }]);
});

// ---- flow.js ----
test("plan: one box per agent, routes to and from the orchestrator", () => {
  const g = flow.plan({ width: 368, height: 900, orchestrator: "c", others: ["a", "b"], events: [] });
  assert.equal(g.boxes.length, 2);
  assert.equal(g.compact, false);
  const down = g.route("c", "a"), up = g.route("a", "c");
  assert.deepEqual(up, [...down].reverse());
  assert.equal(g.route("a", "a"), null);
  assert.equal(g.route("a", "b"), null, "no lane until the pair has messaged");
});

test("plan: a pair that messaged gets a lane on the right", () => {
  const g = flow.plan({ width: 368, height: 900, orchestrator: "c", others: ["a", "b"], events: [{ from: "a", to: "b" }] });
  const r = g.route("a", "b");
  assert.equal(r.length, 4);
  assert.ok(r[1].x > g.boxes[0].x + g.boxes[0].w - 1, "the lane runs right of the boxes");
});

test("plan: compact nodes when the column does not fit", () => {
  const roomy = flow.plan({ width: 368, height: 2000, orchestrator: "c", others: ["a", "b", "d", "e", "f"], events: [] });
  const tight = flow.plan({ width: 368, height: 300, orchestrator: "c", others: ["a", "b", "d", "e", "f"], events: [] });
  assert.equal(roomy.compact, false);
  assert.equal(tight.compact, true);
  assert.ok(tight.boxes[0].h < roomy.boxes[0].h);
});

// ---- scope.js ----
test("inScope: space, project, all", () => {
  const base = { spaceId: "s1", projectDir: "/p", agentSpace: "s1", agentDir: "/other" };
  assert.equal(scope.inScope("space", base), true);
  assert.equal(scope.inScope("space", { ...base, agentSpace: "s2" }), false);
  assert.equal(scope.inScope("project", base), false);
  assert.equal(scope.inScope("project", { ...base, agentSpace: "s2", agentDir: "/p" }), true);
  assert.equal(scope.inScope("project", { ...base, projectDir: "", agentDir: "" }), false, "no focused folder: nothing matches");
  assert.equal(scope.inScope("all", { ...base, agentSpace: "zz" }), true);
  assert.equal(scope.inScope("nonsense", base), true, "unknown scope behaves as space");
});

test("normDir drops the WSL prefix, trailing slash and case", () => {
  const B = String.fromCharCode(92); // a backslash, without escaping trouble
  assert.equal(scope.normDir([B + B + "wsl.localhost", "Ubuntu", "home", "Ale", "proj"].join(B) + B), "/home/ale/proj");
});

// ---- detail ----
test("detailOf and detailRows", () => {
  assert.equal(M.detailOf(null), null);
  const s = { agent: "claude", model: "claude-sonnet-5-5", account: { kind: "login", email: "a@b.c" }, cwd: "/p", session: "abcdef123456", started: 1000, mtime: 1000,
    ctx: 100_000, base: 20_000, in: 10, out: 20, cache_read: 900, cache_write: 90, turns: 3, tools: 7, tool: "Bash npm test",
    hist: [80_000, 90_000, 100_000], turn: { in: 1, out: 2, cr: 3, cw: 4, by: {} }, config: { plugins: ["p1"], mcp: [], hooks: ["h"] } };
  const d = M.detailOf(s);
  assert.equal(d.win, 200_000);
  assert.equal(d.left, 10);
  assert.equal(d.cachePct, 90);
  assert.deepEqual(d.turn, { in: 1, out: 2, cw: 4, cr: 3 });
  const rows = Object.fromEntries(M.detailRows(d, 1000 + 5 * 60_000));
  assert.equal(rows.ACCOUNT, "a@b.c");
  assert.equal(rows.SESSION, "abcdef12");
  assert.equal(rows["CACHE HIT"], "90%");
  assert.equal(rows["TURNS LEFT"], "~10");
  assert.equal(rows.STARTED, "5m ago");
  assert.equal(rows.CONFIGURED, "1 plugins · 0 MCP · 1 hooks");
  assert.equal("PLAN USED" in rows, false);
  const codex = M.detailOf({ ...s, agent: "codex", plan: { used: 42.4 } });
  assert.equal(Object.fromEntries(M.detailRows(codex, 0))["PLAN USED"], "42%");
});

// ---- the copies that must stay identical ----
test("avatar.js copies are identical in agent-metrics, agents-metrics and agent-flow", () => {
  const a = readFileSync(join(MODS, "agent-metrics", "avatar.js"), "utf8");
  assert.equal(readFileSync(join(MODS, "agents-metrics", "avatar.js"), "utf8"), a);
  assert.equal(readFileSync(join(MODS, "agent-flow", "avatar.js"), "utf8"), a);
});

test("scope.js copies are identical in agent-metrics and agent-flow", () => {
  assert.equal(readFileSync(join(MODS, "agent-flow", "scope.js"), "utf8"), readFileSync(join(MODS, "agent-metrics", "scope.js"), "utf8"));
});
