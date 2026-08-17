import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
  desktopSearchPath,
  mergeChildEnvironment,
  readPath,
} from "../src/core/desktop-env.js";

test("replaces the inherited search path instead of duplicating it on Windows", () => {
  const merged = mergeChildEnvironment(
    { Path: "C:\\Windows", SystemRoot: "C:\\Windows" },
    { PATH: "C:\\Users\\a\\AppData\\Roaming\\npm;C:\\Windows" },
  );

  const pathKeys = Object.keys(merged).filter((key) => key.toLowerCase() === "path");
  assert.deepEqual(pathKeys, ["PATH"]);
  assert.equal(merged.PATH, "C:\\Users\\a\\AppData\\Roaming\\npm;C:\\Windows");
  assert.equal(merged.SystemRoot, "C:\\Windows");
});

test("keeps unrelated variables and applies every override", () => {
  const merged = mergeChildEnvironment(
    { PATH: "/usr/bin", HOME: "/home/a" },
    { PATH: "/opt/bin:/usr/bin", PORT: "4173", ELECTRON_RUN_AS_NODE: "1" },
  );

  assert.equal(merged.HOME, "/home/a");
  assert.equal(merged.PATH, "/opt/bin:/usr/bin");
  assert.equal(merged.PORT, "4173");
  assert.equal(merged.ELECTRON_RUN_AS_NODE, "1");
});

test("prepends Windows Codex locations to the inherited path under any casing", () => {
  const search = desktopSearchPath({
    platform: "win32",
    environment: {
      Path: "C:\\Windows",
      APPDATA: "C:\\Users\\a\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local",
    },
    homeDirectory: "C:\\Users\\a",
    pathDelimiter: ";",
  });

  // `join` follows the host separator, so build the expectation the same way.
  assert.deepEqual(search.split(";"), [
    join("C:\\Users\\a\\AppData\\Roaming", "npm"),
    join("C:\\Users\\a\\AppData\\Local", "Programs", "codex"),
    "C:\\Windows",
  ]);
});

test("skips Windows candidates whose base directory is not set", () => {
  const search = desktopSearchPath({
    platform: "win32",
    environment: { Path: "C:\\Windows" },
    homeDirectory: "C:\\Users\\a",
    pathDelimiter: ";",
  });

  assert.deepEqual(search.split(";"), ["C:\\Windows"]);
});

test("reads the search path regardless of casing", () => {
  assert.equal(readPath({ Path: "C:\\Windows" }), "C:\\Windows");
  assert.equal(readPath({ PATH: "/usr/bin" }), "/usr/bin");
  assert.equal(readPath({}), "");
});
