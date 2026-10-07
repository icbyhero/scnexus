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
