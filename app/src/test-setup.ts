// Preloaded by `bun test` (bunfig.toml): keep test runs out of the user's
// ~/.aihub/aihub-code-bridge.err.log.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIHUB_CODE_ERR_LOG = join(mkdtempSync(join(tmpdir(), "aihub-code-test-")), "bridge.err.log");

// Ported from AIhub-TUI v1.5.0 app/src/test-setup.ts: automatic memory learns
// after the user goes quiet; tests needn't wait 20 s.
process.env.AIHUB_LEARN_IDLE_MS = "80";
