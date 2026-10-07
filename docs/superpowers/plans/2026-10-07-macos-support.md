# SCNexus macOS 适配实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 SCNexus 在 macOS 上本地可用：自动探测 SC2 安装路径、校验游戏根目录、按平台生成可执行文件/目录路径、可启动游戏。

**Architecture:** 新建 `platform.ts` 作为平台差异唯一集中点（纯 Node、无 electron 依赖、可单测）；`profile-store.ts`、`profile-util.ts`、`stores/profile.ts` 接入。`client-launcher.ts` 无需修改（由 store 值驱动，与 spec 的偏差已在下方说明）。

**Tech Stack:** Electron 33 + TypeScript + Vite (monorepo, pnpm) + vitest

**Spec:** `docs/superpowers/specs/2026-10-07-macos-support-design.md`

**与 spec 的偏差说明：**
- `getGameDirectoryPaths(gameRoot)` 收敛为 `getGameMapsDirName()`：分析发现所有游戏目录路径中唯一平台差异是地图目录名（`Maps` vs `maps`），其余（`Mods`/`Campaign`/`CustomCampaigns`/`SCNexusCampaign` 等）两平台一致，全量映射对象是冗余抽象。
- `client-launcher.ts` 不修改：它从 profileStore 读取路径，store 值变为平台正确后自动适配；`exec`/`execFile` 带引号调用在 mac 的 `/bin/sh` 下同样有效。

**关键平台事实（已实测）：** mac 根目录标记是目录 `StarCraft II.app`（非文件！）；主程序二进制 `StarCraft II.app/Contents/MacOS/StarCraft II`；Switcher `Support/SC2Switcher.app/Contents/MacOS/SC2Switcher`；编辑器 `StarCraft II Editor.app/Contents/MacOS/StarCraft II Editor`；地图目录小写 `maps`；Banks 在 `~/Library/Application Support/Blizzard/StarCraft II`。

---

### Task 0: 环境准备

**Files:** 无代码改动

- [ ] **Step 1: 安装 pnpm（engines 要求 >=9.0.0）**

```bash
corepack enable 2>/dev/null; corepack prepare pnpm@9 --activate 2>/dev/null || npm i -g pnpm@9 || brew install pnpm
pnpm -v
```

Expected: 输出版本号 >= 9.0.0

- [ ] **Step 2: 安装依赖**

```bash
cd scnexus && pnpm install
```

Expected: 成功完成，postinstall 生成 `packages/app-main/.electron-vendors.cache.json`。若 electron 二进制下载慢/失败：`export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 后重试。

- [ ] **Step 3: 验证构建链路可用（mac 上现状）**

```bash
pnpm typecheck:main
```

Expected: PASS（当前代码在 mac 上应可类型检查）

---

### Task 1: app-main vitest 基建

**Files:**
- Modify: `packages/app-main/package.json`（devDependencies 加 vitest）
- Create: `packages/app-main/vitest.config.ts`

- [ ] **Step 1: 添加 vitest 依赖（与 app-renderer 版本一致 ^2.1.8）**

```bash
pnpm -F @scnexus/app-main add -D vitest@^2.1.8
```

- [ ] **Step 2: 创建 `packages/app-main/vitest.config.ts`**

```ts
import { join } from "node:path";
import { defineConfig } from "vitest/config";

const PACKAGE_ROOT = __dirname;

