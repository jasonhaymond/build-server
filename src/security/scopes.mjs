// build:read:any isn't one of PROJECT-SCOPE.md's listed scopes — it's the
// admin-style escape hatch multi-tenant isolation needs so at least one
// kind of key can see across clients (support/ops use), distinct from the
// plain build:read every regular key gets scoped to its own builds with.
// It's a single ownership-bypass flag that applies across every build-
// scoped route (read, logs, artifacts, cancel) — requireBuildAccess checks
// it regardless of which specific action scope the route also requires.
// An admin key needs both, e.g. ["build:read", "build:read:any"]: the
// first says it may read builds at all, the second says whose.
export const KNOWN_SCOPES = [
  "build:create",
  "build:read",
  "build:read:any",
  "build:logs",
  "build:cancel",
  "artifact:download",
  "artifact:manage",
  "api-key:manage",
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
