import { homedir } from "node:os";

/** The user's home, read from the environment at call time. Bun's
 *  os.homedir() is fixed when the process starts and ignores a HOME set
 *  afterwards (the test preload sets one), so paths under ~/.aihub use this. */
export function homeDir(env: Record<string, string | undefined> = process.env): string {
  return env.AIHUB_CODE_HOME || env.HOME || env.USERPROFILE || homedir();
}
