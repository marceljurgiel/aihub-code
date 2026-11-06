import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { bridgeErrLogPath } from "./bridge/client";
import { homeDir } from "./home";
import { codeSettingsPath, configPath } from "./theme";

// Bun's os.homedir() ignores a HOME set later (on Linux and macOS it is fixed at start),
// so every path under ~/.aihub must come from homeDir() (the env, at call time).
describe("tests never touch the real ~/.aihub", () => {
  // Saved by the preload before it swaps HOME (os.homedir() follows the swap
  // on Windows, so it can't be asked here).
  const real = String(process.env.AIHUB_TEST_REAL_HOME);
  // On Windows the temp folder is inside the profile (AppData\Local\Temp), so
  // what counts is staying out of the real ~/.aihub, not out of the profile.
  const realAihub = join(real, ".aihub");
  const outside = (p: string) => p !== real && !p.startsWith(realAihub);
  test("homeDir follows the environment at call time", () => {
    expect(homeDir({ AIHUB_CODE_HOME: "/x/a", HOME: "/x/b" })).toBe("/x/a");
    expect(homeDir({ HOME: "/x/b" })).toBe("/x/b");
    expect(homeDir({ USERPROFILE: "C:\\u" })).toBe("C:\\u");
  });
  test("under the preload, the app's ~/.aihub paths are not in the real home", () => {
    expect(outside(homeDir())).toBe(true);
    expect(outside(codeSettingsPath())).toBe(true);
    expect(outside(configPath())).toBe(true);
    expect(outside(bridgeErrLogPath({ ...process.env, AIHUB_CODE_ERR_LOG: undefined }))).toBe(true);
  });
  test("the preload points AIHUB_CODE_HOME (read first) at the temp home too", () => {
    expect(process.env.AIHUB_CODE_HOME).toBe(process.env.HOME);
    expect(outside(String(process.env.AIHUB_CODE_HOME))).toBe(true);
  });
});
