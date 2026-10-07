import { join } from "node:path";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  detectGameRoot,
  getAppBundlePath,
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

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns false for empty path", async () => {
    expect(await isGameRootValid("")).toBe(false);
  });

  it("returns false for nonexistent path", async () => {
    expect(await isGameRootValid(join(tmpRoot, "no-such-dir"))).toBe(false);
  });

  it("returns false when marker is missing", async () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    expect(await isGameRootValid(tmpRoot)).toBe(false);
  });

  it("returns true when darwin marker (StarCraft II.app dir) exists", async () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    await mkdir(join(tmpRoot, "StarCraft II.app"), { recursive: true });
    expect(await isGameRootValid(tmpRoot)).toBe(true);
    await rm(join(tmpRoot, "StarCraft II.app"), { recursive: true });
  });

  it("returns true when win32 marker (StarCraft II.exe file) exists", async () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(tmpRoot, "StarCraft II.exe"), "");
    expect(await isGameRootValid(tmpRoot)).toBe(true);
    await rm(join(tmpRoot, "StarCraft II.exe"));
  });

  it("returns false when gameRoot is a file (not a directory)", async () => {
    const { writeFile } = await import("node:fs/promises");
    const filePath = join(tmpRoot, "not-a-dir.txt");
    await writeFile(filePath, "");
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    expect(await isGameRootValid(filePath)).toBe(false);
    await rm(filePath);
  });
});

describe("detectGameRoot", () => {
  let tmpRoot: string;

  beforeAll(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "scnexus-detect-"));
  });

  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the first valid candidate", async () => {
    const validDir = join(tmpRoot, "valid");
    await mkdir(join(validDir, "StarCraft II.app"), { recursive: true });
    const invalidDir = join(tmpRoot, "invalid");
    await mkdir(invalidDir, { recursive: true });

    vi.stubGlobal("process", { ...process, platform: "darwin" });
    const result = await detectGameRoot([invalidDir, validDir]);
    expect(result).toBe(validDir);
  });

  it("returns empty string when no candidate is valid", async () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    const result = await detectGameRoot([join(tmpRoot, "nope1"), join(tmpRoot, "nope2")]);
    expect(result).toBe("");
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

describe("getAppBundlePath", () => {
  it("extracts the .app bundle path from an inner executable path", () => {
    expect(
      getAppBundlePath(
        "/Applications/StarCraft II/Support/SC2Switcher.app/Contents/MacOS/SC2Switcher"
      )
    ).toBe("/Applications/StarCraft II/Support/SC2Switcher.app");
  });

  it("returns null for non-bundle paths", () => {
    expect(
      getAppBundlePath("C:\\Games\\StarCraft II\\Support64\\SC2Switcher_x64.exe")
    ).toBe(null);
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
