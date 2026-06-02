import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import type { ToolExecutionResult } from "./tool-registry";

const maxReadLines = 2000;
const maxReadBytes = 50 * 1024;
const maxImageBytes = 1024 * 1024;
const maxImageDimension = 2000;
const maxResizableImagePixels = 16_000_000;
const defaultCommandTimeoutSeconds = 30;
const maxCommandTimeoutSeconds = 120;
const maxCommandOutputLines = 2000;
const maxCommandOutputBytes = 50 * 1024;

type BuiltinToolContext = {
  conversationId: string;
  abortSignal?: AbortSignal;
  supportsImageContent?: boolean;
  workspaceRoot?: string;
};

type ResolvedWorkspacePath = {
  ok: true;
  root: string;
  fullPath: string;
  relativePath: string;
} | {
  ok: false;
  error: string;
};

type EditRange = {
  oldText: string;
  newText: string;
  start: number;
  end: number;
  usedFuzzyMatch: boolean;
  normalizations: string[];
};

type PngImage = {
  width: number;
  height: number;
  rgba: Buffer;
};

const mutationQueues = new Map<string, Promise<unknown>>();

export async function executeRead(argumentsJson: string, context: BuiltinToolContext): Promise<ToolExecutionResult> {
  const args = safeJson(argumentsJson) as { path?: unknown; offset?: unknown; limit?: unknown };
  const requestedPath = typeof args.path === "string" ? args.path.trim() : "";
  if (!requestedPath) {
    return { ok: false, status: "failed", result: { error: "read requires path." } };
  }
  const resolved = await resolveWorkspacePathForConversation(context.conversationId, requestedPath, context.workspaceRoot);
  if (!resolved.ok) {
    return { ok: false, status: "failed", result: { error: resolved.error } };
  }

  try {
    const stat = await fs.stat(resolved.fullPath);
    if (!stat.isFile()) {
      return { ok: false, status: "failed", result: { error: "read path is not a file.", path: resolved.relativePath } };
    }
    const header = await readHeader(resolved.fullPath);
    const mimeType = detectImageMimeType(header, resolved.fullPath);
    if (mimeType) {
      const image = await readImageFile(resolved.fullPath, mimeType, stat.size, context.supportsImageContent !== false);
      return {
        ok: true,
        status: "completed",
        result: {
          path: resolved.relativePath,
          root: resolved.root,
          conversationId: context.conversationId,
          mediaType: "image",
          mimeType,
          bytes: stat.size,
          ...image
        }
      };
    }

    const content = await fs.readFile(resolved.fullPath, "utf8");
    const lines = splitLines(content);
    const offset = typeof args.offset === "number" && Number.isFinite(args.offset)
      ? Math.max(1, Math.trunc(args.offset))
      : 1;
    const requestedLimit = typeof args.limit === "number" && Number.isFinite(args.limit)
      ? Math.max(1, Math.trunc(args.limit))
      : maxReadLines;
    const limit = Math.min(maxReadLines, requestedLimit);
    if (offset > lines.length && lines.length > 0) {
      return {
        ok: false,
        status: "failed",
        result: {
          error: "read offset is beyond the end of the file.",
          path: resolved.relativePath,
          offset,
          totalLines: lines.length
        }
      };
    }
    const selected = takeLineWindowWithinByteLimit(lines, offset, limit, maxReadBytes);
    return {
      ok: true,
      status: "completed",
      result: {
        path: resolved.relativePath,
        root: resolved.root,
        conversationId: context.conversationId,
        mediaType: "text",
        bytes: stat.size,
        offset,
        limit,
        startLine: selected.startLine,
        endLine: selected.endLine,
        totalLines: lines.length,
        truncated: selected.truncated,
        continuationOffset: selected.truncated ? selected.endLine + 1 : null,
        content: selected.content
      }
    };
  } catch (error) {
    return {
      ok: false,
      status: "failed",
      result: { error: error instanceof Error ? error.message : String(error), path: resolved.relativePath }
    };
  }
}

