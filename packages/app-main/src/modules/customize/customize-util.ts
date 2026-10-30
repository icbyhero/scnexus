import { exists } from "@/utils/fs-util";
import { join, basename } from "node:path";
import { readFile, access, readdir, rm } from "node:fs/promises";
import { CampaignType, MetadataStandard } from "scnexus-standard/metadata";
import { profileStore } from "@/stores/profile";
import { AdmZip, getZip } from "@/utils/admzip";
import { Logger } from "@/utils/logger";
import {
  CompressFileList,
  CompressFileTree,
} from "@scnexus/app-shared/types/customize.type";
import {
  ARCHIVE_ENTRY_LIMIT_EXCEEDED,
  ARCHIVE_PATH_UNSAFE,
  ARCHIVE_SIZE_LIMIT_EXCEEDED,
} from "@scnexus/app-shared/errors/customize.error";
import { szListFull } from "@/utils/7zip-util";

/**
 * zip bomb 防护闸门：解压后总上限 8GB、条目数上限 10 万（对齐弥音实现）。
 */
export const MAX_UNPACKED_BYTES = 8 * 1024 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 100_000;

/**
 * Parse the metadata from file to a Standard Metadata object
 * @param data Metadata string from SCNexus metadata file
 * @returns `Metadata`
 */
export function scnexusMetadataParser(data: string): MetadataStandard {
  let metadata: MetadataStandard;
  metadata = {
    manager: "SCNexus",
    manager_mode: "standard",
    ...JSON.parse(data),
  };
  return metadata;
}

/**
 * CCM metadata.txt 的 campaign 字段别名表（对齐弥音实现）。
 * 上游各渠道打包习惯不一，同一战役存在多种写法。
 */
const CAMPAIGN_ALIASES: Record<string, CampaignType> = {
  wings: "WOL",
  liberty: "WOL",
  wol: "WOL",
  swarm: "HOTS",
  hots: "HOTS",
  void: "LOTV",
  lotv: "LOTV",
  voidprologue: "LOTV",
  nova: "NCO",
  nco: "NCO",
};

function normalizeCampaignValue(value: string): CampaignType {
  const key = value.trim().toLowerCase();
  return CAMPAIGN_ALIASES[key] ?? (value.trim().toUpperCase() as CampaignType);
}

/**
 * This function will help parse the metadata from a CCM file to a Standard Metadata object
 * @warn CCM Standard is now only support Campaign type
 * @param data Metadata string from CCM metadata file
 * @returns `Metadata`
 *
 * 解析永不失败：键名大小写不敏感（上游 CCM 用 ToLower 比较）、
 * 无 "=" 的坏行直接跳过、值按第一个 "=" 切分（值里可含 "="）、
 * 并剥离 UTF-8 BOM（U+FEFF 不是空白字符，trim 去不掉）。
 */
export function ccmMetadataParser(data: string): MetadataStandard {
  let metadata: MetadataStandard = {
    name: "",
    description: "",
    author: "",
    type: "Campaign", // CCM Metadata only available in Camapign packages
    campaign: "" as CampaignType,
    bank_enable: "offcial",
    version: "",
    mods: undefined,
    manager: "CCM",
  };
  const content = data.replace(/^\uFEFF/, "");
  for (const line of content.split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    switch (key) {
      case "title":
        metadata.name = value;
        break;
      case "desc":
        metadata.description = value;
        break;
      case "author":
        metadata.author = value;
        break;
      case "campaign":
        metadata.campaign = normalizeCampaignValue(value);
        break;
      case "version":
        metadata.version = value;
        break;
    }
  }
  return metadata;
}

/**
 * 解压包内文本文件：优先按 UTF-8 解码，出现替换符（U+FFFD，
 * 说明不是合法 UTF-8）时退回 GB18030。国内中文包的元数据常见 GBK 编码。
 */
export function decodeTextBuffer(buffer: Buffer): string {
  const utf8 = buffer.toString("utf8");
  if (!utf8.includes("\uFFFD")) return utf8;
  try {
    return new TextDecoder("gb18030").decode(buffer);
  } catch {
    return utf8;
  }
}

/**
 * 扫描包内条目路径推断战役归属：识别 `Maps/Campaign/<sub>` 官方目录布局
 * （swarm→虫群、void/voidprologue→虚空、nova→诺娃、liberty→自由之翼）。
 * 推断不出返回 ""，归属交由用户在安装时指定，绝不瞎猜。
 */
