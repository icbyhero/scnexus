import { join, dirname, basename } from "node:path";
import {
  existsSync,
  renameSync,
  rmSync,
  mkdirSync,
  statSync,
} from "node:fs";
import {
  access,
  cp,
  mkdir,
  readdir,
  readFile,
  stat,
} from "node:fs/promises";

import { Logger } from "@/utils/logger";

import { getZip, AdmZip, IZipEntry } from "@/utils/admzip";

import { zip } from "compressing";
import { analyse } from "chardet";

import { MetadataStandard } from "scnexus-standard/metadata";
import {
  assertArchiveSizeSafe,
  assertEntryPathSafe,
  buildEntryInfoFromEntries,
  ccmMetadataParser,
  decodeTextBuffer,
  generateZipEntryTree,
  generateZipEntryInfo7z,
  inferCampaignFromPaths,
  sanitizePackageName,
  scnexusMetadataParser,
  stripArchiveExtension,
  synthesizePlainMetadata,
  type EntryLike,
} from "./customize-util";

import { detectArchiveFormat } from "@/utils/archive-magic";

import { profileStore } from "@/stores/profile";
import { szList } from "@/utils/7zip";
import {
  szExtractFullPromisify,
  szListFull,
  szReadFile,
} from "@/utils/7zip-util";

import {
  CompressFileInfo,
  ResultUncompress,
  ResultUnzipFile,
} from "@scnexus/app-shared/types/customize.type";
import {
  INVALID_COMPRESSED_FILE,
  METADATA_NOT_FOUND,
  METHOD_SCNEXUS_ONLY,
  METHOD_TYPE_UNSUPPORTED,
  UNCOMPRESSING_ERROR,
} from "@scnexus/app-shared/errors/customize.error";

export function readCompressFileInfo(cf_path: string): CompressFileInfo | null {
  // 魔数判断：此路径仅接受 zip；7z/rar 等交给 readCompressFileInfo7z，
  // 改名或无扩展名的压缩包不再依赖扩展名分派。
  if (detectArchiveFormat(cf_path) !== "zip") {
    Logger.warn(
      `[CUSTOMIZE] archive is not zip by magic bytes: cf_path = ${cf_path}`
    );
    return null;
  }

  let zip: AdmZip;
  try {
    zip = getZip(cf_path);
  } catch (err) {
    Logger.error(err);
    return null;
  }

  let metadataEntry: IZipEntry | undefined;

  let metadata: MetadataStandard | undefined;

  let ccmMetadata: MetadataStandard | undefined;
  let ccmMetadataRoot: string | undefined;

  metadataEntry = zip
    .getEntries()
    .find((entry) => entry.entryName === "metadata.json");
  if (metadataEntry) {
    const data = decodeTextBuffer(metadataEntry.getData());
    metadata = scnexusMetadataParser(data);
  }

  metadataEntry = zip
    .getEntries()
    .find((entry) => entry.name === "metadata.json");
  if (metadataEntry) {
    const data = decodeTextBuffer(metadataEntry.getData());
    ccmMetadata = scnexusMetadataParser(data);
    ccmMetadataRoot = metadataEntry.entryName.split(metadataEntry.name)[0];
  }

  metadataEntry = zip
    .getEntries()
    .find((entry) => entry.name === "metadata.txt");
  if (metadataEntry) {
    const data = decodeTextBuffer(metadataEntry.getData());
    ccmMetadata = ccmMetadataParser(data);
    ccmMetadataRoot = metadataEntry.entryName.split(metadataEntry.name)[0];
  }

  let size: number = 0;
  let compressedSize: number = 0;
  let fn_encoding: string = "utf8";

  // 安全闸门：逐条校验条目路径（zip-slip），累计解压后体积。
  const entryNames: string[] = [];
  for (const entry of zip.getEntries()) {
    assertEntryPathSafe(entry.entryName);
    entryNames.push(entry.entryName);
    size += entry.header.size;
    compressedSize += entry.header.compressedSize;

    if (fn_encoding === "utf8") {
      const encoding = analyse(entry.rawEntryName);
      if (
        encoding.some((result) => {
          return (
            (result.name === "GB18030" || result.lang === "zh") &&
            result.confidence >= 10
          );
        })
      ) {
        fn_encoding = "gb18030";
        if (ccmMetadataRoot && metadataEntry) {
          ccmMetadataRoot = new TextDecoder("gb18030").decode(
            metadataEntry.rawEntryName
          );
        }
      }
    }
  }
  assertArchiveSizeSafe(size, zip.getEntries().length);

  const entry_tree = generateZipEntryTree(cf_path);

  const compress_info = {
    size: size,
    size_compressed: compressedSize,
    files_count: zip.getEntryCount(),
    fn_encoding: fn_encoding,
    format: "zip" as const,
  };

  if (!metadata && !ccmMetadata) {
    // Plain 包：包内没有任何元数据，不再直接拒绝——合成元数据并标记 plain，
    // 由战役流程按文件名降级安装，战役归属由用户指定。
    Logger.warn(
      `[CUSTOMIZE] no metadata found, treat as plain package: cf_path = ${cf_path}`
    );
    return {
      metadata: undefined,
      ccm: {
        metadata: synthesizePlainMetadata(
          stripArchiveExtension(basename(cf_path)),
          inferCampaignFromPaths(entryNames)
        ),
        plain: true,
      },
      compress_info: compress_info,
      entry_tree: entry_tree ?? undefined,
    };
  }

  return {
    metadata: metadata,
    ccm: {
      metadata: ccmMetadata,
      metadata_root: ccmMetadataRoot,
    },
    compress_info: compress_info,
    entry_tree: entry_tree ?? undefined,
  };
}

