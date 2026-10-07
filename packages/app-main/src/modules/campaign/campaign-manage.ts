import { join, relative, sep } from "node:path";
import { readFile, readdir } from "node:fs/promises";

import { getCampaignStore, updateCampaignStore } from "@/stores/campaign";
import {
  getCampaignActiveStoreKey,
  removeStoreActiveCampaign,
} from "@/stores/campaign-active";
import {
  CampaignType,
  MetadataInformated,
  MetadataInformatedCampaignListSet,
  MetadataInformatedList,
} from "scnexus-standard/metadata";

import {
  ccmMetaFileParser,
  rmDirWhitely,
  scnexusMetaFileParser,
} from "../customize/customize-util";
import { countPathCompatible } from "@/utils/fs-util";
import { profileStore } from "@/stores/profile";
import {
  cleanCampaignFiles,
  cleanCampaignFilesCCM,
} from "./campaign-util";

async function CampaignListTypeSearcher(campaignType: CampaignType) {
  const campaignList: MetadataInformatedList = [];

  const campaignLibraryRoot = profileStore.get("PROFILE_CAMPAIGN").LIBRARY_ROOT;

  const dirs = await readdir(campaignLibraryRoot, {
    encoding: "utf-8",
    withFileTypes: true,
  });
  for (const dir of dirs) {
    if (!dir.isDirectory()) return;

    const pathMetadata = join(campaignLibraryRoot, dir.name, "metadata.json");
    const metadata = await scnexusMetaFileParser(pathMetadata);
    if (
      !metadata ||
      metadata.type !== "Campaign" ||
      metadata.campaign !== campaignType
    ) {
      continue;
    }

    const { files_size, files_count } = await countPathCompatible(
      join(campaignLibraryRoot, dir.name)
    );

    const infor: MetadataInformated = {
      ...metadata,
      localinfo: {
        metadata_path: pathMetadata,
        files_count: files_count,
        files_size: files_size,
      },
    };
    campaignList.push(infor);
  }

  return campaignList;
}

async function CampaignListTypeSearcherCCM(
  campaignType: CampaignType
): Promise<MetadataInformatedList> {
  const ccmCampaignList: MetadataInformatedList = [];

  const ccmCampaignLibraryRoot = profileStore.get("PROFILE_CAMPAIGN").CCM_ROOT;

  const SearcherCCM = async (
    path: string
  ): Promise<MetadataInformated | undefined> => {
    const files = await readdir(path, {
      encoding: "utf-8",
      withFileTypes: true,
    });
    const metadataFile = files.find((file) => file.name === "metadata.txt");
    if (metadataFile) {
      const metadataFC = await ccmMetaFileParser(join(path, metadataFile.name));
      if (
        metadataFC &&
        metadataFC.type === "Campaign" &&
        metadataFC.campaign === campaignType
      ) {
        const { files_size, files_count } = await countPathCompatible(path);
        const infor: MetadataInformated = {
          ...metadataFC,
          localinfo: {
            metadata_path: join(path, metadataFile.name),
            files_count: files_count,
            files_size: files_size,
          },
        };
        return infor;
      }
      // 找到了 metadata 但战役类型不匹配：该包归属其他战役类型，
      // 子目录是 SC2 组件，不会再包含 metadata，直接结束此分支。
      return undefined;
    }

    // 当前目录没有 metadata：依次搜索所有子目录，而不是只看第一个。
    for (const mayDir of files) {
      if (mayDir.isDirectory()) {
        const infor = await SearcherCCM(join(path, mayDir.name));
        if (infor) return infor;
      }
    }

    return undefined;
  };

  const dirs = await readdir(ccmCampaignLibraryRoot, {
    encoding: "utf-8",
    withFileTypes: true,
  });

  for (const dir of dirs) {
    if (dir.isDirectory()) {
      const infor = await SearcherCCM(join(ccmCampaignLibraryRoot, dir.name));
      if (infor) {
        ccmCampaignList.push(infor);
      }
    }
  }

  return ccmCampaignList;
}

