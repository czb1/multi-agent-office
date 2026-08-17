import { delimiter, join } from "node:path";

/**
 * Builds the environment for the bundled server process.
 *
 * Windows compares environment variable names case-insensitively while Node keeps
 * the casing the process was started with — `Path` in practice. Spreading
 * `process.env` and then assigning `PATH` therefore hands the child two entries
 * for the same variable and lets the platform pick a winner, which is how the
 * bundled server ends up without the directories the desktop app added.
 */
export function mergeChildEnvironment(
  base: NodeJS.ProcessEnv,
  overrides: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    for (const existing of Object.keys(merged)) {
      if (existing !== key && existing.toLowerCase() === key.toLowerCase()) {
        delete merged[existing];
      }
    }
    merged[key] = value;
  }
  return merged;
}

/**
 * Prepends the directories a user-installed Codex CLI is normally found in to the
 * inherited search path.
 */
export function desktopSearchPath(input: {
  platform: NodeJS.Platform;
  environment: NodeJS.ProcessEnv;
  homeDirectory: string;
  pathDelimiter?: string;
}): string {
  const separator = input.pathDelimiter ?? delimiter;
  const candidates =
    input.platform === "win32"
      ? [
          input.environment.APPDATA ? join(input.environment.APPDATA, "npm") : "",
          input.environment.LOCALAPPDATA
            ? join(input.environment.LOCALAPPDATA, "Programs", "codex")
            : "",
        ]
      : [
          join(input.homeDirectory, ".local", "bin"),
          "/opt/homebrew/bin",
          "/usr/local/bin",
          "/usr/bin",
          "/bin",
        ];
  const inherited = readPath(input.environment);
  return [...candidates.filter(Boolean), inherited].filter(Boolean).join(separator);
}

/** Reads the search path under whichever casing the current platform used. */
export function readPath(environment: NodeJS.ProcessEnv): string {
  for (const [key, value] of Object.entries(environment)) {
    if (key.toLowerCase() === "path" && value) return value;
  }
  return "";
}