export async function executeWrite(argumentsJson: string, context: BuiltinToolContext): Promise<ToolExecutionResult> {
  const args = safeJson(argumentsJson) as { path?: unknown; content?: unknown };
  const requestedPath = typeof args.path === "string" ? args.path.trim() : "";
  if (!requestedPath) {
    return { ok: false, status: "failed", result: { error: "write requires path." } };
  }
  if (typeof args.content !== "string") {
    return { ok: false, status: "failed", result: { error: "write requires string content.", path: requestedPath } };
  }
  const content = args.content;
  const root = conversationWorkspaceRoot(context.conversationId, context.workspaceRoot);
  const resolved = resolveWorkspacePath(root, requestedPath);
  if (!resolved.ok) {
    return { ok: false, status: "failed", result: { error: resolved.error } };
  }

  return enqueueFileMutation(resolved.fullPath, async () => {
    try {
      const before = await fs.stat(resolved.fullPath).catch(() => undefined);
      if (before && !before.isFile()) {
        return { ok: false, status: "failed", result: { error: "write path exists but is not a file.", path: resolved.relativePath } };
      }
      await fs.mkdir(path.dirname(resolved.fullPath), { recursive: true });
      await fs.writeFile(resolved.fullPath, content, "utf8");
      return {
        ok: true,
        status: "completed",
        result: {
          path: resolved.relativePath,
          root: resolved.root,
          conversationId: context.conversationId,
          bytes: Buffer.byteLength(content, "utf8"),
          created: !before,
          updated: Boolean(before),
          mutationQueued: true
        }
      };
    } catch (error) {
      return {
        ok: false,
        status: "failed",
        result: { error: error instanceof Error ? error.message : String(error), path: resolved.relativePath }
      };
    }
  });
}

export async function executeEdit(argumentsJson: string, context: BuiltinToolContext): Promise<ToolExecutionResult> {
  const args = safeJson(argumentsJson) as {
    path?: unknown;
    edits?: unknown;
  };
  const requestedPath = typeof args.path === "string" ? args.path.trim() : "";
  if (!requestedPath) {
    return { ok: false, status: "failed", result: { error: "edit requires path." } };
  }
  if (!Array.isArray(args.edits) || args.edits.length === 0) {
    return { ok: false, status: "failed", result: { error: "edit requires at least one edit.", path: requestedPath } };
  }
  const edits = args.edits.map((item) => item && typeof item === "object" ? item as Record<string, unknown> : {});
  const invalidEditIndex = edits.findIndex((edit) => typeof edit.oldText !== "string" || typeof edit.newText !== "string");
  if (invalidEditIndex >= 0) {
    return { ok: false, status: "failed", result: { error: "Each edit requires string oldText and newText.", path: requestedPath, editIndex: invalidEditIndex } };
  }
  const emptyOldTextIndex = edits.findIndex((edit) => (edit.oldText as string).length === 0);
  if (emptyOldTextIndex >= 0) {
    return { ok: false, status: "failed", result: { error: "edit oldText cannot be empty.", path: requestedPath, editIndex: emptyOldTextIndex } };
  }
  if (edits.every((edit) => edit.oldText === edit.newText)) {
    return { ok: false, status: "failed", result: { error: "edit would not change the file.", path: requestedPath } };
  }

  const root = conversationWorkspaceRoot(context.conversationId, context.workspaceRoot);
  const resolved = resolveWorkspacePath(root, requestedPath);
  if (!resolved.ok) {
    return { ok: false, status: "failed", result: { error: resolved.error } };
  }

  return enqueueFileMutation(resolved.fullPath, async () => {
    try {
      const stat = await fs.stat(resolved.fullPath);
      if (!stat.isFile()) {
        return { ok: false, status: "failed", result: { error: "edit path is not a file.", path: resolved.relativePath } };
      }
      const buffer = await fs.readFile(resolved.fullPath);
      const hasBom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
      const original = buffer.toString("utf8").replace(/^\uFEFF/, "");
      const eol = original.includes("\r\n") ? "\r\n" : "\n";
      const ranges: EditRange[] = [];

      for (let index = 0; index < edits.length; index += 1) {
        const edit = edits[index] as { oldText: string; newText: string };
        const match = locateEditRange(original, edit.oldText);
        if (!match.ok) {
          return {
            ok: false,
            status: "failed",
            result: {
              error: match.error,
              path: resolved.relativePath,
              editIndex: index,
              details: match.details
            }
          };
        }
        ranges.push({
          oldText: original.slice(match.start, match.end),
          newText: normalizeReplacementEol(edit.newText, eol),
          start: match.start,
          end: match.end,
          usedFuzzyMatch: match.usedFuzzyMatch,
          normalizations: match.normalizations
        });
      }

      const overlap = firstOverlappingRange(ranges);
      if (overlap) {
        return {
          ok: false,
          status: "failed",
          result: {
            error: "edit ranges cannot overlap or nest.",
            path: resolved.relativePath,
            overlap
          }
        };
      }

      let next = original;
      for (const range of [...ranges].sort((a, b) => b.start - a.start)) {
        next = `${next.slice(0, range.start)}${range.newText}${next.slice(range.end)}`;
      }
      if (next === original) {
        return { ok: false, status: "failed", result: { error: "edit would not change the file.", path: resolved.relativePath } };
      }
      await fs.writeFile(resolved.fullPath, `${hasBom ? "\uFEFF" : ""}${next}`, "utf8");
      const firstChangedLine = lineNumberAtIndex(original, Math.min(...ranges.map((range) => range.start)));
      return {
        ok: true,
        status: "completed",
        result: {
          path: resolved.relativePath,
          root: resolved.root,
          conversationId: context.conversationId,
          bytesBefore: buffer.length,
          bytesAfter: Buffer.byteLength(`${hasBom ? "\uFEFF" : ""}${next}`, "utf8"),
          editCount: ranges.length,
          firstChangedLine,
          patch: buildPatch(resolved.relativePath, original, next),
          diff: ranges.map((range) => ({
            startLine: lineNumberAtIndex(original, range.start),
            oldText: range.oldText,
            newText: range.newText
          })),
          details: {
            mutationQueued: true,
            usedFuzzyMatch: ranges.some((range) => range.usedFuzzyMatch),
            normalizations: Array.from(new Set(ranges.flatMap((range) => range.normalizations))),
            preservedBom: hasBom,
            preservedLineEndings: eol === "\r\n" ? "CRLF" : "LF"
          }
        }
      };
    } catch (error) {
      return {
        ok: false,
        status: "failed",
        result: { error: error instanceof Error ? error.message : String(error), path: resolved.relativePath }
      };
    }
  });
}