export function inferCampaignFromPaths(paths: string[]): CampaignType | "" {
  for (const rawPath of paths) {
    const normalized = rawPath.replace(/\\/g, "/");
    const matched = normalized.match(/Maps\/Campaign\/([^/]+)/i);
    if (!matched) continue;
    const seg = matched[1].toLowerCase();
    if (seg === "liberty" || seg === "wol" || seg === "wings") return "WOL";
    if (seg === "swarm" || seg === "hots") return "HOTS";
    if (seg === "void" || seg === "lotv" || seg === "voidprologue")
      return "LOTV";
    if (seg === "nova" || seg === "nco") return "NCO";
  }
  return "";
}

/**
 * zip-slip 防护：压缩包条目名归一化后必须还是相对路径，
 * 拒绝绝对路径、盘符与 ".." 上跳，防止解压越过目标目录。
 */
export function assertEntryPathSafe(entryName: string): void {
  const normalized = entryName.replace(/\\/g, "/");
  if (/^\//.test(normalized) || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(ARCHIVE_PATH_UNSAFE);
  }
  for (const seg of normalized.split("/")) {
    if (seg === "..") {
      throw new Error(ARCHIVE_PATH_UNSAFE);
    }
  }
}

/**
 * zip bomb 防护：校验解压后总体积与条目数，超出即拒绝解压。
 */
export function assertArchiveSizeSafe(
  totalUnpackedSize: number,
  entriesCount: number
): void {
  if (totalUnpackedSize > MAX_UNPACKED_BYTES) {
    throw new Error(ARCHIVE_SIZE_LIMIT_EXCEEDED);
  }
  if (entriesCount > MAX_ARCHIVE_ENTRIES) {
    throw new Error(ARCHIVE_ENTRY_LIMIT_EXCEEDED);
  }
}

/**
 * 为 Plain 包（无元数据）合成一份 CCM 元数据：
 * 名称取压缩包文件名，战役归属由调用方传入（可为空，待用户指定）。
 */
export function synthesizePlainMetadata(
  name: string,
  campaign: CampaignType | ""
): MetadataStandard {
  return {
    name,
    description: "",
    author: "",
    type: "Campaign",
    campaign: campaign as CampaignType,
    bank_enable: "offcial",
    version: "",
    mods: undefined,
    manager: "CCM",
  };
}

/**
 * 安装目录名安全化：剔除文件系统不友好字符。
 */
export function sanitizePackageName(name: string): string {
  return name.replace(/[\~\!\@\#\$\%\^\&\*\"\|\:\<\>\/\\\\]/g, "").trim();
}

/**
 * 去掉压缩包扩展名（zip/rar/7z），用于 Plain 包按文件名命名。
 */
export function stripArchiveExtension(name: string): string {
  return name.replace(/\.(zip|rar|7z)$/i, "");
}

export async function scnexusMetaFileParser(
  path: string
): Promise<MetadataStandard> {
  const metafile = await readFile(path, { encoding: "utf8" });
  return scnexusMetadataParser(metafile);
}

export async function ccmMetaFileParser(
  path: string
): Promise<MetadataStandard> {
  const metafile = await readFile(path, { encoding: "utf8" });
  return ccmMetadataParser(metafile);
}

export function generateZipEntryTree(cf_path: string) {
  let zip: AdmZip;
  try {
    zip = getZip(cf_path);
  } catch (err) {
    Logger.error(err);
    return null;
  }

  const entries = zip.getEntries();

  const cfTree: CompressFileTree = {
    cf_path,
    name: basename(cf_path),
    root: {
      name: basename(cf_path),
      path: "/",
      isFile: false,
      isDirectory: true,
      children: [],
    },
  };

  for (const entry of entries) {
    let currentNode = cfTree.root;

    if (entry.name === "" || entry.isDirectory) {
      continue;
    }

    const segments = entry.entryName.split("/");
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];

      if (/\.sc2mod$|\.sc2map$/i.test(seg) && i < segments.length - 1) {
        if (
          currentNode.children?.findIndex(
            (node) => node.name === seg && node.isComponent
          ) === -1
        ) {
          currentNode.children.push({
            path: entry.entryName
              .split("/")
              .slice(0, i + 1)
              .join("/"),
            name: seg,
            isComponent: true,
            isDirectory: true,
            isFile: false,
          });
        }
        break;
      }

      if (i === segments.length - 1) {
        if (
          currentNode.children?.findIndex(
            (node) => node.name === seg && !node.isComponent
          ) === -1
        ) {
          currentNode.children?.push({
            path: entry.entryName,
            name: seg,
            isComponent: false,
            isDirectory: false,
            isFile: true,
          });
        }
      } else {
        let dirNode = currentNode.children?.find(
          (dir) => dir.isDirectory && dir.name === seg
        );
        if (!dirNode) {
          dirNode = {
            name: seg,
            path: segments.slice(0, i + 1).join("/"),
            children: [],
            isFile: false,
            isDirectory: true,
          };
          currentNode.children?.push(dirNode);
        }
        currentNode = dirNode;
      }
    }
  }

  return cfTree;
}

