import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";

export type ExtractedFile = {
  relativePath: string;
  absolutePath: string;
  size: number;
};

export type ZipSummary = {
  files: ExtractedFile[];
  fileCount: number;
  folderCount: number;
  totalSize: number;
  preview: string[];
};

export function stripSingleTopLevelDirectory(summary: ZipSummary): {
  summary: ZipSummary;
  strippedDirectory?: string;
} {
  const topLevelDirectories = new Set(
    summary.files
      .map((file) => file.relativePath.split("/")[0])
      .filter((segment, index, all) => all.indexOf(segment) === index),
  );
  if (topLevelDirectories.size !== 1) return { summary };

  const [directory] = topLevelDirectories;
  if (!directory || !summary.files.every((file) => file.relativePath.startsWith(`${directory}/`))) {
    return { summary };
  }

  const files = summary.files.map((file) => ({
    ...file,
    relativePath: file.relativePath.slice(directory.length + 1),
  }));
  const folders = new Set<string>();
  for (const file of files) {
    for (let parent = path.posix.dirname(file.relativePath); parent !== "."; parent = path.posix.dirname(parent)) {
      folders.add(parent);
    }
  }

  return {
    summary: {
      ...summary,
      files,
      folderCount: folders.size,
      preview: files.map((file) => file.relativePath).slice(0, 100),
    },
    strippedDirectory: directory,
  };
}

type Limits = {
  maxFiles: number;
  maxExtractedSize: number;
  maxCompressionRatio: number;
};

const ZIP_FILE_MODE = 0o100000;
const SYMLINK_MODE = 0o120000;

function safeRelativePath(rawName: string): string {
  const name = rawName.replaceAll("\\", "/");
  if (!name || name.includes("\0") || name.startsWith("/") || /^[A-Za-z]:\//.test(name)) {
    throw new Error(`Unsafe archive path: ${rawName}`);
  }

  const normalized = path.posix.normalize(name);
  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.startsWith("/")
  ) {
    throw new Error(`Unsafe archive path: ${rawName}`);
  }

  return normalized.replace(/^\/+|\/+$/g, "");
}

function isSymlink(entry: yauzl.Entry): boolean {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (unixMode & 0o170000) === SYMLINK_MODE;
}

function isDirectory(entry: yauzl.Entry, relativePath: string): boolean {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return relativePath.endsWith("/") || (unixMode & 0o170000) === 0o040000;
}

function openZip(filePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, strictFileNames: true }, (error, zipFile) => {
      if (error) {
        if (/relative path|absolute path|backslash/i.test(error.message)) {
          reject(new Error(`Unsafe archive path: ${error.message}`));
        } else {
          reject(error);
        }
      } else if (!zipFile) {
        reject(new Error("Unable to open ZIP archive"));
      }
      else resolve(zipFile);
    });
  });
}

export async function createTemporaryDirectory(prefix = "zip-github-"): Promise<string> {
  return mkdtemp(path.join("/tmp", prefix));
}

export async function extractZipSafely(
  zipPath: string,
  extractionDirectory: string,
  limits: Limits,
): Promise<ZipSummary> {
  await mkdir(extractionDirectory, { recursive: true });
  const zipFile = await openZip(zipPath);
  const files: ExtractedFile[] = [];
  const folders = new Set<string>();
  const seenPaths = new Set<string>();
  let totalSize = 0;

  return new Promise<ZipSummary>((resolve, reject) => {
    let settled = false;
    const normalizeZipError = (error: unknown): Error => {
      const message = error instanceof Error ? error.message : String(error);
      if (/relative path|absolute path|backslash/i.test(message)) {
        return new Error(`Unsafe archive path: ${message}`);
      }
      return error instanceof Error ? error : new Error(message);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      zipFile.close();
      reject(normalizeZipError(error));
    };

    zipFile.on("error", fail);
    zipFile.on("end", () => {
      if (settled) return;
      settled = true;
      if (files.length === 0) {
        reject(new Error("The ZIP archive is empty."));
        return;
      }
      resolve({
        files,
        fileCount: files.length,
        folderCount: folders.size,
        totalSize,
        preview: files.map((file) => file.relativePath).slice(0, 100),
      });
    });

    zipFile.on("entry", (entry) => {
      if (settled) return;
      void (async () => {
        const rawName = entry.fileName;
        const relativePath = safeRelativePath(rawName);
        if (isSymlink(entry)) throw new Error(`Symlink entries are not allowed: ${relativePath}`);
        if (!relativePath) throw new Error(`Invalid archive path: ${rawName}`);
        if (seenPaths.has(relativePath)) throw new Error(`Duplicate archive path: ${relativePath}`);
        seenPaths.add(relativePath);

        if (isDirectory(entry, rawName)) {
          folders.add(relativePath);
          zipFile.readEntry();
          return;
        }

        if (files.length >= limits.maxFiles) {
          throw new Error(`The ZIP contains more than ${limits.maxFiles.toLocaleString()} files.`);
        }
        if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) {
          throw new Error(`Invalid uncompressed size for ${relativePath}`);
        }
        if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > limits.maxCompressionRatio) {
          throw new Error(`The ZIP compression ratio is too high for ${relativePath}.`);
        }
        if (totalSize + entry.uncompressedSize > limits.maxExtractedSize) {
          throw new Error(
            `The extracted ZIP exceeds the ${Math.round(limits.maxExtractedSize / 1024 / 1024)} MB limit.`,
          );
        }

        const absolutePath = path.resolve(extractionDirectory, relativePath);
        const root = path.resolve(extractionDirectory) + path.sep;
        if (!absolutePath.startsWith(root)) throw new Error(`Unsafe archive path: ${relativePath}`);

        await mkdir(path.dirname(absolutePath), { recursive: true });
        const stream = await new Promise<NodeJS.ReadableStream>((resolveStream, rejectStream) => {
          zipFile.openReadStream(entry, (error, readStream) => {
            if (error || !readStream) rejectStream(error ?? new Error("Unable to read ZIP entry"));
            else resolveStream(readStream);
          });
        });
        await pipeline(stream, createWriteStream(absolutePath, { flags: "wx", mode: 0o600 }));

        const actualSize = (await stat(absolutePath)).size;
        if (actualSize !== entry.uncompressedSize) {
          throw new Error(`The ZIP entry size changed while extracting: ${relativePath}`);
        }
        totalSize += actualSize;
        files.push({ relativePath, absolutePath, size: actualSize });
        for (let parent = path.posix.dirname(relativePath); parent !== "."; parent = path.posix.dirname(parent)) {
          folders.add(parent);
        }
        zipFile.readEntry();
      })().catch(fail);
    });

    zipFile.readEntry();
  });
}

export async function removeTemporaryDirectory(directory: string): Promise<void> {
  if (!directory) return;
  await rm(directory, { recursive: true, force: true });
}