export async function executeBash(argumentsJson: string, context: BuiltinToolContext): Promise<ToolExecutionResult> {
  const args = safeJson(argumentsJson) as { command?: unknown; timeout?: unknown };
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (!command) {
    return { ok: false, status: "failed", result: { error: "bash requires command." } };
  }
  const root = await ensureConversationWorkspaceRoot(context.conversationId, context.workspaceRoot);
  const requestedTimeout = typeof args.timeout === "number" && Number.isFinite(args.timeout)
    ? args.timeout
    : defaultCommandTimeoutSeconds;
  const timeoutSeconds = Math.max(1, Math.min(maxCommandTimeoutSeconds, Math.trunc(requestedTimeout)));
  const startedAt = new Date().toISOString();
  const result = await runShellCommand(command, root, timeoutSeconds, context.abortSignal);
  const truncated = await truncateCommandOutput(result.output, context.conversationId);
  return {
    ok: result.exitCode === 0 && !result.aborted,
    status: result.exitCode === 0 && !result.aborted ? "completed" : "failed",
    result: {
      command,
      cwd: ".",
      root,
      conversationId: context.conversationId,
      startedAt,
      completedAt: new Date().toISOString(),
      timeoutSeconds,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      aborted: result.aborted,
      output: truncated.output,
      truncated: truncated.truncated,
      fullOutputPath: truncated.fullOutputPath
    }
  };
}

export function conversationWorkspaceRoot(conversationId: string, configuredWorkspaceRoot?: string): string {
  const configuredRoot = configuredWorkspaceRoot?.trim() || process.env.ZLEAP_DEV_WORKSPACE_ROOT?.trim();
  if (configuredRoot) return path.resolve(configuredRoot);
  const base = process.env.ZLEAP_FILE_WORKSPACE_ROOT ?? defaultFileWorkspaceBaseRoot();
  return path.join(path.resolve(process.cwd(), base), safeConversationPathSegment(conversationId));
}

export function defaultFileWorkspaceBaseRoot(): string {
  const homeDir = os.homedir() || process.cwd();
  return path.join(homeDir, "Documents", "Zleap", "conversations");
}

async function ensureConversationWorkspaceRoot(conversationId: string, configuredWorkspaceRoot?: string): Promise<string> {
  const root = conversationWorkspaceRoot(conversationId, configuredWorkspaceRoot);
  await fs.mkdir(root, { recursive: true });
  return root;
}

async function resolveWorkspacePathForConversation(conversationId: string, requestedPath: string, configuredWorkspaceRoot?: string): Promise<ResolvedWorkspacePath> {
  const root = await ensureConversationWorkspaceRoot(conversationId, configuredWorkspaceRoot);
  const resolved = resolveWorkspacePath(root, requestedPath);
  if (!resolved.ok) return resolved;
  return {
    ...resolved,
    root
  };
}

