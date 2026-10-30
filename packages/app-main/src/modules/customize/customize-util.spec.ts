import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// customize-util 间接依赖 electron（profileStore / logger / 7zip-util），
// 纯函数测试中将其 mock 掉。
vi.mock("@/stores/profile", () => ({
  profileStore: { get: () => undefined },
}));
vi.mock("@/utils/logger", () => ({
  Logger: { info: () => {}, warn: () => {}, error: () => {} },
}));
vi.mock("@/utils/7zip-util", () => ({
  szListFull: vi.fn(),
}));

import {
  assertArchiveSizeSafe,
  assertEntryPathSafe,
  ccmMetadataParser,
  decodeTextBuffer,
  inferCampaignFromPaths,
  MAX_ARCHIVE_ENTRIES,
  MAX_UNPACKED_BYTES,
  sanitizePackageName,
  stripArchiveExtension,
  synthesizePlainMetadata,
} from "./customize-util";

describe("ccmMetadataParser", () => {
  it("parses basic key=value pairs", () => {
    const metadata = ccmMetadataParser(
      "title=My Campaign\ndesc=A description\nauthor=Alice\ncampaign=WOL\nversion=1.0.0"
    );
    expect(metadata.name).toBe("My Campaign");
    expect(metadata.description).toBe("A description");
    expect(metadata.author).toBe("Alice");
    expect(metadata.campaign).toBe("WOL");
    expect(metadata.version).toBe("1.0.0");
    expect(metadata.manager).toBe("CCM");
    expect(metadata.type).toBe("Campaign");
  });

  it("strips UTF-8 BOM before parsing", () => {
    const metadata = ccmMetadataParser("\uFEFFtitle=Bommed\n");
    expect(metadata.name).toBe("Bommed");
  });

  it("is case-insensitive on keys (upstream CCM uses ToLower)", () => {
    const metadata = ccmMetadataParser("Title=Upper Case\nDESC=Also Upper\n");
    expect(metadata.name).toBe("Upper Case");
    expect(metadata.description).toBe("Also Upper");
  });

  it("splits values on the first '=' only", () => {
    const metadata = ccmMetadataParser("title=a=b=c\n");
    expect(metadata.name).toBe("a=b=c");
  });

  it("skips lines without '=' instead of throwing", () => {
    const metadata = ccmMetadataParser("garbage line\n\ntitle=Kept\n\r\n");
    expect(metadata.name).toBe("Kept");
  });

  it("trims surrounding whitespace of keys and values", () => {
    const metadata = ccmMetadataParser("  title =  Spaced Value  \n");
    expect(metadata.name).toBe("Spaced Value");
  });

  it.each([
    ["swarm", "HOTS"],
    ["Wings", "WOL"],
    ["liberty", "WOL"],
    ["wol", "WOL"],
    ["hots", "HOTS"],
    ["void", "LOTV"],
    ["lotv", "LOTV"],
    ["voidprologue", "LOTV"],
    ["nova", "NCO"],
    ["NCO", "NCO"],
  ])("maps campaign alias %s to %s", (raw, expected) => {
    expect(ccmMetadataParser(`campaign=${raw}\n`).campaign).toBe(expected);
  });

  it("uppercases unknown campaign values (legacy behavior)", () => {
    expect(ccmMetadataParser("campaign=custom\n").campaign).toBe("CUSTOM");
  });

  it("handles CRLF line endings", () => {
    const metadata = ccmMetadataParser("title=CRLF\r\nauthor=Bob\r\n");
    expect(metadata.name).toBe("CRLF");
    expect(metadata.author).toBe("Bob");
  });
});

describe("decodeTextBuffer", () => {
  it("keeps valid utf-8 content untouched", () => {
    const text = "星际战役 Title";
    expect(decodeTextBuffer(Buffer.from(text, "utf8"))).toBe(text);
  });

  it("falls back to gb18030 when utf-8 decoding produces replacement chars", () => {
    // "星际" 的 GBK 编码字节
    const gbkBytes = Buffer.from([0xd0, 0xc7, 0xbc, 0xca]);
    expect(decodeTextBuffer(gbkBytes)).toBe("星际");
  });
});

