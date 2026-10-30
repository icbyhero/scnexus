import { join, basename } from "node:path";
import { statSync } from "node:fs";
import { cp, mkdir, readdir, rename, writeFile } from "node:fs/promises";

import { CampaignType } from "scnexus-standard/metadata";
import { ResultUncompressCCM } from "@scnexus/app-shared/types/campaign.type";
import { CompressFileInfo } from "@scnexus/app-shared/types/customize.type";
import {
  readCompressFileInfo,
  readCompressFileInfo7z,
} from "../customize/compress-process";
import {
  sanitizePackageName,
  stripArchiveExtension,
  synthesizePlainMetadata,
} from "../customize/customize-util";
import { Logger } from "@/utils/logger";
import { detectArchiveFormat } from "@/utils/archive-magic";
import {
  INVALID_COMPRESSED_FILE,
  UNCOMPRESSING_ERROR,
} from "@scnexus/app-shared/errors/customize.error";
import { rmIfExist } from "@/utils/fs-util";
import { zip } from "compressing";
import { profileStore } from "@/stores/profile";
import { szExtractFullPromisify } from "@/utils/7zip-util";

/**
 * 扫描包内 .SC2Mod 并写入 manifest，供后续清理逻辑使用。
 */
async function writePackagedManifest(targetPath: string): Promise<void> {
  const files = await readdir(targetPath, {
    encoding: "utf-8",
    recursive: true,
  });

  const packagedMods: string[] = [];

  for (const file of files) {
    if (file.endsWith(".SC2Mod") || file.endsWith(".sc2mod")) {
      // 模组保留在包内，不再移动到游戏根 Mods；
      // 每次激活时从此处强制覆盖复制，保证同名不同内容的模组与激活的战役一致。
      packagedMods.push(basename(file));
    }
  }

  await mkdir(join(targetPath, ".scnexus"), { recursive: true });
  await writeFile(
    join(targetPath, ".scnexus", "manifest.json"),
    JSON.stringify({ mods: packagedMods })
  );
}

/**
 * Plain 包（无元数据）降级安装：
 * 按压缩包文件名建目录解压，合成 metadata.txt 写入包内容根，
 * 使其可被战役列表、激活与卸载流程正常识别。
 *
 * 战役归属优先级：用户指定 > 包内路径推断 > 默认 WOL（保证包在列表中可见）。
 */
async function installPlainCampaign(
  cf_path: string,
  cfi: CompressFileInfo,
  campaign?: CampaignType
): Promise<ResultUncompressCCM> {
  const sourceIsDir = statSync(cf_path).isDirectory();
  const dirName = sourceIsDir
    ? basename(cf_path)
    : stripArchiveExtension(basename(cf_path));

  const targetPath = join(
    profileStore.get("PROFILE_CAMPAIGN").CCM_ROOT,
    sanitizePackageName(dirName) || "Campaign"
  );

  await rmIfExist(targetPath);

  if (sourceIsDir) {
    // 源是已解压目录：直接递归拷贝，不执行解压
    await cp(cf_path, targetPath, { recursive: true }).catch((err) => {
      Logger.error(
        `[CAMPAIGN] ${UNCOMPRESSING_ERROR}: error = ${err}, cf_path = ${cf_path}, targetPath = ${targetPath}`
      );
      throw new Error(UNCOMPRESSING_ERROR);
    });
  } else {
    await szExtractFullPromisify(cf_path, targetPath).catch((err) => {
      Logger.error(
        `[CAMPAIGN] ${UNCOMPRESSING_ERROR}: error = ${err}, cf_path = ${cf_path}, targetPath = ${targetPath}`
      );
      throw new Error(UNCOMPRESSING_ERROR);
    });
  }

  // 内容根：解压结果只有单个顶层目录时，元数据写入该目录内，
  // 与 CCM 包保持一致（列表搜索/激活/卸载都以 metadata 所在目录为内容根）。
  let contentRoot = targetPath;
  const topEntries = await readdir(targetPath, { withFileTypes: true });
  if (topEntries.length === 1 && topEntries[0].isDirectory()) {
    contentRoot = join(targetPath, topEntries[0].name);
  }

  // 战役归属：用户指定 > 包内路径推断 > 默认 WOL（保证包在列表中可见）。
  const inferred = (cfi.ccm?.metadata?.campaign ?? "") as CampaignType | "";
  const plainMetadata = {
    ...(cfi.ccm?.metadata ?? synthesizePlainMetadata(dirName, "")),
    campaign: (campaign ?? (inferred || "WOL")) as CampaignType,
  };

  // 写出一份 CCM 元数据，包才能被战役列表搜索到（否则安装后不可见）。
  await writeFile(
    join(contentRoot, "metadata.txt"),
    [
      `title=${plainMetadata.name ?? dirName}`,
      `desc=${plainMetadata.description ?? ""}`,
      `author=${plainMetadata.author ?? ""}`,
      `campaign=${plainMetadata.campaign}`,
      `version=${plainMetadata.version ?? ""}`,
    ].join("\n"),
    "utf8"
  );

  await writePackagedManifest(targetPath);

  return {
    ccm: {
      metadata: plainMetadata,
      plain: true,
    },
    cf_path: cf_path,
    cf_info: cfi,
  };
}

