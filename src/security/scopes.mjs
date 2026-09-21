// Scopes assignable to an API key — deliberately a *narrower* set than
// what a signed-in session can do (src/api/server.mjs's requireScope
// grants a session full access to its own workspace unconditionally,
// with no per-key scoping at all, since that's what API keys are for).
// Three scopes that existed pre-v2.0.0 are gone entirely, not just
// unassignable: `build:read:any` (an admin cross-tenant bypass —
// removed for absolute per-user isolation, no exceptions), and
// `system:manage`/`api-key:manage` (server updates/backups and API-key
// lifecycle are now pure session+role checks, requireAdmin/session-only,
// never satisfiable via a Bearer key — a leaked CI key can no longer
// trigger a server update or mint more keys).
export const KNOWN_SCOPES = [
  "build:create",
  "build:read",
  "build:logs",
  "build:cancel",
  "artifact:download",
  "artifact:manage",
  "metrics:read",
];

export function parseScopes(scopesColumn) {
  if (!scopesColumn) {
    return null;
  }

  return scopesColumn.split(",").map((scope) => scope.trim()).filter(Boolean);
}

export function serializeScopes(scopes) {
  if (!scopes || scopes.length === 0) {
    return null;
  }

  return scopes.join(",");
}

// A key with no scopes recorded is a legacy full-access key (created
// before scopes existed) — preserves current API behavior for keys
// already provisioned rather than silently locking them out.
export function hasScope(apiKey, scope) {
  return !apiKey.scopes || apiKey.scopes.includes(scope);
}
