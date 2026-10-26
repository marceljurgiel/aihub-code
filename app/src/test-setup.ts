// Preloaded by `bun test` (bunfig.toml): keep test runs out of the user's
// ~/.aihub/aihub-code-bridge.err.log.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIHUB_CODE_ERR_LOG = join(mkdtempSync(join(tmpdir(), "aihub-code-test-")), "bridge.err.log");