/**
 * 递归遍历目录，返回所有文件相对于 root 的 POSIX 路径与大小。
 */
async function walkDirectory(
  root: string
): Promise<{ relPath: string; size: number }[]> {
  const out: { relPath: string; size: number }[] = [];
  async function walk(dir: string, prefix: string) {
    const items = await readdir(dir, { withFileTypes: true });
    for (const item of items) {
      if (item.name === ".DS_Store" || item.name === ".scnexus") continue;
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) {
        await walk(join(dir, item.name), rel);
      } else if (item.isFile()) {
        const st = await stat(join(dir, item.name));
        out.push({ relPath: rel, size: st.size });
      }
    }
  }
  await walk(root, "");
  return out;
}

/**
 * 读取一个已解压目录的信息（元数据、文件树、统计），
 * 返回与 readCompressFileInfo7z 相同的 CompressFileInfo 结构。
 */
export async function readDirectoryInfo(
  dir_path: string
): Promise<CompressFileInfo | null> {
  const files = await walkDirectory(dir_path);

  let metadata: MetadataStandard | undefined;
  let ccmMetadata: MetadataStandard | undefined;
  let ccmMetadataRoot: string | undefined;

  let size = 0;

  for (const f of files) {
    const name = basename(f.relPath);
    if (name === "metadata.json") {
      const buffer = await readFile(join(dir_path, f.relPath));
      metadata = scnexusMetadataParser(decodeTextBuffer(buffer));
    }
    if (name === "metadata.txt") {
      const buffer = await readFile(join(dir_path, f.relPath));
      ccmMetadata = ccmMetadataParser(decodeTextBuffer(buffer));
      ccmMetadataRoot = dirname(f.relPath);
    }
    size += f.size;
  }

  const entries: EntryLike[] = files.map((f) => ({ file: f.relPath }));
  const { cfTree, cfList } = buildEntryInfoFromEntries(entries, dir_path);

  if (!metadata && !ccmMetadata) {
    // Plain 目录：没有任何元数据时同样降级为 plain 包处理。
    Logger.warn(
      `[CUSTOMIZE] no metadata found, treat as plain package: dir_path = ${dir_path}`
    );
    return {
      metadata: undefined,
      ccm: {
        metadata: synthesizePlainMetadata(
          basename(dir_path),
          inferCampaignFromPaths(files.map((f) => f.relPath))
        ),
        plain: true,
      },
      compress_info: {
        size: size,
        size_compressed: 0,
        files_count: files.length,
        fn_encoding: "utf8",
      },
      entry_tree: cfTree,
      entry_list: cfList,
    };
  }

  return {
    metadata: metadata,
    ccm: {
      metadata: ccmMetadata,
      metadata_root: ccmMetadataRoot,
    },
    compress_info: {
      size: size,
      size_compressed: 0,
      files_count: files.length,
      fn_encoding: "utf8",
    },
    entry_tree: cfTree,
    entry_list: cfList,
  };
}