function resolveWorkspacePath(root: string, requestedPath: string): ResolvedWorkspacePath {
  const normalizedRoot = path.resolve(root);
  const fullPath = path.resolve(normalizedRoot, requestedPath);
  const insideRoot = fullPath === normalizedRoot || fullPath.startsWith(normalizedRoot + path.sep);
  if (!insideRoot) {
    return {
      ok: false,
      error: `Path is outside the workspace root: ${requestedPath}`
    };
  }
  return {
    ok: true,
    root: normalizedRoot,
    fullPath,
    relativePath: path.relative(normalizedRoot, fullPath)
  };
}

function safeConversationPathSegment(conversationId: string): string {
  const hash = crypto.createHash("sha256").update(conversationId).digest("hex").slice(0, 8);
  const cleaned = (conversationId.trim() || "conversation")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^\.+/, "_")
    .slice(0, 80) || "conversation";
  return `${cleaned}-${hash}`;
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

async function readHeader(filePath: string): Promise<Buffer> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(512);
    const result = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
}

function detectImageMimeType(header: Buffer, filePath: string): string | undefined {
  if (header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return "image/jpeg";
  if (header.subarray(0, 6).toString("ascii") === "GIF87a" || header.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (header[0] === 0x42 && header[1] === 0x4d) return "image/bmp";
  const extension = path.extname(filePath).toLowerCase();
  const headText = header.toString("utf8").trimStart();
  if (extension === ".svg" || headText.startsWith("<svg") || headText.startsWith("<?xml")) return "image/svg+xml";
  return undefined;
}

async function readImageFile(filePath: string, mimeType: string, bytes: number, supportsImageContent: boolean): Promise<Record<string, unknown>> {
  const data = await fs.readFile(filePath);
  const pngDimensions = mimeType === "image/png" ? readPngDimensions(data) : null;
  const png = mimeType === "image/png" ? decodePng(data) : null;
  const originalWidth = png?.width ?? pngDimensions?.width;
  const originalHeight = png?.height ?? pngDimensions?.height;
  if (!supportsImageContent) {
    return {
      imageTooLarge: bytes > maxImageBytes || Boolean(originalWidth && originalHeight && (originalWidth > maxImageDimension || originalHeight > maxImageDimension)),
      resized: false,
      originalWidth,
      originalHeight,
      width: originalWidth,
      height: originalHeight,
      imageContentUnsupported: true,
      note: "Image MIME was detected, but inline image content was omitted because the active model does not support image content."
    };
  }
  const oversizedDimensions = Boolean(originalWidth && originalHeight && (originalWidth > maxImageDimension || originalHeight > maxImageDimension));
  if ((bytes > maxImageBytes || oversizedDimensions) && png) {
    const resized = resizePngForInline(png, bytes);
    if (resized) {
      const dataUrl = `data:image/png;base64,${resized.data.toString("base64")}`;
      return {
        imageTooLarge: false,
        resized: true,
        originalBytes: bytes,
        inlineBytes: resized.data.length,
        originalWidth,
        originalHeight,
        width: resized.width,
        height: resized.height,
        maxInlineImageBytes: maxImageBytes,
        maxInlineImageDimension: maxImageDimension,
        imageContent: {
          type: "input_image",
          image_url: {
            url: dataUrl
          }
        }
      };
    }
  }
  if (bytes > maxImageBytes || oversizedDimensions) {
    return {
      imageTooLarge: true,
      resized: false,
      maxInlineImageBytes: maxImageBytes,
      maxInlineImageDimension: maxImageDimension,
      originalWidth,
      originalHeight,
      note: mimeType === "image/png"
        ? "Image MIME was detected, but inline image content was omitted because the PNG could not be resized below the inline limit."
        : "Image MIME was detected, but inline image content was omitted because this image format cannot be resized without an image processing dependency."
    };
  }
  const dataUrl = `data:${mimeType};base64,${data.toString("base64")}`;
  return {
    imageTooLarge: false,
    resized: false,
    originalWidth,
    originalHeight,
    width: originalWidth,
    height: originalHeight,
    imageContent: {
      type: "input_image",
      image_url: {
        url: dataUrl
      }
    }
  };
}

function readPngDimensions(input: Buffer): { width: number; height: number } | null {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!input.subarray(0, signature.length).equals(signature) || input.length < 33) return null;
  const firstChunkType = input.subarray(12, 16).toString("ascii");
  if (firstChunkType !== "IHDR") return null;
  return {
    width: input.readUInt32BE(16),
    height: input.readUInt32BE(20)
  };
}

function resizePngForInline(image: PngImage, originalBytes: number): { data: Buffer; width: number; height: number } | null {
  let width = image.width;
  let height = image.height;
  if (width > maxImageDimension || height > maxImageDimension) {
    const scale = Math.min(maxImageDimension / width, maxImageDimension / height);
    width = Math.max(1, Math.floor(width * scale));
    height = Math.max(1, Math.floor(height * scale));
  }
  const byteScale = originalBytes > maxImageBytes ? Math.sqrt(maxImageBytes / originalBytes) : 1;
  if (byteScale < 1) {
    width = Math.max(1, Math.floor(width * byteScale));
    height = Math.max(1, Math.floor(height * byteScale));
  }

  while (width >= 1 && height >= 1) {
    const resizedRgba = resizeRgbaNearest(image, width, height);
    const encoded = encodePngRgba(width, height, resizedRgba);
    if (encoded.length <= maxImageBytes) {
      return { data: encoded, width, height };
    }
    if (width === 1 && height === 1) break;
    width = Math.max(1, Math.floor(width * 0.75));
    height = Math.max(1, Math.floor(height * 0.75));
  }
  return null;
}

function decodePng(input: Buffer): PngImage | null {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!input.subarray(0, signature.length).equals(signature)) return null;
  let offset = signature.length;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  try {
    while (offset + 8 <= input.length) {
      const length = input.readUInt32BE(offset);
      const type = input.subarray(offset + 4, offset + 8).toString("ascii");
      const dataStart = offset + 8;
      const dataEnd = dataStart + length;
      if (dataEnd + 4 > input.length) return null;
      const data = input.subarray(dataStart, dataEnd);
      if (type === "IHDR") {
        width = data.readUInt32BE(0);
        height = data.readUInt32BE(4);
        bitDepth = data[8];
        colorType = data[9];
        interlace = data[12];
      } else if (type === "IDAT") {
        idat.push(data);
      } else if (type === "IEND") {
        break;
      }
      offset = dataEnd + 4;
    }
    if (!width || !height || width * height > maxResizableImagePixels || bitDepth !== 8 || interlace !== 0 || ![0, 2, 4, 6].includes(colorType)) return null;
    const channels = pngColorChannels(colorType);
    const bytesPerPixel = channels;
    const rowBytes = width * channels;
    const inflated = inflateSync(Buffer.concat(idat));
    const expectedBytes = (rowBytes + 1) * height;
    if (inflated.length < expectedBytes) return null;
    const raw = Buffer.alloc(rowBytes * height);
    for (let y = 0; y < height; y += 1) {
      const sourceOffset = y * (rowBytes + 1);
      const filter = inflated[sourceOffset];
      const rowStart = y * rowBytes;
      const prevRowStart = y > 0 ? (y - 1) * rowBytes : -1;
      for (let x = 0; x < rowBytes; x += 1) {
        const source = inflated[sourceOffset + 1 + x];
        const left = x >= bytesPerPixel ? raw[rowStart + x - bytesPerPixel] : 0;
        const up = prevRowStart >= 0 ? raw[prevRowStart + x] : 0;
        const upLeft = prevRowStart >= 0 && x >= bytesPerPixel ? raw[prevRowStart + x - bytesPerPixel] : 0;
        raw[rowStart + x] = unfilterPngByte(filter, source, left, up, upLeft);
      }
    }
    return { width, height, rgba: pngRawToRgba(raw, width, height, colorType) };
  } catch {
    return null;
  }
}

