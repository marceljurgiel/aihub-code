// Preloaded by `bun test` (bunfig.toml): keep test runs out of the user's
// ~/.aihub/aihub-code-bridge.err.log.
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIHUB_CODE_ERR_LOG = join(mkdtempSync(join(tmpdir(), "aihub-code-test-")), "bridge.err.log");

// Ported from AIhub-TUI v1.5.0 app/src/test-setup.ts: automatic memory learns
// after the user goes quiet; tests needn't wait 20 s.
process.env.AIHUB_LEARN_IDLE_MS = "80";

// Tests never touch the real ~/.aihub (theme and settings files, caches): the
// home directory is a temp one for the whole run. Bun's os.homedir() ignores a
// HOME set at runtime, so the app reads it through homeDir() (src/home.ts),
// which follows this env; home.test.ts guards it.
// The real home, before it is swapped (Bun on Windows reads USERPROFILE at
// every os.homedir() call), so home.test.ts can check the swap.
process.env.AIHUB_TEST_REAL_HOME = homedir();
const home = mkdtempSync(join(tmpdir(), "aihub-code-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

// The ideal glyphs everywhere, so frames match on Windows too (it would get
// the console-safe set); glyphs.test.ts checks that set on its own.
// AIHUB_GLYPHS=ascii-safe in the shell still runs the suite with it.
process.env.AIHUB_GLYPHS ??= "unicode";
