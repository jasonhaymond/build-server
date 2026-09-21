import migration0001 from "./0001_init.mjs";
import migration0002 from "./0002_artifact_tokens.mjs";
import migration0003 from "./0003_queue_recovery.mjs";
import migration0004 from "./0004_artifacts_and_scopes.mjs";

// Forward-only, ordered, non-interactive. No down migrations — see
// PROJECT-SCOPE.md's database section and the global deployment standard.
export const migrations = [
  migration0001,
  migration0002,
  migration0003,
  migration0004,
];
