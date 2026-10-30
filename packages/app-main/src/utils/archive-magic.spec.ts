import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { detectArchiveFormat } from "./archive-magic";

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "scnexus-archive-magic-"));

  // zip：本地文件头 "PK\x03\x04"
  await writeFile(
    join(tmpRoot, "sample.zip"),
    Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00])
  );
  // 空 zip："PK\x05\x06"
  await writeFile(
    join(tmpRoot, "empty.zip"),
    Buffer.from([0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00])
  );
  // 7z：37 7A BC AF 27 1C
  await writeFile(
    join(tmpRoot, "sample.7z"),
    Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x00])
  );
  // rar4："Rar!\x1a\x07\x00"
  await writeFile(
    join(tmpRoot, "sample.rar"),
    Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00, 0x00])
  );
  // rar5："Rar!\x1a\x07\x01\x00"
  await writeFile(
    join(tmpRoot, "sample.rar5"),
    Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00])
  );
  // 非 zip 内容（PE 头 "MZ"）
  await writeFile(
    join(tmpRoot, "sample.bin"),
    Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00])
  );
  // 文件不足 4 字节
  await writeFile(join(tmpRoot, "tiny.bin"), Buffer.from([0x4d, 0x5a]));
});

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("detectArchiveFormat", () => {
  it("detects zip by local file header magic", () => {
    expect(detectArchiveFormat(join(tmpRoot, "sample.zip"))).toBe("zip");
  });

  it("detects empty zip variant", async () => {
    expect(detectArchiveFormat(join(tmpRoot, "empty.zip"))).toBe("zip");
  });

  it("detects 7z magic", () => {
    expect(detectArchiveFormat(join(tmpRoot, "sample.7z"))).toBe("7z");
  });

  it("detects rar4 magic", () => {
    expect(detectArchiveFormat(join(tmpRoot, "sample.rar"))).toBe("rar");
  });

  it("detects rar5 magic", () => {
    expect(detectArchiveFormat(join(tmpRoot, "sample.rar5"))).toBe("rar");
  });

  it("returns unknown for non-archive content", () => {
    expect(detectArchiveFormat(join(tmpRoot, "sample.bin"))).toBe("unknown");
  });

  it("returns unknown when file is shorter than 4 bytes", () => {
    expect(detectArchiveFormat(join(tmpRoot, "tiny.bin"))).toBe("unknown");
  });

  it("returns unknown for nonexistent file", () => {
    expect(detectArchiveFormat(join(tmpRoot, "no-such-file"))).toBe("unknown");
  });
});