function pngColorChannels(colorType: number): number {
  if (colorType === 0) return 1;
  if (colorType === 2) return 3;
  if (colorType === 4) return 2;
  return 4;
}

function unfilterPngByte(filter: number, source: number, left: number, up: number, upLeft: number): number {
  if (filter === 0) return source;
  if (filter === 1) return (source + left) & 0xff;
  if (filter === 2) return (source + up) & 0xff;
  if (filter === 3) return (source + Math.floor((left + up) / 2)) & 0xff;
  if (filter === 4) return (source + paethPredictor(left, up, upLeft)) & 0xff;
  throw new Error(`Unsupported PNG filter: ${filter}`);
}

function paethPredictor(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  if (upDistance <= upLeftDistance) return up;
  return upLeft;
}

function pngRawToRgba(raw: Buffer, width: number, height: number, colorType: number): Buffer {
  const rgba = Buffer.alloc(width * height * 4);
  const channels = pngColorChannels(colorType);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const source = pixel * channels;
    const target = pixel * 4;
    if (colorType === 0) {
      const gray = raw[source];
      rgba[target] = gray;
      rgba[target + 1] = gray;
      rgba[target + 2] = gray;
      rgba[target + 3] = 255;
    } else if (colorType === 2) {
      rgba[target] = raw[source];
      rgba[target + 1] = raw[source + 1];
      rgba[target + 2] = raw[source + 2];
      rgba[target + 3] = 255;
    } else if (colorType === 4) {
      const gray = raw[source];
      rgba[target] = gray;
      rgba[target + 1] = gray;
      rgba[target + 2] = gray;
      rgba[target + 3] = raw[source + 1];
    } else {
      rgba[target] = raw[source];
      rgba[target + 1] = raw[source + 1];
      rgba[target + 2] = raw[source + 2];
      rgba[target + 3] = raw[source + 3];
    }
  }
  return rgba;
}

