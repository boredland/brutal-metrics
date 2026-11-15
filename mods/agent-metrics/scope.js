// Which agents the Metrics and Flow tabs show. The choice lives in shared state (SCOPE_KEY), so both tabs follow
// one switch. Pure (no Herdr imports). A copy of this file is in agent-flow/: keep them identical.

export const SCOPE_KEY = "metrics.scope";
export const SCOPES = [
  ["space", "SPACE", "Agents of the shown space"],
  ["project", "PROJECT", "Agents in the focused terminal's folder, in any space"],
  ["all", "ALL", "Every agent in every space"],
];

// A path as comparable text: slashes, no \wsl.localhost\<distro> prefix, no trailing slash, lower case.
export const normDir = (p) => (p ?? "").replaceAll("\\", "/").replace(/^\/\/wsl[.]localhost\/[^/]+/i, "").replace(/\/+$/, "").toLowerCase();

// Is an agent in scope? `scope`: "space" | "project" | "all" (anything else counts as "space").
//   spaceId: the shown space; projectDir: the focused terminal's folder (normDir); agentSpace, agentDir: the agent's.
export function inScope(scope, { spaceId, projectDir, agentSpace, agentDir }) {
  if (scope === "all") return true;
  if (scope === "project") return Boolean(projectDir) && agentDir === projectDir;
  return agentSpace === spaceId;
}