export default defineConfig({
  root: PACKAGE_ROOT,
  resolve: {
    alias: {
      "@/": join(PACKAGE_ROOT, "src") + "/",
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.spec.ts"],
  },
});
```

- [ ] **Step 3: 验证 vitest 可运行**

```bash
pnpm -F @scnexus/app-main exec vitest run --passWithNoTests
```

Expected: `No test files found` 但以 PASS 结束（--passWithNoTests）

- [ ] **Step 4: Commit**

```bash
git add packages/app-main/package.json packages/app-main/vitest.config.ts pnpm-lock.yaml
git commit -m "chore(main): add vitest infrastructure for app-main"
```

---

### Task 2: platform.spec.ts —— 失败测试先行（TDD）

**Files:**
- Create: `packages/app-main/src/modules/profile/platform.spec.ts`
- Test: 同上

- [ ] **Step 1: 编写失败测试**

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm -F @scnexus/app-main exec vitest run platform.spec
```

Expected: FAIL —— `Failed to resolve import "./platform"`（模块不存在）

- [ ] **Step 3: Commit（红）**

```bash
git add packages/app-main/src/modules/profile/platform.spec.ts
git commit -m "test(main): add failing tests for platform path abstraction"
```

---

### Task 3: 实现 platform.ts

**Files:**
- Create: `packages/app-main/src/modules/profile/platform.ts`

- [ ] **Step 1: 实现**

```ts
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

  const rootFiles = await readdir(gameRoot, { withFileTypes: true });
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
```

- [ ] **Step 2: 运行测试确认通过**

```bash
pnpm -F @scnexus/app-main exec vitest run platform.spec
```

Expected: 7 个测试全部 PASS

- [ ] **Step 3: Commit（绿）**

```bash
git add packages/app-main/src/modules/profile/platform.ts
git commit -m "feat(main): add platform path abstraction module"
```

---

### Task 4: profile-store.ts 接入平台模块

**Files:**
- Modify: `packages/app-main/src/modules/profile/profile-store.ts`

- [ ] **Step 1: 重写接入**

关键改动：
1. 删除顶部 `import reg from "@/utils/reg";`（regedit 改为经 platform.ts 在 win32 分支动态加载）
2. 删除 `GAME_REG_PATH_WIN`/`GAME_REG_ITEM_WIN` 常量（移入 platform.ts）
3. `else if (process.platform === "win32")` 与 darwin TODO 分支合并为 `else if (process.platform === "win32" || process.platform === "darwin")`，统一走 `detectGameRoot()`；空结果 → `GAME_ROOT_NOT_FOUND`（darwin 的 `UNSUPPORTED_PLATFORM` 分支删除）
4. `PROFILE_GAME` 三个可执行路径改用 `getGameExecutables(gameRoot)`
5. 所有 `join(gameRoot, "Maps", ...)` 改用 `const mapsDir = getGameMapsDirName()`
6. `PROFILE_DOCUMENTS` 改用 `getDocumentsPaths({ homeDir: app.getPath("home"), documentsDir: documentRoot })`
7. `PATH_WHITE_LIST` 中的 `"Maps"` 同步改用 `mapsDir`

```ts
import { join } from "node:path";
import { app } from "electron";

import { profileStore } from "@/stores/profile";
import { ProfileStore } from "@scnexus/app-shared/stores/profile.store";

import {
  detectGameRoot,
  getDocumentsPaths,
  getGameExecutables,
  getGameMapsDirName,
} from "./platform";

import { checkGameRootValid } from "./profile-util";

const documentRoot = app.getPath("documents");

export async function initProfileStore(
  gamePath?: string
): Promise<ProfileStore> {

  console.log("init profile store, " + gamePath);

  // process profile, init or get the existed profile
  const profile = profileStore.store;
  // get the gameRoot to check
  let gameRoot = "";
  if (gamePath) {
    // if the gamePath is provided, start to use and check it
    gameRoot = gamePath;
  } else if (profile.SUCCESS && !!profile.PROFILE_GAME.GAME_ROOT) {
    // if profile is inintialized, check again
    gameRoot = profile.PROFILE_GAME.GAME_ROOT;
  } else if (process.platform === "win32" || process.platform === "darwin") {
    // standard process to get the game root (registry on win32, candidates on darwin)
    try {
      gameRoot = await detectGameRoot();
    } catch {
      gameRoot = "";
    }
    if (!gameRoot) {
      profileStore.set("SUCCESS", false);
      profileStore.set("ERROR_MESSAGE", "GAME_ROOT_NOT_FOUND");
      return profileStore.store;
    }
  } else {
    profileStore.set("SUCCESS", false);
    profileStore.set("ERROR_MESSAGE", "FAILED_GET_GAME_ROOT");
    return profileStore.store;
  }
  const valid = await checkGameRootValid(gameRoot);
  console.log("game root valid: " + valid);
  // start to check the game root
  if (valid) {
    profileStore.set("SUCCESS", true);
  } else {
    profileStore.set("SUCCESS", false);
    profileStore.set("ERROR_MESSAGE", "GAME_ROOT_INVALID");
    return profileStore.store;
  }

  const mapsDir = getGameMapsDirName();
  const documents = getDocumentsPaths({
    homeDir: app.getPath("home"),
    documentsDir: documentRoot,
  });
  // init profile game
  profileStore.set("PROFILE_GAME", {
    GAME_ROOT: gameRoot,
    GAME_VERSION: "5.0.11.90136",
    ...getGameExecutables(gameRoot),
    GAME_MODS_PATH: join(gameRoot, "Mods"),
    GAME_MAPS_PATH: join(gameRoot, mapsDir),
  });
  // init profile documents
  profileStore.set("PROFILE_DOCUMENTS", documents);
  // init profile campaign
  profileStore.set("PROFILE_CAMPAIGN", {
    LIBRARY_ROOT: join(gameRoot, "SCNexusCampaign"),
    CCM_ROOT: join(gameRoot, mapsDir, "CustomCampaigns"),
    MAPS_ROOT: join(gameRoot, mapsDir),
    MODS_ROOT: join(gameRoot, "Mods"),
    WOL_ROOT: join(gameRoot, mapsDir, "Campaign"),
    HOTS_ROOT: join(gameRoot, mapsDir, "Campaign", "swarm"),
    HOTS_EVO_ROOT: join(gameRoot, mapsDir, "Campaign", "swarm", "evolution"),
    LOTV_ROOT: join(gameRoot, mapsDir, "Campaign", "void"),
    LOTV_PRO_ROOT: join(gameRoot, mapsDir, "Campaign", "voidprologue"),
    NCO_ROOT: join(gameRoot, mapsDir, "Campaign", "nova"),
  });
  // init profile customize
  profileStore.set("PROFILE_CUSTOMIZE", {
    LIBRARY_ROOT: join(gameRoot, "SCNexusCustomize"),
    MAPS_ROOT: join(gameRoot, mapsDir),
    MODS_ROOT: join(gameRoot, "Mods"),
  });
  // process profile data

  profileStore.set("PATH_WHITE_LIST", [
    // save all paths above as white list,
    // used to check if the path is in the white list
    join(gameRoot, mapsDir),
    join(gameRoot, "Mods"),
    join(gameRoot, "SCNexusCampaign"),
    join(gameRoot, "SCNexusCustomize"),
    join(gameRoot, mapsDir, "CustomCampaigns"),
    join(gameRoot, mapsDir, "Campaign"),
    join(gameRoot, mapsDir, "Campaign", "swarm"),
    join(gameRoot, mapsDir, "Campaign", "swarm", "evolution"),
    join(gameRoot, mapsDir, "Campaign", "void"),
    join(gameRoot, mapsDir, "Campaign", "voidprologue"),
    join(gameRoot, mapsDir, "Campaign", "nova"),
    // join(documentRoot, "StarCraft II"),
    // join(documentRoot, "StarCraft II", "Banks"),
    // join(documentRoot, "StarCraft II", "ArcadeBanks"),
  ]);
  profileStore.set("SUCCESS", true);
  const newProfile = profileStore.store;
  return newProfile;
}
```

注意：`getGameExecutables` 返回的键名（`GAME_CLIENT`/`GAME_EXECUTABLE_X64`/`GAME_EDITOR_EXECUTABLE_X64`）与 `ProfileGame` 类型键完全一致，用展开合并；`GAME_VERSION` 保持在展开之前不冲突。

- [ ] **Step 2: 类型检查**

```bash
pnpm typecheck:main
```

Expected: PASS，无错误

- [ ] **Step 3: 回归运行 platform 单测**

```bash
pnpm -F @scnexus/app-main exec vitest run platform.spec
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/app-main/src/modules/profile/profile-store.ts
git commit -m "feat(main): wire profile store to platform abstraction (darwin support)"
```

---

### Task 5: profile-util.ts 校验接入

**Files:**
- Modify: `packages/app-main/src/modules/profile/profile-util.ts:14-33`

- [ ] **Step 1: `checkGameRootValid` 委托 platform 模块**

替换原函数（删除本地 readdir/marker 逻辑）：

```ts
import { isGameRootValid } from "./platform";

export async function checkGameRootValid(gameRoot: string): Promise<boolean> {
  console.log("checkGameRootValid", gameRoot);
  return await isGameRootValid(gameRoot);
}
```

同时清理该文件顶部不再使用的 `readdir` 导入（`access` 若仅被 `exists` 使用也一并清理，保持仅实际使用的导入）。

- [ ] **Step 2: 类型检查**

```bash
pnpm typecheck:main
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/app-main/src/modules/profile/profile-util.ts
git commit -m "refactor(main): delegate game root validation to platform module"
```

---

### Task 6: stores/profile.ts 默认值按平台

**Files:**
- Modify: `packages/app-main/src/stores/profile.ts:15-49`

- [ ] **Step 1: 默认值接入平台模块**

```ts
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { app } from "electron";

import Store from "electron-store";
import { ProfileStore } from "@scnexus/app-shared/stores/profile.store";

import { getDocumentsPaths, getGameMapsDirName } from "@/modules/profile/platform";

const appDataRoot = app.getPath("userData");
const documentRoot = app.getPath("documents");
const mapsDir = getGameMapsDirName();

if (!existsSync(appDataRoot)) {
  mkdirSync(appDataRoot);
}

const defaultProfile: ProfileStore = {
  SUCCESS: false,
  PATH_WHITE_LIST: [],
  PROFILE_GAME: {
    GAME_ROOT: "",
    GAME_VERSION: "5.0.11.90136",
    GAME_CLIENT: "StarCraft II.exe",
    GAME_EXECUTABLE_X64: "SC2Switcher_x64.exe",
    GAME_EDITOR_EXECUTABLE_X64: "SC2Editor_x64.exe",
    GAME_MODS_PATH: "",
    GAME_MAPS_PATH: "",
  },
  PROFILE_DOCUMENTS: getDocumentsPaths({
    homeDir: app.getPath("home"),
    documentsDir: documentRoot,
  }),
  PROFILE_CAMPAIGN: {
    LIBRARY_ROOT: "SCNexusCampaign",
    CCM_ROOT: join(mapsDir, "CustomCampaigns"),
    MODS_ROOT: "Mods",
    MAPS_ROOT: mapsDir,
    WOL_ROOT: "Campaign",
    HOTS_ROOT: join("Campaign", "swarm"),
    HOTS_EVO_ROOT: join("Campaign", "swarm", "evolution"),
    LOTV_ROOT: join("Campaign", "void"),
    LOTV_PRO_ROOT: join("Campaign", "voidprologue"),
    NCO_ROOT: join("Campaign", "nova"),
  },
  PROFILE_CUSTOMIZE: {
    LIBRARY_ROOT: "SCNexusCustomize",
    MODS_ROOT: "Mods",
    MAPS_ROOT: mapsDir,
  },
};
```

其余代码（`profileStore` 实例、`profileStoreFunction`）不变。注意：`PROFILE_GAME` 默认值中的 win 文件名仅为初始化占位，`initProfileStore` 成功后会被平台正确值覆盖，保持原样。

- [ ] **Step 2: 类型检查**

```bash
pnpm typecheck:main
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/app-main/src/stores/profile.ts
git commit -m "feat(main): platform-aware default profile paths"
```

---

### Task 7: 全量校验与打包

**Files:** 无新改动（验证任务）

- [ ] **Step 1: 全量类型检查 + lint**

```bash
pnpm typecheck && pnpm lint
```

Expected: 均通过（renderer 有既有告警可忽略，不引入新错误）

- [ ] **Step 2: 单测**

```bash
pnpm -F @scnexus/app-main exec vitest run
```

Expected: 全部 PASS

- [ ] **Step 3: 构建 dmg（本地可用性验证，不签名）**

```bash
pnpm build:app:prepare && pnpm build:app
```

Expected: `packages/app-main/release/<version>/` 下产出 `mac` 目录（内含 `SCNexus.app`，--dir 模式不打包 dmg）；如需 dmg 用 `pnpm -F @scnexus/app-main run build:app:release`。首次运行未签名 app 需右键 → 打开。

- [ ] **Step 4: Commit（如有 lockfile/版本同步改动）**

```bash
git status --short
# 若有产物外改动（如 package version 同步）:
git add -A && git commit -m "chore: sync app version for mac build"
```

---

### Task 8: 真机验证（装有 SC2 的 Mac）

**Files:** 无代码改动；问题回修走修复 commit

- [ ] **Step 1: dev 模式启动**

```bash
pnpm dev
```

Expected: 应用窗口打开；控制台无 `UNSUPPORTED_PLATFORM`；profile store 中 `GAME_ROOT` 自动识别为 `/Applications/StarCraft II`，`SUCCESS=true`（可在应用设置页 Profile 中确认路径）

- [ ] **Step 2: 游戏根目录识别失败场景**

临时将 store 中 GAME_ROOT 清空（或在设置页改为无效路径）确认回退提示 `GAME_ROOT_NOT_FOUND`，再改回有效路径恢复。

- [ ] **Step 3: 启动游戏**

在应用内触发启动游戏，Expected: SC2 经 `Support/SC2Switcher.app` 正常拉起。
若直接 exec 内层二进制失败，回退方案：darwin 分支改用 `open -a "<gameClient 所在 .app>"` 方式启动（在 platform.ts 增加启动适配，不改 launcher）。

- [ ] **Step 4: 战役/模组安装落盘**

安装任一战役/模组，Expected: 文件落入 `/Applications/StarCraft II/maps/`（注意小写）与 `/Applications/StarCraft II/Mods/`，应用内列表正常刷新。

- [ ] **Step 5: 最终提交与收尾**

```bash
git log --oneline main..HEAD  # 确认本分支提交序列完整
```

如需合并回 main 或发 PR，由用户决定。