function resizeRgbaNearest(image: PngImage, width: number, height: number): Buffer {
  const output = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(image.height - 1, Math.floor((y * image.height) / height));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(image.width - 1, Math.floor((x * image.width) / width));
      const sourceOffset = (sourceY * image.width + sourceX) * 4;
      const targetOffset = (y * width + x) * 4;
      image.rgba.copy(output, targetOffset, sourceOffset, sourceOffset + 4);
    }
  }
  return output;
}

function encodePngRgba(width: number, height: number, rgba: Buffer): Buffer {
  const rowBytes = width * 4;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const targetOffset = y * (rowBytes + 1);
    raw[targetOffset] = 0;
    rgba.copy(raw, targetOffset + 1, y * rowBytes, (y + 1) * rowBytes);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function splitLines(content: string): string[] {
  const lines = content.split(/\r\n|\n|\r/);
  if (lines.length === 1 && lines[0] === "") return [""];
  return lines;
}

function takeLineWindowWithinByteLimit(lines: string[], offset: number, limit: number, maxBytes: number): {
  startLine: number;
  endLine: number;
  content: string;
  truncated: boolean;
} {
  if (lines.length === 0) {
    return { startLine: 1, endLine: 0, content: "", truncated: false };
  }
  const startIndex = Math.max(0, offset - 1);
  const result: string[] = [];
  let usedBytes = 0;
  for (let index = startIndex; index < Math.min(lines.length, startIndex + limit); index += 1) {
    const candidate = result.length === 0 ? lines[index] : `\n${lines[index]}`;
    const bytes = Buffer.byteLength(candidate, "utf8");
    if (result.length > 0 && usedBytes + bytes > maxBytes) break;
    result.push(lines[index]);
    usedBytes += bytes;
    if (usedBytes >= maxBytes) break;
  }
  const endLine = result.length > 0 ? startIndex + result.length : offset - 1;
  return {
    startLine: offset,
    endLine,
    content: result.join("\n"),
    truncated: endLine < lines.length
  };
}

function enqueueFileMutation<T extends ToolExecutionResult>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(filePath) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  mutationQueues.set(filePath, next);
  return next.finally(() => {
    if (mutationQueues.get(filePath) === next) mutationQueues.delete(filePath);
  });
}

function locateEditRange(content: string, oldText: string): {
  ok: true;
  start: number;
  end: number;
  usedFuzzyMatch: boolean;
  normalizations: string[];
} | {
  ok: false;
  error: string;
  details?: Record<string, unknown>;
} {
  const exactMatches = findAllIndexes(content, oldText);
  if (exactMatches.length === 1) {
    return {
      ok: true,
      start: exactMatches[0],
      end: exactMatches[0] + oldText.length,
      usedFuzzyMatch: false,
      normalizations: []
    };
  }
  if (exactMatches.length > 1) {
    return {
      ok: false,
      error: "edit oldText must match exactly one location.",
      details: { matchCount: exactMatches.length, usedFuzzyMatch: false }
    };
  }

  const normalizedContent = normalizeForFuzzyMatch(content);
  const normalizedOldText = normalizeForFuzzyMatch(oldText);
  if (!normalizedOldText.text) {
    return {
      ok: false,
      error: "edit oldText cannot be empty after fuzzy normalization.",
      details: { usedFuzzyMatch: true }
    };
  }
  const fuzzyMatches = findAllIndexes(normalizedContent.text, normalizedOldText.text);
  if (fuzzyMatches.length !== 1) {
    return {
      ok: false,
      error: fuzzyMatches.length === 0 ? "edit oldText was not found." : "edit oldText fuzzy match must identify exactly one location.",
      details: {
        matchCount: fuzzyMatches.length,
        usedFuzzyMatch: true,
        normalizations: normalizedContent.normalizations
      }
    };
  }
  const normalizedStart = fuzzyMatches[0];
  const normalizedEnd = normalizedStart + normalizedOldText.text.length - 1;
  const originalStart = normalizedContent.map[normalizedStart];
  const originalEnd = originalEndForNormalizedIndex(content, normalizedContent.map[normalizedEnd]);
  return {
    ok: true,
    start: originalStart,
    end: originalEnd,
    usedFuzzyMatch: true,
    normalizations: normalizedContent.normalizations
  };
}