export async function readCompressFileInfo7z(
  cf_path: string
): Promise<CompressFileInfo | null> {
  let isDirectory = false;
  try {
    isDirectory = statSync(cf_path).isDirectory();
  } catch (err) {
    Logger.error(err);
    return null;
  }
  if (isDirectory) {
    return readDirectoryInfo(cf_path);
  }

  let metadata: MetadataStandard | undefined;

  let ccmMetadata: MetadataStandard | undefined;
  let ccmMetadataRoot: string | undefined;

  let size: number = 0;
  let compressedSize: number = 0;
  let files_count: number = 0;

  let fn_encoding: string = "utf8";

  // 魔数判断只用于报告容器格式；解包统一交给 7zz（其支持 zip/rar/7z 等）。
  const format = detectArchiveFormat(cf_path);

  let promiseList: Promise<void>[] = [];
  const entryPaths: string[] = [];
  // 闸门校验错误不能在流回调里直接抛出（会被 EventEmitter 吞掉），
  // 先记录，流结束后统一抛出。
  let gateError: Error | undefined;
  const result = await new Promise<boolean>((resolve, reject) =>
    szList(cf_path, { charset: "UTF-8" })
      .on("data", async (data) => {
        const dataProcessPromise = async () => {
          if (gateError) return;
          try {
            assertEntryPathSafe(data.file);
          } catch (err) {
            gateError = err as Error;
            return;
          }
          entryPaths.push(data.file);
          if (fn_encoding === "utf8") {
            const encoding = analyse(Buffer.from(data.file));
            if (
              encoding.some((result) => {
                return result.name === "GB18030" && result.confidence >= 10;
              })
            ) {
              fn_encoding = "gb18030";
            }
          }
          const name = basename(data.file);
          if (name === "metadata.json") {
            const buffer = await szReadFile(cf_path, name);
            metadata = scnexusMetadataParser(decodeTextBuffer(buffer));
          }
          if (name === "metadata.txt") {
            const buffer = await szReadFile(cf_path, name);
            ccmMetadata = ccmMetadataParser(decodeTextBuffer(buffer));
            ccmMetadataRoot = dirname(data.file);
          }
          files_count += 1;
          size += data?.size ?? 0;
          compressedSize += data?.sizeCompressed ?? 0;
        };
        promiseList.push(dataProcessPromise());
      })
      .on("end", () => {
        resolve(true);
      })
      .on("error", (e) => {
        Logger.error(e);
        reject(e);
      })
  );

  if (!result) return null;
  await Promise.all(promiseList);

  if (gateError) {
    Logger.warn(
      `[CUSTOMIZE] unsafe archive entry rejected: cf_path = ${cf_path}, error = ${gateError.message}`
    );
    throw gateError;
  }
  // 安全闸门：zip bomb 防护（解压总量 / 条目数）。
  assertArchiveSizeSafe(size, files_count);

  const { cfList, cfTree } = await generateZipEntryInfo7z(cf_path);

  const compress_info = {
    size: size,
    size_compressed: compressedSize,
    files_count: files_count,
    fn_encoding: fn_encoding,
    format: format,
  };

  if (!metadata && !ccmMetadata) {
    // Plain 包：包内没有任何元数据，不再直接拒绝——合成元数据并标记 plain，
    // 由战役流程按文件名降级安装，战役归属由用户指定。
    Logger.warn(
      `[CUSTOMIZE] no metadata found, treat as plain package: cf_path = ${cf_path}`
    );
    return {
      metadata: undefined,
      ccm: {
        metadata: synthesizePlainMetadata(
          stripArchiveExtension(basename(cf_path)),
          inferCampaignFromPaths(entryPaths)
        ),
        plain: true,
      },
      compress_info: compress_info,
      entry_tree: cfTree ?? undefined,
      entry_list: cfList ?? undefined,
    };
  }

  return {
    metadata: metadata,
    ccm: {
      metadata: ccmMetadata,
      metadata_root: ccmMetadataRoot,
    },
    compress_info: compress_info,
    entry_tree: cfTree ?? undefined,
    entry_list: cfList ?? undefined,
  };
}

