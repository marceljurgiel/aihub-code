import { describe, expect, test } from "bun:test";
import { userInfo } from "node:os";
import { bridgeErrLogPath } from "./bridge/client";
import { homeDir } from "./home";
import { codeSettingsPath, configPath } from "./theme";

// Bun's os.homedir() is fixed at process start and ignores a HOME set later,
// so every path under ~/.aihub must come from homeDir() (the env, at call time).
describe("tests never touch the real ~/.aihub", () => {
  const real = userInfo().homedir;
  test("homeDir follows the environment at call time", () => {
    expect(homeDir({ AIHUB_CODE_HOME: "/x/a", HOME: "/x/b" })).toBe("/x/a");
    expect(homeDir({ HOME: "/x/b" })).toBe("/x/b");
    expect(homeDir({ USERPROFILE: "C:\\u" })).toBe("C:\\u");
  });
  test("under the preload, the app's ~/.aihub paths are not in the real home", () => {
    expect(homeDir().startsWith(real)).toBe(false);
    expect(codeSettingsPath().startsWith(real)).toBe(false);
    expect(configPath().startsWith(real)).toBe(false);
    expect(bridgeErrLogPath({ ...process.env, AIHUB_CODE_ERR_LOG: undefined }).startsWith(real)).toBe(false);
  });
});