function findAllIndexes(haystack: string, needle: string): number[] {
  const indexes: number[] = [];
  let start = 0;
  while (start <= haystack.length) {
    const index = haystack.indexOf(needle, start);
    if (index < 0) break;
    indexes.push(index);
    start = index + Math.max(1, needle.length);
  }
  return indexes;
}

function normalizeForFuzzyMatch(value: string): { text: string; map: number[]; normalizations: string[] } {
  const parts: string[] = [];
  const map: number[] = [];
  const normalizations = new Set<string>();
  let lineStart = 0;
  while (lineStart < value.length) {
    let lineEnd = lineStart;
    while (lineEnd < value.length && value[lineEnd] !== "\n" && value[lineEnd] !== "\r") lineEnd += 1;
    let trimmedLineEnd = lineEnd;
    while (trimmedLineEnd > lineStart && isHorizontalWhitespace(value[trimmedLineEnd - 1])) {
      trimmedLineEnd -= 1;
      normalizations.add("trim_trailing_whitespace_per_line");
    }
    appendNormalizedSlice(value, lineStart, trimmedLineEnd, parts, map, normalizations);
    if (lineEnd < value.length) {
      parts.push("\n");
      map.push(lineEnd);
      normalizations.add("line_endings");
      lineStart = value[lineEnd] === "\r" && value[lineEnd + 1] === "\n" ? lineEnd + 2 : lineEnd + 1;
    } else {
      lineStart = lineEnd + 1;
    }
  }
  return { text: parts.join(""), map, normalizations: Array.from(normalizations) };
}

function appendNormalizedSlice(value: string, start: number, end: number, parts: string[], map: number[], normalizations: Set<string>): void {
  for (let index = start; index < end;) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    const original = String.fromCodePoint(codePoint);
    const normalized = normalizeCodePoint(original, normalizations);
    for (const char of normalized) {
      parts.push(char);
      map.push(index);
    }
    index += original.length;
  }
}

function normalizeCodePoint(value: string, normalizations: Set<string>): string {
  let next = value.normalize("NFKC");
  if (next !== value) normalizations.add("NFKC");
  if (/[\u2018\u2019\u201A\u201B]/u.test(next)) {
    next = "'";
    normalizations.add("smart_quotes");
  } else if (/[\u201C\u201D\u201E\u201F]/u.test(next)) {
    next = "\"";
    normalizations.add("smart_quotes");
  } else if (/[\u2010-\u2015\u2212]/u.test(next)) {
    next = "-";
    normalizations.add("unicode_dashes");
  } else if (/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/u.test(next)) {
    next = " ";
    normalizations.add("unicode_spaces");
  }
  return next;
}

function isHorizontalWhitespace(value: string): boolean {
  return value === " " || value === "\t" || /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/u.test(value);
}

function originalEndForNormalizedIndex(original: string, originalIndex: number): number {
  if (original[originalIndex] === "\r" && original[originalIndex + 1] === "\n") return originalIndex + 2;
  const codePoint = original.codePointAt(originalIndex);
  return originalIndex + (codePoint && codePoint > 0xffff ? 2 : 1);
}

function firstOverlappingRange(ranges: EditRange[]): { previous: { start: number; end: number }; next: { start: number; end: number } } | undefined {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const next = sorted[index];
    if (next.start < previous.end) {
      return {
        previous: { start: previous.start, end: previous.end },
        next: { start: next.start, end: next.end }
      };
    }
  }
  return undefined;
}

function normalizeReplacementEol(value: string, eol: string): string {
  if (eol === "\n") return value.replace(/\r\n|\r/g, "\n");
  return value.replace(/\r\n|\r|\n/g, "\n").replace(/\n/g, "\r\n");
}