export async function updateCampaignLists() {
  const campaignLists: MetadataInformatedCampaignListSet = {
    WOL: [],
    HOTS: [],
    LOTV: [],
    NCO: [],
  };

  const campigns = ["WOL", "HOTS", "LOTV", "NCO"] as CampaignType[];
  for (const campaign of campigns) {
    const campaignList = await CampaignListTypeSearcher(campaign);
    if (campaignList) {
      campaignLists[campaign].push(...campaignList);
    }

    const campaignListCCM = await CampaignListTypeSearcherCCM(campaign);
    if (campaignListCCM) {
      campaignLists[campaign].push(...campaignListCCM);
    }
  }

  const campainStoreData = updateCampaignStore(campaignLists);
  return campainStoreData;
}

export function getCampaignLists() {
  return getCampaignStore();
}

function isSameCampaign(
  a: MetadataInformated,
  b: MetadataInformated
): boolean {
  return a.manager === b.manager && a.name === b.name && a.version === b.version;
}

/**
 * 删除安装时被移入游戏根 Mods 目录的模组；
 * 若同名模组仍被其他已安装包引用，则保留（引用计数），
 * 避免两个模组共享依赖时卸载其一会破坏另一个。
 */
async function removeMovedModsWithRefCount(pkgRoot: string) {
  let manifest: { mods?: string[] };
  try {
    manifest = JSON.parse(
      await readFile(join(pkgRoot, ".scnexus", "manifest.json"), "utf8")
    );
  } catch {
    return; // 旧版本安装的包没有清单，无法追溯
  }

  const mods = manifest.mods ?? [];
  if (mods.length === 0) return;

  const ccmRoot = profileStore.get("PROFILE_CAMPAIGN").CCM_ROOT;
  const referenced = new Set<string>();

  for (const dirent of await readdir(ccmRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const otherPkg = join(ccmRoot, dirent.name);
    if (otherPkg === pkgRoot) continue;
    try {
      const other: { mods?: string[] } = JSON.parse(
        await readFile(join(otherPkg, ".scnexus", "manifest.json"), "utf8")
      );
      for (const m of other.mods ?? []) referenced.add(m);
    } catch {
      // 其他包无清单，无法判断引用，不做保守保留之外的处理
    }
  }

  const modsRoot = profileStore.get("PROFILE_CAMPAIGN").MODS_ROOT;
  for (const mod of mods) {
    if (referenced.has(mod)) continue;
    await rmDirWhitely(join(modsRoot, mod));
  }
}

export async function uninstallCampiagnFiles(
  infor: MetadataInformated
): Promise<void> {
  const metadataPath = infor.localinfo?.metadata_path;
  if (!metadataPath) return;

  // 计算包根目录：SCNexus 的 metadata.json 位于包根；
  // CCM 的 metadata.txt 可能嵌套在子目录，取相对 CCM_ROOT 的第一段。
  let pkgRoot: string;
  if (infor.manager === "CCM") {
    const ccmRoot = profileStore.get("PROFILE_CAMPAIGN").CCM_ROOT;
    const first = relative(ccmRoot, metadataPath).split(sep)[0];
    if (!first || first === "..") return;
    pkgRoot = join(ccmRoot, first);
  } else {
    pkgRoot = join(metadataPath, "..");
  }

  // 该战役当前处于激活状态：先清理激活时复制到游戏目录的文件
  if (infor.campaign) {
    const active = getCampaignActiveStoreKey("CAMPAIGN_SET")[infor.campaign];
    if (active && isSameCampaign(active, infor)) {
      if (infor.manager === "SCNexus") {
        await cleanCampaignFiles(infor);
      } else {
        await cleanCampaignFilesCCM(infor);
      }
      removeStoreActiveCampaign(infor);
    }
  }

  // 清理移入游戏根 Mods 的模组（共享依赖自动保留）
  await removeMovedModsWithRefCount(pkgRoot);

  // 删除整个包目录，而不仅仅是 metadata 所在的那一层
  await rmDirWhitely(pkgRoot);
}