/**
 * Plain 包统一降级入口：无元数据或 manager 不是 CCM 时返回 true。
 */
function isPlainOrNonCcm(ccm: CompressFileInfo["ccm"]): boolean {
  return ccm?.plain === true || ccm?.metadata?.manager !== "CCM";
}

export async function unzipCompressFileCCM(
  cf_path: string
): Promise<ResultUncompressCCM> {
  // 魔数不是 zip 时（改名的 7z/rar 等）转交通用流程，不再依赖扩展名。
  if (detectArchiveFormat(cf_path) !== "zip") {
    return unzipCompressFile7zSimulateCCM(cf_path);
  }

  const cfi = readCompressFileInfo(cf_path);

  if (!cfi) {
    Logger.warn(`[CAMPAIGN] ${INVALID_COMPRESSED_FILE}: cf_path = ${cf_path}`);
    throw new Error(INVALID_COMPRESSED_FILE);
  }

  const { ccm, compress_info } = cfi;
  // 降级：无元数据或 manager 不是 CCM 的包按 Plain 流程安装，
  // 不再抛 METADATA_NOT_FOUND / METHOD_CCM_ONLY 硬性拒绝。
  if (isPlainOrNonCcm(ccm)) {
    Logger.warn(
      `[CAMPAIGN] no CCM metadata found, degrade to plain install: cf_path = ${cf_path}`
    );
    return unzipCompressFile7zSimulateCCM(cf_path);
  }

  const storePath: string = profileStore.get("PROFILE_CAMPAIGN").CCM_ROOT;
  const tempPath = join(storePath, "~scnexus_ccm_uncompress_temp_dir");
  // 元数据可能缺 title：目录名退回压缩包名，避免拼出 CCM_ROOT 本身
  const targetPath = join(
    storePath,
    sanitizePackageName(ccm!.metadata!.name) ||
      stripArchiveExtension(basename(cf_path)) ||
      "Campaign"
  );

  await rmIfExist(targetPath);

  if (!ccm?.metadata_root) {
    await zip
      .uncompress(cf_path, targetPath, {
        zipFileNameEncoding: compress_info.fn_encoding ?? "utf8",
      })
      .catch((err) => {
        Logger.error(
          `[CAMPAIGN] ${UNCOMPRESSING_ERROR}: error = ${err}, cf_path = ${cf_path}, targetPath = ${targetPath}`
        );
        throw new Error(UNCOMPRESSING_ERROR);
      });
  } else {
    await rmIfExist(tempPath);
    await zip
      .uncompress(cf_path, tempPath, {
        zipFileNameEncoding: compress_info.fn_encoding ?? "utf8",
      })
      .catch((err) => {
        Logger.error(
          `[CAMPAIGN] ${UNCOMPRESSING_ERROR}: error = ${err}, cf_path = ${cf_path}, targetPath = ${targetPath}`
        );
        throw new Error(UNCOMPRESSING_ERROR);
      });

    await rename(join(tempPath, ccm.metadata_root, ".."), storePath);
    await rmIfExist(tempPath);
  }

  return {
    ccm: ccm!,
    cf_path: cf_path,
    cf_info: cfi,
  };
}

