import { homedir } from "node:os";

/** The user's home, read from the environment at call time: the folder whose
 *  ~/.aihub the engine uses too. Bun's os.homedir() ignores a HOME set after
 *  start on Linux and macOS (the test preload sets one), so paths under
 *  ~/.aihub use this. On Windows USERPROFILE comes first, as Python's
 *  expanduser reads it (Git for Windows sets a HOME of its own).
 *  AIHUB_CODE_HOME is not read: the launcher sets it to the install folder. */
export function homeDir(env: Record<string, string | undefined> = process.env, platform: string = process.platform): string {
  const order = platform === "win32" ? [env.USERPROFILE, env.HOME] : [env.HOME, env.USERPROFILE];
  return order.find((p) => p) || homedir();
}
