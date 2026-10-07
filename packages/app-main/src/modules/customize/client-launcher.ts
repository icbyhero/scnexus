import { profileStore } from "@/stores/profile";
import { GameExecutableParameters } from "@scnexus/app-shared/types/customize/client-launcher.type";

import { launchApplication } from "@/modules/profile/platform";

export function runGameClient() {
  const gameClient = profileStore.get("PROFILE_GAME").GAME_CLIENT;
  if (!gameClient) return;
  // SSO 启动参数仅 Windows 主程序支持；darwin 经 open 启动 .app 时不传
  const args =
    process.platform === "win32"
      ? ["-sso=1", "-launch", "-uid", "s2"]
      : [];
  launchApplication(gameClient, args).catch((error) =>
    console.error("runGameClient failed:", error)
  );
}

export function runGameExecutable(parameters?: GameExecutableParameters) {
  const gameExecutable = profileStore.get("PROFILE_GAME").GAME_EXECUTABLE_X64;
  if (!gameExecutable) return;

  const args: string[] = [];
  if (parameters?.run) {
    args.push("-run", parameters.run);
    if (parameters.testmod) args.push("-testmod", parameters.testmod);
    if (parameters.displaymode !== undefined)
      args.push("-displaymode", String(parameters.displaymode));
    if (parameters.trigdebug) args.push("-trigdebug");
    if (parameters.preload !== undefined)
      args.push("-preload", String(parameters.preload));
    if (parameters.NoUserCheats) args.push("-NoUserCheats");
    if (parameters.reloadcheck) args.push("-reloadcheck");
    if (parameters.meleeMod) args.push("-meleeMod", parameters.meleeMod);
    if (parameters.difficulty !== undefined)
      args.push("-difficulty", String(parameters.difficulty));
    if (parameters.speed !== undefined)
      args.push("-speed", String(parameters.speed));
  }

  launchApplication(gameExecutable, args).catch((error) =>
    console.error("runGameExecutable failed:", error)
  );
}

export function runEditorExecutable(file_path?: string) {
  const editorExecutable =
    profileStore.get("PROFILE_GAME").GAME_EDITOR_EXECUTABLE_X64;
  if (!editorExecutable) return;
  launchApplication(editorExecutable, file_path ? [file_path] : []).catch(
    (error) => console.error("runEditorExecutable failed:", error)
  );
}
