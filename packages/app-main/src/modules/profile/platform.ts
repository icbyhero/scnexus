import { join } from "node:path";
import { readdir } from "node:fs/promises";

import { exists } from "@/utils/fs-util";

/**
 * 平台差异的唯一集中点。
 * 本模块保持纯 Node 依赖（不 import electron），保证可单测。
 */

const GAME_REG_PATH_WIN =
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\StarCraft II";
const GAME_REG_ITEM_WIN = "InstallLocation";

// 各平台游戏根目录探测候选（按优先级）
const GAME_ROOT_CANDIDATES: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: ["/Applications/StarCraft II"],
};

// 根目录有效性标志：win 是主程序文件；mac 是 .app 包（目录）
const GAME_ROOT_MARKER: Partial<
  Record<NodeJS.Platform, { name: string; type: "file" | "directory" }>
> = {
  win32: { name: "StarCraft II.exe", type: "file" },
  darwin: { name: "StarCraft II.app", type: "directory" },
};

export type GameExecutables = {
  GAME_CLIENT: string;
  GAME_EXECUTABLE_X64: string;
  GAME_EDITOR_EXECUTABLE_X64: string;
};

export type DocumentsPaths = {
  DOCUMENTS_ROOT: string;
  DOCUMENTS_LOCAL_BANKS_ROOT: string;
  DOCUMENTS_ARCADE_BANKS_ROOT: string;
};

export async function isGameRootValid(gameRoot: string): Promise<boolean> {
  if (!gameRoot) return false;
  if (!(await exists(gameRoot))) return false;

  const marker = GAME_ROOT_MARKER[process.platform];
  if (!marker) return false;

  let rootFiles: import("node:fs").Dirent[];
  try {
    rootFiles = await readdir(gameRoot, { withFileTypes: true });
  } catch {
    return false;
  }
  return rootFiles.some(
    (dirent) =>
      (marker.type === "file" ? dirent.isFile() : dirent.isDirectory()) &&
      dirent.name === marker.name
  );
}

// candidates 参数仅供测试注入；生产代码使用平台默认候选
export async function detectGameRoot(candidates?: string[]): Promise<string> {
  if (process.platform === "win32") {
    // regedit 仅在 win32 分支动态加载，mac 上不加载、不触发
    const { default: reg } = await import("@/utils/reg");
    const data = await reg.list([GAME_REG_PATH_WIN]);
    return data[GAME_REG_PATH_WIN].values[GAME_REG_ITEM_WIN].value as string;
  }

  const platformCandidates = candidates ?? GAME_ROOT_CANDIDATES[process.platform] ?? [];
  for (const candidate of platformCandidates) {
    if (await isGameRootValid(candidate)) return candidate;
  }
  return "";
}

export function getGameExecutables(gameRoot: string): GameExecutables {
  if (process.platform === "darwin") {
    return {
      GAME_CLIENT: join(
        gameRoot,
        "StarCraft II.app",
        "Contents",
        "MacOS",
        "StarCraft II"
      ),
      GAME_EXECUTABLE_X64: join(
        gameRoot,
        "Support",
        "SC2Switcher.app",
        "Contents",
        "MacOS",
        "SC2Switcher"
      ),
      GAME_EDITOR_EXECUTABLE_X64: join(
        gameRoot,
        "StarCraft II Editor.app",
        "Contents",
        "MacOS",
        "StarCraft II Editor"
      ),
    };
  }
  // win32 与现有行为一致
  return {
    GAME_CLIENT: join(gameRoot, "StarCraft II.exe"),
    GAME_EXECUTABLE_X64: join(gameRoot, "Support64", "SC2Switcher_x64.exe"),
    GAME_EDITOR_EXECUTABLE_X64: join(gameRoot, "Support64", "SC2Editor_x64.exe"),
  };
}

export function getGameMapsDirName(): string {
  return process.platform === "darwin" ? "maps" : "Maps";
}

export function getDocumentsPaths({
  homeDir,
  documentsDir,
}: {
  homeDir: string;
  documentsDir: string;
}): DocumentsPaths {
  if (process.platform === "darwin") {
    // mac 的 Banks 按账户分层（Accounts/<portal>/<uid>/Banks），
    // 默认指向 Blizzard 根目录，具体子路径可在设置页调整
    const blizzardRoot = join(
      homeDir,
      "Library",
      "Application Support",
      "Blizzard",
      "StarCraft II"
    );
    return {
      DOCUMENTS_ROOT: blizzardRoot,
      DOCUMENTS_LOCAL_BANKS_ROOT: blizzardRoot,
      DOCUMENTS_ARCADE_BANKS_ROOT: blizzardRoot,
    };
  }
  return {
    DOCUMENTS_ROOT: join(documentsDir, "StarCraft II"),
    DOCUMENTS_LOCAL_BANKS_ROOT: join(documentsDir, "StarCraft II", "Banks"),
    DOCUMENTS_ARCADE_BANKS_ROOT: join(documentsDir, "StarCraft II", "ArcadeBanks"),
  };
}