function lineNumberAtIndex(content: string, index: number): number {
  let line = 1;
  for (let position = 0; position < Math.max(0, index); position += 1) {
    if (content[position] === "\n") line += 1;
  }
  return line;
}

function buildPatch(relativePath: string, before: string, after: string): string {
  const beforeLines = before.split(/\r\n|\n|\r/);
  const afterLines = after.split(/\r\n|\n|\r/);
  const first = firstDifferentLine(beforeLines, afterLines);
  const last = lastDifferentLine(beforeLines, afterLines);
  if (first < 0) return "";
  const contextStart = Math.max(0, first - 2);
  const beforeEnd = Math.min(beforeLines.length, last.before + 3);
  const afterEnd = Math.min(afterLines.length, last.after + 3);
  const lines = [
    `--- a/${relativePath}`,
    `+++ b/${relativePath}`,
    `@@ -${contextStart + 1},${beforeEnd - contextStart} +${contextStart + 1},${afterEnd - contextStart} @@`
  ];
  for (let index = contextStart; index < beforeEnd; index += 1) {
    if (index < first || index > last.before) lines.push(` ${beforeLines[index] ?? ""}`);
    else lines.push(`-${beforeLines[index] ?? ""}`);
  }
  for (let index = contextStart; index < afterEnd; index += 1) {
    if (index >= first && index <= last.after) lines.push(`+${afterLines[index] ?? ""}`);
  }
  return lines.join("\n");
}

function firstDifferentLine(before: string[], after: string[]): number {
  const limit = Math.max(before.length, after.length);
  for (let index = 0; index < limit; index += 1) {
    if ((before[index] ?? undefined) !== (after[index] ?? undefined)) return index;
  }
  return -1;
}

function lastDifferentLine(before: string[], after: string[]): { before: number; after: number } {
  let beforeIndex = before.length - 1;
  let afterIndex = after.length - 1;
  while (beforeIndex >= 0 && afterIndex >= 0 && before[beforeIndex] === after[afterIndex]) {
    beforeIndex -= 1;
    afterIndex -= 1;
  }
  return { before: Math.max(0, beforeIndex), after: Math.max(0, afterIndex) };
}

function runShellCommand(command: string, cwd: string, timeoutSeconds: number, abortSignal?: AbortSignal): Promise<{
  exitCode: number;
  signal: NodeJS.Signals | null;
  output: string;
  timedOut: boolean;
  aborted: boolean;
}> {
  return new Promise((resolve) => {
    if (abortSignal?.aborted) {
      resolve({ exitCode: 1, signal: null, output: "Command aborted before start.", timedOut: false, aborted: true });
      return;
    }
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let output = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
    };
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
    };
    const finish = (result: { exitCode: number; signal: NodeJS.Signals | null; output: string; timedOut: boolean; aborted: boolean }) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const onAbort = () => {
      aborted = true;
      killProcessTree(child.pid);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
    }, timeoutSeconds * 1000);
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => {
      finish({ exitCode: 1, signal: null, output: `${output}${error.message}`, timedOut, aborted });
    });
    child.on("close", (code, signal) => {
      finish({ exitCode: code ?? (signal || aborted ? 1 : 0), signal, output, timedOut, aborted });
    });
  });
}

function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform !== "win32") {
      process.kill(-pid, "SIGTERM");
      setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // Process already exited.
        }
      }, 1000).unref();
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process already exited.
    }
  }
}

async function truncateCommandOutput(output: string, conversationId: string): Promise<{
  output: string;
  truncated: boolean;
  fullOutputPath?: string;
}> {
  const byLines = output.split(/\r\n|\n|\r/);
  let truncated = false;
  let next = output;
  if (byLines.length > maxCommandOutputLines) {
    next = byLines.slice(-maxCommandOutputLines).join("\n");
    truncated = true;
  }
  const bytes = Buffer.byteLength(next, "utf8");
  if (bytes > maxCommandOutputBytes) {
    const buffer = Buffer.from(next, "utf8");
    next = buffer.subarray(buffer.length - maxCommandOutputBytes).toString("utf8");
    truncated = true;
  }
  if (!truncated) return { output: next, truncated: false };
  const dir = path.join(os.tmpdir(), "zleap-tool-output");
  await fs.mkdir(dir, { recursive: true });
  const fullOutputPath = path.join(dir, `${safeConversationPathSegment(conversationId)}-${Date.now()}.log`);
  await fs.writeFile(fullOutputPath, output, "utf8");
  return { output: next, truncated: true, fullOutputPath };
}
