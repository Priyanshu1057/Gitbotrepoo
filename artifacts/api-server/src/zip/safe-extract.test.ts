import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractZipSafely,
  removeTemporaryDirectory,
  stripSingleTopLevelDirectory,
} from "./safe-extract";
import { joinGithubPath } from "../github/client";

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function makeZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const crc = crc32(entry.data);
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(entry.data.length),
      u32(entry.data.length),
      u16(name.length),
      u16(0),
      name,
      entry.data,
    ]);
    locals.push(local);
    centrals.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(crc),
        u32(entry.data.length),
        u32(entry.data.length),
        u16(name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        name,
      ]),
    );
    offset += local.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const localData = Buffer.concat(locals);
  return Buffer.concat([
    localData,
    centralDirectory,
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralDirectory.length),
    u32(localData.length),
    u16(0),
  ]);
}

async function withArchive(
  archive: Buffer,
  callback: (zipPath: string, extractionDirectory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "zip-test-"));
  const zipPath = path.join(directory, "archive.zip");
  const extractionDirectory = path.join(directory, "extracted");
  await writeFile(zipPath, archive);
  try {
    await callback(zipPath, extractionDirectory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const limits = {
  maxFiles: 100,
  maxExtractedSize: 1024 * 1024,
  maxCompressionRatio: 1000,
};

test("preserves nested and deeply nested paths exactly", async () => {
  const archive = makeZip([
    { name: "a/b/c/file.txt", data: Buffer.from("hello") },
    { name: "x/y/image.png", data: Buffer.from([0, 255, 16, 128]) },
    { name: "README.md", data: Buffer.from("# readme") },
  ]);
  await withArchive(archive, async (zipPath, extractionDirectory) => {
    const summary = await extractZipSafely(zipPath, extractionDirectory, limits);
    assert.deepEqual(summary.files.map((file) => file.relativePath).sort(), [
      "README.md",
      "a/b/c/file.txt",
      "x/y/image.png",
    ]);
    assert.equal(summary.fileCount, 3);
    assert.equal(summary.folderCount, 5);
    assert.deepEqual([...await readFile(path.join(extractionDirectory, "x/y/image.png"))], [0, 255, 16, 128]);
  });
});

test("supports a simple archive and destination paths without flattening", async () => {
  const archive = makeZip([
    { name: "index.html", data: Buffer.from("<html />") },
    { name: "css/style.css", data: Buffer.from("body{}") },
  ]);
  await withArchive(archive, async (zipPath, extractionDirectory) => {
    const summary = await extractZipSafely(zipPath, extractionDirectory, limits);
    assert.equal(joinGithubPath("projects/myapp", summary.files[1].relativePath), "projects/myapp/css/style.css");
    assert.equal(joinGithubPath("/", summary.files[0].relativePath), "index.html");
  });
});

test("removes one common wrapper directory without changing file contents", async () => {
  const archive = makeZip([
    { name: "zip-to-github-uploader-mongodb/src/index.ts", data: Buffer.from("export {};") },
    { name: "zip-to-github-uploader-mongodb/package.json", data: Buffer.from("{}") },
  ]);
  await withArchive(archive, async (zipPath, extractionDirectory) => {
    const extracted = await extractZipSafely(zipPath, extractionDirectory, limits);
    const normalized = stripSingleTopLevelDirectory(extracted);
    assert.equal(normalized.strippedDirectory, "zip-to-github-uploader-mongodb");
    assert.deepEqual(normalized.summary.files.map((file) => file.relativePath).sort(), [
      "package.json",
      "src/index.ts",
    ]);
    assert.equal(normalized.summary.files[0].absolutePath.includes("/extracted/zip-to-github-uploader-mongodb/"), true);
  });
});

test("rejects traversal paths", async () => {
  await withArchive(makeZip([{ name: "../evil.txt", data: Buffer.from("no") }]), async (zipPath, extractionDirectory) => {
    await assert.rejects(
      extractZipSafely(zipPath, extractionDirectory, limits),
      /Unsafe archive path/,
    );
  });
});

test("rejects absolute paths", async () => {
  await withArchive(makeZip([{ name: "/etc/passwd", data: Buffer.from("no") }]), async (zipPath, extractionDirectory) => {
    await assert.rejects(
      extractZipSafely(zipPath, extractionDirectory, limits),
      /Unsafe archive path/,
    );
  });
});

test("rejects invalid and empty ZIP files", async () => {
  await withArchive(Buffer.from("not a zip"), async (zipPath, extractionDirectory) => {
    await assert.rejects(extractZipSafely(zipPath, extractionDirectory, limits));
  });
  await withArchive(makeZip([]), async (zipPath, extractionDirectory) => {
    await assert.rejects(extractZipSafely(zipPath, extractionDirectory, limits), /empty/i);
  });
});

test("enforces file and extracted-size limits", async () => {
  const archive = makeZip([
    { name: "one.txt", data: Buffer.alloc(10) },
    { name: "two.txt", data: Buffer.alloc(10) },
  ]);
  await withArchive(archive, async (zipPath, extractionDirectory) => {
    await assert.rejects(
      extractZipSafely(zipPath, extractionDirectory, { ...limits, maxFiles: 1 }),
      /more than 1 files/,
    );
  });
  await withArchive(archive, async (zipPath, extractionDirectory) => {
    await assert.rejects(
      extractZipSafely(zipPath, extractionDirectory, { ...limits, maxExtractedSize: 15 }),
      /extracted ZIP exceeds/,
    );
  });
});

test("cleanup helper removes temporary upload directories", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "zip-cleanup-"));
  await removeTemporaryDirectory(directory);
  await assert.rejects(readFile(directory));
});