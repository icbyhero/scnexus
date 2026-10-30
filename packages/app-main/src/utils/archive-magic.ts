import { closeSync, openSync, readSync } from "node:fs";

import type { ArchiveFormat } from "@scnexus/app-shared/types/customize.type";

/**
 * Detect the archive container format from magic bytes (file header),
 * instead of trusting the file extension. Handles renamed or
 * extension-less archives correctly.
 */
export function detectArchiveFormat(filePath: string): ArchiveFormat {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const header = Buffer.alloc(8);
    const bytesRead = readSync(fd, header, 0, 8, 0);
    if (bytesRead < 4) return "unknown";

    // zip: "PK\x03\x04" (local file header), also accept the empty
    // ("PK\x05\x06") and spanned ("PK\x07\x08") variants.
    if (
      header[0] === 0x50 &&
      header[1] === 0x4b &&
      ((header[2] === 0x03 && header[3] === 0x04) ||
        (header[2] === 0x05 && header[3] === 0x06) ||
        (header[2] === 0x07 && header[3] === 0x08))
    ) {
      return "zip";
    }

    if (bytesRead < 6) return "unknown";

    // 7z: 37 7A BC AF 27 1C
    if (
      header[0] === 0x37 &&
      header[1] === 0x7a &&
      header[2] === 0xbc &&
      header[3] === 0xaf &&
      header[4] === 0x27 &&
      header[5] === 0x1c
    ) {
      return "7z";
    }

    // rar: "Rar!\x1a\x07" (both RAR4 and RAR5 share this 6-byte signature)
    if (
      header[0] === 0x52 &&
      header[1] === 0x61 &&
      header[2] === 0x72 &&
      header[3] === 0x21 &&
      header[4] === 0x1a &&
      header[5] === 0x07
    ) {
      return "rar";
    }

    return "unknown";
  } catch (err) {
    // Unreadable file is not an archive we can dispatch on.
    return "unknown";
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}
