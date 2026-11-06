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
    expect(homeDir({ HOME: "/x/b" }, "linux")).toBe("/x/b");
    expect(homeDir({ USERPROFILE: "C:\\u" }, "win32")).toBe("C:\\u");
  });
  test("the launcher's AIHUB_CODE_HOME is where aihub-code is installed, never the home", () => {
    // aihub-code.cmd sets it for the install; settings there would be lost on update.
    expect(homeDir({ AIHUB_CODE_HOME: "C:\\inst", USERPROFILE: "C:\\u" }, "win32")).toBe("C:\\u");
    expect(homeDir({ AIHUB_CODE_HOME: "/opt/aihub-code", HOME: "/home/alex" }, "linux")).toBe("/home/alex");
  });
  test("Windows: USERPROFILE before HOME, as the engine's Python reads it (Git sets HOME)", () => {
    expect(homeDir({ HOME: "C:\\git-home", USERPROFILE: "C:\\u" }, "win32")).toBe("C:\\u");
    expect(homeDir({ HOME: "/home/alex", USERPROFILE: "/elsewhere" }, "linux")).toBe("/home/alex");
  });
  test("under the preload, the app's ~/.aihub paths are not in the real home", () => {
    expect(outside(homeDir())).toBe(true);
    expect(outside(codeSettingsPath())).toBe(true);
    expect(outside(configPath())).toBe(true);
    expect(outside(bridgeErrLogPath({ ...process.env, AIHUB_CODE_ERR_LOG: undefined }))).toBe(true);
  });
  test("the preload points both HOME and USERPROFILE at the temp home", () => {
    expect(process.env.USERPROFILE).toBe(process.env.HOME);
    expect(outside(String(process.env.HOME))).toBe(true);
  });
});