export async function unzipCompressFileSimulateCCM(
  cf_path: string
): Promise<ResultUncompressCCM> {
  // 魔数不是 zip 时（改名的 7z/rar 等）转交通用流程。
  if (detectArchiveFormat(cf_path) !== "zip") {
    return unzipCompressFile7zSimulateCCM(cf_path);
  }

  const cfi = readCompressFileInfo(cf_path);

  if (!cfi) {
    Logger.warn(`[CAMPAIGN] ${INVALID_COMPRESSED_FILE}: cf_path = ${cf_path}`);
    throw new Error(INVALID_COMPRESSED_FILE);
  }

  const { ccm, compress_info } = cfi;
  // 降级：无元数据或 manager 不是 CCM 的包按 Plain 流程安装。
  if (isPlainOrNonCcm(ccm)) {
    Logger.warn(
      `[CAMPAIGN] no CCM metadata found, degrade to plain install: cf_path = ${cf_path}`
    );
    return unzipCompressFile7zSimulateCCM(cf_path);
  }

  const targetPath = join(
    profileStore.get("PROFILE_CAMPAIGN").CCM_ROOT,
    sanitizePackageName(stripArchiveExtension(basename(cf_path))) || "Campaign"
  );

  await rmIfExist(targetPath);

  await zip
    .uncompress(cf_path, targetPath, {
      zipFileNameEncoding: compress_info.fn_encoding ?? "utf8",
    })
    .catch((err) => {
      Logger.error(
        `[CAMPAIGN] ${UNCOMPRESSING_ERROR}: error = ${err}, cf_path = ${cf_path}, targetPath = ${targetPath}`
      );
      throw new Error(UNCOMPRESSING_ERROR);
    });

  await writePackagedManifest(targetPath);

  return {
    ccm: ccm!,
    cf_path: cf_path,
    cf_info: cfi,
  };
}

export async function unzipCompressFile7zSimulateCCM(
  cf_path: string,
  campaign?: CampaignType
): Promise<ResultUncompressCCM> {
  const cfi = await readCompressFileInfo7z(cf_path);

  if (!cfi) {
    Logger.warn(`[CAMPAIGN] ${INVALID_COMPRESSED_FILE}: cf_path = ${cf_path}`);
    throw new Error(INVALID_COMPRESSED_FILE);
  }

  const { ccm } = cfi;
  // 降级：无元数据或 manager 不是 CCM 的包按 Plain 流程安装，
  // 归属战役由用户通过 campaign 参数指定。
  if (isPlainOrNonCcm(ccm)) {
    Logger.warn(
      `[CAMPAIGN] no CCM metadata found, degrade to plain install: cf_path = ${cf_path}`
    );
    return installPlainCampaign(cf_path, cfi, campaign);
  }

  const sourceIsDir = statSync(cf_path).isDirectory();
  const packageName = sourceIsDir
    ? basename(cf_path)
    : stripArchiveExtension(basename(cf_path));

  const targetPath = join(
    profileStore.get("PROFILE_CAMPAIGN").CCM_ROOT,
    sanitizePackageName(packageName) || "Campaign"
  );

  await rmIfExist(targetPath);

  if (sourceIsDir) {
    // 源是已解压目录：直接递归拷贝，不执行解压
    await cp(cf_path, targetPath, { recursive: true }).catch((err) => {
      Logger.error(
        `[CAMPAIGN] ${UNCOMPRESSING_ERROR}: error = ${err}, cf_path = ${cf_path}, targetPath = ${targetPath}`
      );
      throw new Error(UNCOMPRESSING_ERROR);
    });
  } else {
    await szExtractFullPromisify(cf_path, targetPath).catch((err) => {
      Logger.error(
        `[CAMPAIGN] ${UNCOMPRESSING_ERROR}: error = ${err}, cf_path = ${cf_path}, targetPath = ${targetPath}`
      );
      throw new Error(UNCOMPRESSING_ERROR);
    });
  }

  await writePackagedManifest(targetPath);

  return {
    ccm: ccm!,
    cf_path: cf_path,
    cf_info: cfi,
  };
}
