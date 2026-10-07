import { join, basename } from "node:path";
import { statSync } from "node:fs";
import { cp, mkdir, readdir, rename, writeFile } from "node:fs/promises";

import { ResultUncompressCCM } from "@scnexus/app-shared/types/campaign.type";
import {
  readCompressFileInfo,
  readCompressFileInfo7z,
} from "../customize/compress-process";
import { Logger } from "@/utils/logger";
import { METHOD_CCM_ONLY } from "@scnexus/app-shared/errors/campaign.error";
import {
  INVALID_COMPRESSED_FILE,
  METADATA_NOT_FOUND,
  UNCOMPRESSING_ERROR,
} from "@scnexus/app-shared/errors/customize.error";
import { rmIfExist } from "@/utils/fs-util";
import { zip } from "compressing";
import { profileStore } from "@/stores/profile";
import { szExtractFullPromisify } from "@/utils/7zip-util";

export async function unzipCompressFileCCM(
  cf_path: string
): Promise<ResultUncompressCCM> {
  const cfi = readCompressFileInfo(cf_path);

  if (!cfi) {
    Logger.warn(`[CAMPAIGN] ${INVALID_COMPRESSED_FILE}: cf_path = ${cf_path}`);
    throw new Error(INVALID_COMPRESSED_FILE);
  }

  const { ccm, compress_info } = cfi;
  if (!ccm?.metadata) {
    Logger.warn(`[CAMPAIGN] ${METADATA_NOT_FOUND}: cf_path = ${cf_path}`);
    throw new Error(METADATA_NOT_FOUND);
  }
  if (ccm?.metadata.manager !== "CCM") {
    Logger.warn(`[CAMPAIGN] ${METHOD_CCM_ONLY}: cf_path = ${cf_path}`);
    throw new Error(METHOD_CCM_ONLY);
  }

  const storePath: string = profileStore.get("PROFILE_CAMPAIGN").CCM_ROOT;
  const tempPath = join(storePath, "~scnexus_ccm_uncompress_temp_dir");
  const targetPath = join(
    storePath,
    ccm?.metadata.name.replace(/[\~\!\@\#\$\%\^\&\*\"\|\:\<\>\/\\\\]/g, "")
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
    ccm: ccm,
    cf_path: cf_path,
    cf_info: cfi,
  };
}

export async function unzipCompressFileSimulateCCM(
  cf_path: string
): Promise<ResultUncompressCCM> {
  const cfi = readCompressFileInfo(cf_path);

  if (!cfi) {
    Logger.warn(`[CAMPAIGN] ${INVALID_COMPRESSED_FILE}: cf_path = ${cf_path}`);
    throw new Error(INVALID_COMPRESSED_FILE);
  }

  const { ccm, compress_info } = cfi;
  if (!ccm?.metadata) {
    Logger.warn(`[CAMPAIGN] ${METADATA_NOT_FOUND}: cf_path = ${cf_path}`);
    throw new Error(METADATA_NOT_FOUND);
  }

  if (ccm?.metadata.manager !== "CCM") {
    Logger.warn(`[CAMPAIGN] ${METHOD_CCM_ONLY}: cf_path = ${cf_path}`);
    throw new Error(METHOD_CCM_ONLY);
  }

  const targetPath = join(
    profileStore.get("PROFILE_CAMPAIGN").CCM_ROOT,
    basename(cf_path, ".zip")
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

  // 记录包内模组，供后续清理逻辑使用。
  await mkdir(join(targetPath, ".scnexus"), { recursive: true });
  await writeFile(
    join(targetPath, ".scnexus", "manifest.json"),
    JSON.stringify({ mods: packagedMods })
  );

  return {
    ccm: ccm,
    cf_path: cf_path,
    cf_info: cfi,
  };
}

export async function unzipCompressFile7zSimulateCCM(
  cf_path: string
): Promise<ResultUncompressCCM> {
  const cfi = await readCompressFileInfo7z(cf_path);

  if (!cfi) {
    Logger.warn(`[CAMPAIGN] ${INVALID_COMPRESSED_FILE}: cf_path = ${cf_path}`);
    throw new Error(INVALID_COMPRESSED_FILE);
  }

  const { ccm, compress_info } = cfi;
  if (!ccm?.metadata) {
    Logger.warn(`[CAMPAIGN] ${METADATA_NOT_FOUND}: cf_path = ${cf_path}`);
    throw new Error(METADATA_NOT_FOUND);
  }

  if (ccm?.metadata.manager !== "CCM") {
    Logger.warn(`[CAMPAIGN] ${METHOD_CCM_ONLY}: cf_path = ${cf_path}`);
    throw new Error(METHOD_CCM_ONLY);
  }

  const sourceIsDir = statSync(cf_path).isDirectory();
  const packageName = sourceIsDir
    ? basename(cf_path)
    : basename(cf_path).replace(/\.(zip|rar|7z)$/i, "");

  const targetPath = join(
    profileStore.get("PROFILE_CAMPAIGN").CCM_ROOT,
    packageName
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

  // 记录包内模组，供后续清理逻辑使用。
  await mkdir(join(targetPath, ".scnexus"), { recursive: true });
  await writeFile(
    join(targetPath, ".scnexus", "manifest.json"),
    JSON.stringify({ mods: packagedMods })
  );

  return {
    ccm: ccm,
    cf_path: cf_path,
    cf_info: cfi,
  };
}