describe("inferCampaignFromPaths", () => {
  it("infers HOTS from Maps/Campaign/swarm", () => {
    expect(inferCampaignFromPaths(["Maps/Campaign/swarm/xx.SC2Map"])).toBe(
      "HOTS"
    );
  });

  it("infers LOTV from nested void layout", () => {
    expect(
      inferCampaignFromPaths(["pkg/Maps/Campaign/void/yy.SC2Map"])
    ).toBe("LOTV");
  });

  it("infers LOTV from voidprologue layout", () => {
    expect(inferCampaignFromPaths(["Maps/Campaign/voidprologue/z.SC2Map"])).toBe(
      "LOTV"
    );
  });

  it("infers NCO from nova layout", () => {
    expect(inferCampaignFromPaths(["Maps/Campaign/nova/n.SC2Map"])).toBe("NCO");
  });

  it("infers WOL from liberty layout", () => {
    expect(inferCampaignFromPaths(["Maps/Campaign/liberty/w.SC2Map"])).toBe(
      "WOL"
    );
  });

  it("normalizes backslash separators", () => {
    expect(inferCampaignFromPaths(["Maps\\Campaign\\swarm\\a.SC2Map"])).toBe(
      "HOTS"
    );
  });

  it("returns empty string when nothing matches", () => {
    expect(inferCampaignFromPaths(["random.txt", "Mods/x.SC2Mod"])).toBe("");
  });
});

describe("assertEntryPathSafe", () => {
  it.each(["normal/file.txt", "a\\b.txt", "file.zip", "deep/nested/path.txt"])(
    "allows relative entry %s",
    (entry) => {
      expect(() => assertEntryPathSafe(entry)).not.toThrow();
    }
  );

  it.each([
    "../evil.txt",
    "a/../../b.txt",
    "/absolute/path.txt",
    "C:\\win\\evil.txt",
    "C:/win/evil.txt",
    "..\\..\\escape.txt",
  ])("rejects unsafe entry %s", (entry) => {
    expect(() => assertEntryPathSafe(entry)).toThrow();
  });
});

describe("assertArchiveSizeSafe", () => {
  it("allows sizes and counts below limits", () => {
    expect(() => assertArchiveSizeSafe(1024, 10)).not.toThrow();
    expect(() =>
      assertArchiveSizeSafe(MAX_UNPACKED_BYTES, MAX_ARCHIVE_ENTRIES)
    ).not.toThrow();
  });

  it("rejects total unpacked size above the limit", () => {
    expect(() => assertArchiveSizeSafe(MAX_UNPACKED_BYTES + 1, 1)).toThrow(
      "ARCHIVE_SIZE_LIMIT_EXCEEDED"
    );
  });

  it("rejects entry count above the limit", () => {
    expect(() => assertArchiveSizeSafe(1, MAX_ARCHIVE_ENTRIES + 1)).toThrow(
      "ARCHIVE_ENTRY_LIMIT_EXCEEDED"
    );
  });
});

describe("synthesizePlainMetadata", () => {
  it("builds a CCM campaign metadata from a file name", () => {
    const metadata = synthesizePlainMetadata("MyPack", "HOTS");
    expect(metadata.name).toBe("MyPack");
    expect(metadata.manager).toBe("CCM");
    expect(metadata.type).toBe("Campaign");
    expect(metadata.campaign).toBe("HOTS");
  });

  it("allows empty campaign (to be chosen by the user)", () => {
    expect(synthesizePlainMetadata("MyPack", "").campaign).toBe("");
  });
});

describe("sanitizePackageName", () => {
  it("strips filesystem-hostile characters", () => {
    expect(sanitizePackageName('a/b\\c:d*e~f')).toBe("abcdef");
  });

  it("keeps normal names", () => {
    expect(sanitizePackageName("My Campaign (2024)")).toBe(
      "My Campaign (2024)"
    );
  });
});

describe("stripArchiveExtension", () => {
  it.each([
    ["pack.zip", "pack"],
    ["pack.ZIP", "pack"],
    ["pack.7z", "pack"],
    ["pack.Rar", "pack"],
    ["pack.rar", "pack"],
  ])("strips archive extension from %s", (raw, expected) => {
    expect(stripArchiveExtension(raw)).toBe(expected);
  });

  it("keeps non-archive names", () => {
    expect(stripArchiveExtension(join("a", "b.tar"))).toBe(join("a", "b.tar"));
  });
});
