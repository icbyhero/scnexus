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

export const profileStore = new Store<ProfileStore>({
  name: "store-profile",
  cwd: join(appDataRoot, "SCNexusStorage"),
  fileExtension: "json",
  defaults: defaultProfile,
});

export const profileStoreFunction = {
  get: (key: keyof ProfileStore) => profileStore.get(key),
  set: (key: keyof ProfileStore, value: ProfileStore[keyof ProfileStore]) => {
    profileStore.set(key, value);
  },
};