/**
 * Install Compress file, this will uncompress the zip file.
 * @param path Path to Compress file
 * @returns
 */
export async function installCompressFile(
  cf_path: string
): Promise<ResultUncompress> {
  const cfi = readCompressFileInfo(cf_path);
  if (!cfi) {
    Logger.warn(`[CUSTOMIZE] ${INVALID_COMPRESSED_FILE}: cf_path = ${cf_path}`);
    throw new Error(INVALID_COMPRESSED_FILE);
  }

  const { metadata, compress_info } = cfi;
  if (!metadata) {
    Logger.warn(`[CUSTOMIZE] ${METADATA_NOT_FOUND}: cf_path = ${cf_path}`);
    throw new Error(METADATA_NOT_FOUND);
  }

  if (metadata.manager !== "SCNexus") {
    Logger.warn(`[CUSTOMIZE] ${METHOD_SCNEXUS_ONLY}: cf_path = ${cf_path}`);
    throw new Error(METHOD_SCNEXUS_ONLY);
  }

  let storePath: string = "";
  if (metadata.type === "Customize") {
    storePath = profileStore.get("PROFILE_CUSTOMIZE").LIBRARY_ROOT;
  } else if (metadata.type === "Campaign") {
    storePath = profileStore.get("PROFILE_CAMPAIGN").LIBRARY_ROOT;
  } else {
    Logger.warn(
      `[CUSTOMIZE] ${METHOD_TYPE_UNSUPPORTED}: type = ${metadata.type}, cf_path = ${cf_path}`
    );
    throw new Error(METHOD_TYPE_UNSUPPORTED);
  }

  // 元数据缺 name 时退回压缩包文件名，避免拼出 LIBRARY_ROOT 本身
  const targetPath = join(
    storePath,
    sanitizePackageName(metadata.name) ||
      stripArchiveExtension(basename(cf_path)) ||
      "Customize"
  );

  await access(targetPath).catch(
    async () => await mkdir(targetPath, { recursive: true })
  );

  await zip
    .uncompress(cf_path, targetPath, {
      zipFileNameEncoding: compress_info.fn_encoding ?? "utf8",
    })
    .catch((err) => {
      Logger.error(
        `[CUSTOMIZE] ${UNCOMPRESSING_ERROR}: error = ${err}, cf_path = ${cf_path}, targetPath = ${targetPath}`
      );
      throw new Error(UNCOMPRESSING_ERROR);
    });

  return {
    metadata: metadata,
    cf_path: cf_path,
    cf_info: cfi,
  };
}

/**
 * Install Compress file, this will uncompress the zip file.
 * @param path Path to Compress file
 * @returns
 */
export async function installCompressFile7z(
  cf_path: string
): Promise<ResultUncompress> {
  const cfi = await readCompressFileInfo7z(cf_path);
  if (!cfi) {
    Logger.warn(`[CUSTOMIZE] ${INVALID_COMPRESSED_FILE}: cf_path = ${cf_path}`);
    throw new Error(INVALID_COMPRESSED_FILE);
  }

  const { metadata, compress_info } = cfi;
  if (!metadata) {
    Logger.warn(`[CUSTOMIZE] ${METADATA_NOT_FOUND}: cf_path = ${cf_path}`);
    throw new Error(METADATA_NOT_FOUND);
  }

  if (metadata.manager !== "SCNexus") {
    Logger.warn(`[CUSTOMIZE] ${METHOD_SCNEXUS_ONLY}: cf_path = ${cf_path}`);
    throw new Error(METHOD_SCNEXUS_ONLY);
  }

  let storePath: string = "";
  if (metadata.type === "Customize") {
    storePath = profileStore.get("PROFILE_CUSTOMIZE").LIBRARY_ROOT;
  } else if (metadata.type === "Campaign") {
    storePath = profileStore.get("PROFILE_CAMPAIGN").LIBRARY_ROOT;
  } else {
    Logger.warn(
      `[CUSTOMIZE] ${METHOD_TYPE_UNSUPPORTED}: type = ${metadata.type}, cf_path = ${cf_path}`
    );
    throw new Error(METHOD_TYPE_UNSUPPORTED);
  }

  // 元数据缺 name 时退回压缩包文件名，避免拼出 LIBRARY_ROOT 本身
  const targetPath = join(
    storePath,
    sanitizePackageName(metadata.name) ||
      stripArchiveExtension(basename(cf_path)) ||
      "Customize"
  );

  if (statSync(cf_path).isDirectory()) {
    // 源是已解压目录：直接递归拷贝，不执行解压
    await cp(cf_path, targetPath, { recursive: true }).catch((err) => {
      Logger.error(
        `[CUSTOMIZE] ${UNCOMPRESSING_ERROR}: error = ${err}, cf_path = ${cf_path}, targetPath = ${targetPath}`
      );
      throw new Error(UNCOMPRESSING_ERROR);
    });
  } else {
    await access(targetPath).catch(
      async () => await mkdir(targetPath, { recursive: true })
    );

    await szExtractFullPromisify(cf_path, targetPath).catch((err) => {
      Logger.error(
        `[CUSTOMIZE] ${UNCOMPRESSING_ERROR}: error = ${err}, cf_path = ${cf_path}, targetPath = ${targetPath}`
      );
      throw new Error(UNCOMPRESSING_ERROR);
    });
  }

  return {
    metadata: metadata,
    cf_path: cf_path,
    cf_info: cfi,
  };
}

