import { join } from "node:path";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  getDocumentsPaths,
  getGameExecutables,
  getGameMapsDirName,
  isGameRootValid,
} from "./platform";

const isDarwin = process.platform === "darwin";

describe("isGameRootValid", () => {
  let tmpRoot: string;

  beforeAll(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "scnexus-platform-"));
  });

  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("returns false for empty path", async () => {
    expect(await isGameRootValid("")).toBe(false);
  });

  it("returns false for nonexistent path", async () => {
    expect(await isGameRootValid(join(tmpRoot, "no-such-dir"))).toBe(false);
  });

  it("returns false when marker is missing", async () => {
    expect(await isGameRootValid(tmpRoot)).toBe(false);
  });

  it("returns true when platform marker exists", async () => {
    if (isDarwin) {
      await mkdir(join(tmpRoot, "StarCraft II.app"), { recursive: true });
    } else {
      await mkdir(join(tmpRoot, "dummy"), { recursive: true });
      // 非 darwin 平台用文件标记，模拟 win 的 StarCraft II.exe
      const { writeFile } = await import("node:fs/promises");
      await rm(join(tmpRoot, "dummy"), { recursive: true });
      await writeFile(join(tmpRoot, "StarCraft II.exe"), "");
    }
    expect(await isGameRootValid(tmpRoot)).toBe(true);
  });
});

describe("getGameMapsDirName", () => {
  it("uses lowercase maps dir on darwin, Maps elsewhere", () => {
    expect(getGameMapsDirName()).toBe(isDarwin ? "maps" : "Maps");
  });
});

describe("getGameExecutables", () => {
  it("returns darwin bundle paths on darwin", () => {
    const result = getGameExecutables("/Applications/StarCraft II");
    if (isDarwin) {
      expect(result.GAME_CLIENT).toBe(
        join("/Applications/StarCraft II", "StarCraft II.app", "Contents", "MacOS", "StarCraft II")
      );
      expect(result.GAME_EXECUTABLE_X64).toBe(
        join("/Applications/StarCraft II", "Support", "SC2Switcher.app", "Contents", "MacOS", "SC2Switcher")
      );
      expect(result.GAME_EDITOR_EXECUTABLE_X64).toBe(
        join(
          "/Applications/StarCraft II",
          "StarCraft II Editor.app",
          "Contents",
          "MacOS",
          "StarCraft II Editor"
        )
      );
    } else {
      expect(result.GAME_CLIENT).toBe(join("/Applications/StarCraft II", "StarCraft II.exe"));
      expect(result.GAME_EXECUTABLE_X64).toBe(
        join("/Applications/StarCraft II", "Support64", "SC2Switcher_x64.exe")
      );
      expect(result.GAME_EDITOR_EXECUTABLE_X64).toBe(
        join("/Applications/StarCraft II", "Support64", "SC2Editor_x64.exe")
      );
    }
  });
});

describe("getDocumentsPaths", () => {
  it("returns Blizzard App Support root on darwin", () => {
    const result = getDocumentsPaths({
      homeDir: "/Users/test",
      documentsDir: "/Users/test/Documents",
    });
    if (isDarwin) {
      const expected = join(
        "/Users/test",
        "Library",
        "Application Support",
        "Blizzard",
        "StarCraft II"
      );
      expect(result.DOCUMENTS_ROOT).toBe(expected);
      expect(result.DOCUMENTS_LOCAL_BANKS_ROOT).toBe(expected);
      expect(result.DOCUMENTS_ARCADE_BANKS_ROOT).toBe(expected);
    } else {
      expect(result.DOCUMENTS_ROOT).toBe(join("/Users/test/Documents", "StarCraft II"));
      expect(result.DOCUMENTS_LOCAL_BANKS_ROOT).toBe(
        join("/Users/test/Documents", "StarCraft II", "Banks")
      );
      expect(result.DOCUMENTS_ARCADE_BANKS_ROOT).toBe(
        join("/Users/test/Documents", "StarCraft II", "ArcadeBanks")
      );
    }
  });
});