export async function generateZipEntryInfo7z(cf_path: string) {
  const entries = await szListFull(cf_path);
  return buildEntryInfoFromEntries(entries, cf_path);
}

/**
 * 最小的条目结构，node-7z 的 Data 与目录遍历结果都满足该结构。
 */
export interface EntryLike {
  file: string;
  attributes?: string;
}

/**
 * 根据条目列表（压缩包条目或目录内文件）构建条目树与扁平列表。
 */
export function buildEntryInfoFromEntries(
  entries: EntryLike[],
  cf_path: string
): { cfTree: CompressFileTree; cfList: CompressFileList } {
  const cfTree: CompressFileTree = {
    cf_path,
    name: basename(cf_path),
    root: {
      name: basename(cf_path),
      path: "/",
      isFile: false,
      isDirectory: true,
      children: [],
    },
  };
  const cfList: CompressFileList = {
    cf_path,
    name: basename(cf_path),
    files: [],
  };

  for (const entry of entries) {
    const fullPath = entry.file;

    let currentNode = cfTree.root;

    if (entry.attributes?.match(/D/)) {
      continue;
    }

    const segments = fullPath.split("/");
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const type = seg.match(/\.sc2mod$/i)
        ? "SC2Mod"
        : seg.match(/\.sc2map$/i)
        ? "SC2Map"
        : seg.split(".")[1];
      const folder = ("/" + fullPath).split("/")[1] ?? "Root";

      const path =
        "/" +
        fullPath
          .split("/")
          .slice(0, i + 1)
          .join("/");

      if (/\.sc2mod$|\.sc2map$/i.test(seg) && i < segments.length - 1) {
        if (
          currentNode.children?.findIndex(
            (node) => node.name === seg && node.isComponent
          ) === -1
        ) {
          currentNode.children.push({
            path: path,
            name: seg,
            isComponent: true,
            isFile: false,
            isDirectory: true,
          });
          cfList.files.push({
            name: seg,
            path: path,
            isComponent: true,
            type: type,
            folder: folder,
          });
        }
        break;
      }

      if (i === segments.length - 1) {
        if (
          currentNode.children?.findIndex(
            (node) => node.name === seg && !node.isComponent
          ) === -1
        ) {
          currentNode.children.push({
            path: fullPath,
            name: seg,
            isComponent: false,
            isFile: true,
            isDirectory: false,
          });
          cfList.files.push({
            name: seg,
            path: path,
            isComponent: true,
            type: type,
            folder: folder,
          });
        }
      } else {
        let dirNode = currentNode.children?.find(
          (dir) => dir.isDirectory && dir.name === seg
        );
        if (!dirNode) {
          dirNode = {
            name: seg,
            path: "/" + segments.slice(0, i + 1).join("/"),
            children: [],
            isFile: false,
            isDirectory: true,
          };
          currentNode.children?.push(dirNode);
        }
        currentNode = dirNode;
      }
    }
  }

  return {
    cfTree,
    cfList,
  };
}

export async function rmDirWhitely(dirPath: string) {
  const exist = await exists(dirPath);
  if (!exist) return;

  if (!profileStore.get("SUCCESS")) return;

  if (
    !profileStore
      .get("PATH_WHITE_LIST")
      ?.some((path) => dirPath.startsWith(path))
  ) {
    return;
  }

  await rm(dirPath, { recursive: true });
}

export async function rmFilesFromDirWhitely(
  dirPath: string,
  exclude: string[] = []
): Promise<void> {
  const exist = await exists(dirPath);
  if (!exist) return;

  if (!profileStore.get("SUCCESS")) return;

  if (
    !profileStore.get("PATH_WHITE_LIST")?.some((path) => {
      console.log(path, dirPath);
      return dirPath.startsWith(path);
    })
  ) {
    return;
  }

  const items = await readdir(dirPath, {
    encoding: "utf-8",
    withFileTypes: true,
  });

  for (const file of items) {
    if (!exclude.includes(file.name)) {
      await rm(join(dirPath, file.name), { recursive: true });
    }
  }
}