export async function validateCompressFile(path: string) {}

/**
 * read metadata from zip file
 * @deprecated use {readCompressFileInfo} instead
 */
export function readMetadataFromZipFiles(
  path: string
): MetadataStandard | undefined {
  const zip = getZip(path);
  const file = zip.getEntries().find((entry) => {
    return entry.name === "metadata.json" || entry.name === "metadata.txt";
  });

  if (!file) {
    return undefined;
  }

  const data = file.getData().toString();

  if (file.name === "metadata.json") {
    return scnexusMetadataParser(data);
  } else if (file.name === "metadata.txt") {
    return ccmMetadataParser(data);
  } else {
    return undefined;
  }
}

/**
 * @deprecated
 */
export function unzipFileSimply(path: string): ResultUnzipFile {
  const metadata = readMetadataFromZipFiles(path);
  if (!metadata)
    return {
      success: false,
      error: METADATA_NOT_FOUND,
    };

  if (metadata.manager !== "CCM")
    return {
      success: false,
      error: "This method only support CCM Campaign Pacakage",
    };

  if (metadata.type !== "Campaign")
    return {
      success: false,
      error: "This method only support Campign type metadata.",
    };

  const zip = getZip(path);
  const metadataFile = zip.getEntries().find((entry) => {
    return entry.name === "metadata.txt";
  });
  if (!metadataFile) {
    return {
      success: false,
      error: METADATA_NOT_FOUND,
    };
  }
  const fileRoot = metadataFile.entryName.split(metadataFile.name)[0];
  let storePath: string = profileStore.get("PROFILE_CAMPAIGN").LIBRARY_ROOT;
  const dirName = metadata.name.replace(
    /[\~\!\@\#\$\%\^\&\*\"\|\:\<\>\/\\\\]/g,
    ""
  );
  if (!fileRoot) {
    storePath = join(storePath, dirName);
    mkdirSync(storePath, { recursive: true });
    zip.extractAllTo(storePath, true);
  } else {
    zip.extractAllTo(storePath, true);
    if (existsSync(join(storePath, dirName))) {
      rmSync(join(storePath, dirName), { recursive: true });
    }
    renameSync(join(storePath, fileRoot), join(storePath, dirName));
  }
  return {
    metadata,
    success: true,
    file_count: zip.getEntryCount(),
  };
}

/**
 * @deprecated
 */
export async function unzipCompressFileSimply(path: string) {}

// /**
//  * unzipFiles function test 2
//  * @deprecated
//  */
// export function unzipFiles(path: string): ResultUnzipFile {
//   const metadata = readMetadataFromZipFiles(path);
//   if (!metadata) {
//     return {
//       success: false,
//       error: METADATA_NOT_FOUND,
//     };
//   }

//   const zip = getZip(path);
//   const metadataFile = zip.getEntries().find((entry) => {
//     return entry.name === "metadata.json" || entry.name === "metadata.txt";
//   });
//   if (!metadataFile) {
//     return {
//       success: false,
//       error: METADATA_NOT_FOUND,
//     };
//   }
//   const fileRoot = metadataFile.entryName.split(metadataFile.name)[0];

//   let storePath: string;
//   if (metadata.type === "Customize") {
//     storePath = profileStore.get("PROFILE_CUSTOMIZE").LIBRARY_ROOT;
//   } else if (metadata.type === "Campaign") {
//     storePath = profileStore.get("PROFILE_CAMPAIGN").LIBRARY_ROOT;
//   } else {
//     return {
//       success: false,
//       error: "Unknown metadata type",
//     };
//   }
//   storePath = join(
//     storePath,
//     metadata.name.replace(/[\~\!\@\#\$\%\^\&\*\"\|\:\<\>\/\\\\]/g, "")
//   );
//   mkdirSync(storePath, { recursive: true });
//   zip.extractEntryTo(metadataFile, storePath, false, true);
//   // process maps
//   if (metadata.maps) {
//     metadata.maps.forEach((map) => {
//       if (map.components) {
//         zip.extractEntryTo(
//           zip.getEntry(`${fileRoot}${map.name}/`)!,
//           storePath,
//           false,
//           true
//         );
//       } else {
//         zip.extractEntryTo(
//           zip.getEntry(`${fileRoot}${map.name}`)!,
//           storePath,
//           false,
//           true
//         );
//       }
//     });
//   } else {
//     zip.getEntries().forEach((entry) => {
//       if (entry.name.endsWith(".SC2Map")) {
//         zip.extractEntryTo(entry, storePath, false, true);
//       } else if (entry.isDirectory && entry.entryName.endsWith(".SC2Map/")) {
//         zip.extractEntryTo(entry, storePath, true, true);
//       }
//     });
//   }
//   // process dependencies
//   if (metadata.dependencies) {
//     metadata.dependencies.forEach((dependency) => {
//       if (dependency.components) {
//         zip.extractEntryTo(
//           zip.getEntry(`${fileRoot}${dependency.name}/`)!,
//           storePath,
//           false,
//           true
//         );
//       } else {
//         zip.extractEntryTo(
//           zip.getEntry(`${fileRoot}${dependency.name}`)!,
//           storePath,
//           false,
//           true
//         );
//       }
//     });
//   } else {
//     zip.getEntries().forEach((entry) => {
//       if (entry.name.endsWith(".SC2Mod")) {
//         zip.extractEntryTo(entry, storePath, false, true);
//       } else if (entry.isDirectory && entry.entryName.endsWith(".SC2Mod/")) {
//         zip.extractEntryTo(entry, storePath, true, true);
//       }
//     });
//   }
//   return {
//     metadata,
//     success: true,
//   };
// }

// /**
//  * unzipFiles function test 1
//  * @deprecated
//  */
// export function unzipFiles(path: string): ResultUnzipFile {
//   const metadata = readMetadataFromZipFiles(path);
//   if (!metadata) {
//     return {
//       success: false,
//       error: METADATA_NOT_FOUND,
//     };
//   }
//   const zip = getZip(path);
//   const files = [] as {
//     name: string;
//     path: string;
//   }[];
//   // process maps
//   if (metadata.maps) {
//   } else {
//     zip.getEntries().forEach((entry) => {
//       if (entry.name.endsWith(".SC2Map")) {
//         let mapsRoot: string;
//         if (metadata.type === "Customize") {
//         } else if (metadata.type === "Campaign") {
//           mapsRoot += profileStore.get("PROFILE_CAMPAIGN").MAPS_ROOT;

//           if (metadata.campaign === "LOTV") {

//           } else {

//           }
//         }

//         zip.extractEntryTo(entry, modsRoot, false, true);
//         files.push({
//           name: entry.name,
//           path: join(modsRoot, entry.name),
//         });
//       }
//     });
//   }
//   // process dependencies
//   const modsRoot = profileStore.get("PROFILE_CAMPAIGN").MODS_ROOT;
//   if (metadata.dependencies) {
//   } else {
//     zip.getEntries().forEach((entry) => {
//       if (entry.name.endsWith(".SC2Mod")) {
//         zip.extractEntryTo(entry, modsRoot, false, true);
//         files.push({
//           name: entry.name,
//           path: join(modsRoot, entry.name),
//         });
//       }
//     });
//   }
//   return {
//     metadata,
//     files,
//     success: true,
//   };
// }
