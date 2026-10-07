# SCNexus macOS 适配设计

- 日期：2026-10-07
- 状态：已批准
- 分支：`feat/macos-support`
- 方案：A —— 平台路径抽象层（最小侵入）

## 1. 目标与非目标

**目标**（本地可用级）：在本机 Mac 上 `pnpm dev` 可运行、可打出 dmg；核心功能可用：自动探测游戏路径、安装/管理战役与模组、启动游戏。

**非目标**：mac 自动更新（zip target）、签名/公证、CI 发布、Linux 支持、UI/渲染层改动。

## 2. 背景与平台事实

现状：应用仅支持 Windows。障碍集中在主进程：

| 项目 | Windows（现有代码） | macOS（本机实测） |
|---|---|---|
| 游戏根目录探测 | 注册表 `HKLM\SOFTWARE\WOW6432Node\...\Uninstall\StarCraft II` 的 `InstallLocation` | `/Applications/StarCraft II`（Battle.net 固定） |
| 根目录有效性校验 | 存在 `StarCraft II.exe` | 存在 `StarCraft II.app` |
| 主程序 | `StarCraft II.exe` | `StarCraft II.app/Contents/MacOS/StarCraft II` |
| Switcher | `Support64/SC2Switcher_x64.exe` | `Support/SC2Switcher.app/Contents/MacOS/SC2Switcher` |
| 编辑器 | `Support64/SC2Editor_x64.exe` | `StarCraft II Editor.app/Contents/MacOS/StarCraft II Editor`（实测存在） |
| 地图目录 | `Maps` | `maps`（小写） |
| 模组目录 | `Mods` | `Mods` |
| Banks 存档 | `~/Documents/StarCraft II/Banks` | `~/Library/Application Support/Blizzard/StarCraft II/Accounts/<id>/<uid>/Banks` |

其他已确认事实：渲染层无平台相关代码；7z 用 `node-7z` + `7z-bin`（跨平台）；深度链接 `open-url` 已有 darwin 处理；electron-builder.json 已有 mac 段（dmg + png 图标自动转 icns）。

## 3. 架构

新文件 `packages/app-main/src/modules/profile/platform.ts`，平台差异的唯一集中点：

```ts
detectGameRoot(): Promise<string>            // win: 注册表；mac: 依次校验候选路径 ["/Applications/StarCraft II"]
isGameRootValid(gameRoot): Promise<boolean>  // win: StarCraft II.exe；mac: StarCraft II.app
getGameExecutables(gameRoot)                 // GAME_CLIENT / GAME_EXECUTABLE / GAME_EDITOR 平台映射
getGameDirectoryPaths(gameRoot)              // Maps/Mods/Campaign/CCM 等目录映射
getDocumentsPaths()                          // Banks 等用户数据目录
```

### 修改的现有文件（Windows 行为零变化）

1. `packages/app-main/src/modules/profile/profile-store.ts` —— darwin 分支调用 `detectGameRoot()`；各 `PROFILE_*` 路径改由 platform 模块按平台生成。
2. `packages/app-main/src/modules/profile/profile-util.ts` —— `checkGameRootValid` 按平台校验。
3. `packages/app-main/src/modules/customize/client-launcher.ts` —— 可执行文件来源走平台映射；现有引号包裹逻辑保留。
4. `packages/app-main/src/utils/reg.ts` —— regedit 改为仅 win32 动态加载。
5. `packages/app-main/src/stores/profile.ts` —— DOCUMENTS 默认值按平台。

### 打包

electron-builder.json mac 段（dmg target、png 图标）已就绪，不改。regedit vbs 的 extraResources 仅 Windows 需要，mac 打包带上无害，不改。

## 4. 数据流（mac 首次启动）

```
app ready → initProfileStore()
  ├─ 有 gamePath 参数（用户手动选过）→ 直接校验使用
  ├─ profile 已有 GAME_ROOT → 复检
  └─ 自动探测：darwin → isGameRootValid("/Applications/StarCraft II")
       ├─ 有效 → 填充 PROFILE_GAME / DOCUMENTS / CAMPAIGN / CUSTOMIZE / 白名单 → SUCCESS=true
       └─ 无效 → SUCCESS=false, ERROR_MESSAGE="GAME_ROOT_NOT_FOUND"
                  → 现有设置页手动选目录（复用现有 UI 流程，不加新 UI）
```

## 5. 错误处理

- 沿用现有错误码（`GAME_ROOT_NOT_FOUND` / `GAME_ROOT_INVALID`）；darwin 不再返回 `UNSUPPORTED_PLATFORM`。
- regedit 仅在 win32 分支被调用，mac 上不加载、不触发。
- 启动类函数保持"路径为空则 no-op"的现有防御逻辑，mac 路径缺失时自然降级。

## 6. 测试与验证

1. `pnpm typecheck` + `pnpm lint`。
2. 单测：`platform.ts` 路径映射、`isGameRootValid` 平台分支（vitest，`pnpm test:main`）。
3. 真机验证（装有 SC2 的 Mac）：`pnpm dev` 启动 → 自动识别 `/Applications/StarCraft II` → 应用内启动游戏（SC2Switcher）→ 安装战役/模组 → 校验文件落入 `maps/`、`Mods/`。

## 7. 风险与兜底

- `maps` 小写：平台常量显式区分；默认 APFS 大小写不敏感兜底。
- Banks 路径 per-account：DOCUMENTS 默认指向 `~/Library/Application Support/Blizzard/StarCraft II`，用户可在设置页微调（现有能力）。
- 应用构建本机 arch（electron-builder 默认行为），SC2 mac 客户端启动与之无关。
