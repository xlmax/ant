import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

import type { ImageAttachment } from "../core/agent.js";
import { writeFileAtomically } from "../fs/atomic-write.js";
import type { Tool, ToolExecutionResult } from "../core/environment.js";
import { parsePathInput, resolveToolPath } from "./path-utils.js";

const MAX_BYTES = 50 * 1024;
const MAX_LINES = 2_000;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

interface ReadInput {
  path: string;
  offset?: number;
  limit?: number;
}

export interface ImageReadResult {
  path: string;
  kind: "image";
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  bytes: number;
}

export interface ReadResult {
  path: string;
  content: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  truncated: boolean;
  nextOffset?: number;
}

function parsePositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

function parseInput(input: unknown): ReadInput {
  const path = parsePathInput(input, "read");

  if (typeof input !== "object" || input === null) {
    throw new Error("read expects an object");
  }

  const source = input as Record<string, unknown>;
  const offset = parsePositiveInteger(source.offset, "read offset");
  const limit = parsePositiveInteger(source.limit, "read limit");

  return {
    path,
    ...(offset === undefined ? {} : { offset }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function imageMediaType(header: Buffer): ImageReadResult["mediaType"] | undefined {
  if (header.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return "image/png";
  }
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    header.subarray(0, 6).toString("ascii") === "GIF87a" ||
    header.subarray(0, 6).toString("ascii") === "GIF89a"
  ) {
    return "image/gif";
  }
  if (
    header.subarray(0, 4).toString("ascii") === "RIFF" &&
    header.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

function imageExtension(mediaType: ImageReadResult["mediaType"]): string {
  return mediaType.slice("image/".length).replace("jpeg", "jpg");
}

async function cacheImage(
  image: ImageReadResult,
  workspaceDirectory: string,
): Promise<ImageAttachment> {
  const content = await readFile(image.path);
  if (content.length > MAX_IMAGE_BYTES) {
    throw new Error(`Image ${image.path} exceeds the 32 MiB vision limit`);
  }
  const hash = createHash("sha256").update(content).digest("hex");
  const directory = join(workspaceDirectory, ".ant", "attachments");
  const path = join(directory, `${hash}.${imageExtension(image.mediaType)}`);
  await mkdir(directory, { recursive: true });
  await writeFileAtomically(path, content);
  return { type: "image", path, mediaType: image.mediaType, bytes: content.length };
}

async function detectImage(path: string): Promise<ImageReadResult | undefined> {
  const metadata = await stat(path);
  if (!metadata.isFile()) {
    return undefined;
  }
  const file = await open(path, "r");
  const header = Buffer.alloc(12);
  try {
    await file.read(header, 0, header.length, 0);
  } finally {
    await file.close();
  }
  const mediaType = imageMediaType(header);
  if (!mediaType) {
    return undefined;
  }
  if (metadata.size > MAX_IMAGE_BYTES) {
    throw new Error(`Image ${path} exceeds the 32 MiB vision limit`);
  }
  return { path, kind: "image", mediaType, bytes: metadata.size };
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0 || value === "") {
    return "";
  }

  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) {
    return value;
  }

  let end = maxBytes;
  while (end > 0 && (bytes[end] ?? 0) >> 6 === 0b10) {
    end -= 1;
  }
  return bytes.subarray(0, end).toString("utf8");
}

interface StreamedTextResult {
  content: string;
  totalLines: number;
  endLine: number;
  truncatedByLimit: boolean;
}

async function readTextFile(
  path: string,
  offset: number,
  limit: number | undefined,
  signal: AbortSignal | undefined,
): Promise<StreamedTextResult> {
  const stream = createReadStream(path);
  const decoder = new StringDecoder("utf8");
  const lines: string[] = [];
  let bytes = 0;
  let lineNumber = 1;
  let totalLines = 0;
  let endLine = offset - 1;
  let sawData = false;
  let truncatedByLimit = false;
  let includeLine = false;
  let line = "";
  let lineBytes = 0;

  const isRequestedLine = (): boolean =>
    lineNumber >= offset && (limit === undefined || lineNumber < offset + limit);

  const startLine = (): void => {
    line = "";
    lineBytes = 0;
    const separatorBytes = lines.length === 0 ? 0 : 1;
    includeLine =
      isRequestedLine() && lines.length < MAX_LINES && bytes + separatorBytes <= MAX_BYTES;

    if (isRequestedLine() && !includeLine) {
      truncatedByLimit = true;
    }
  };

  const appendLinePart = (part: string): void => {
    if (!includeLine || part === "") {
      return;
    }

    const separatorBytes = lines.length === 0 ? 0 : 1;
    const remainingBytes = MAX_BYTES - bytes - separatorBytes - lineBytes;
    const prefix = truncateUtf8(part, remainingBytes);
    line += prefix;
    lineBytes += Buffer.byteLength(prefix, "utf8");
    if (prefix.length !== part.length) {
      truncatedByLimit = true;
    }
  };

  const finishLine = (): void => {
    if (isRequestedLine() && includeLine) {
      const separatorBytes = lines.length === 0 ? 0 : 1;
      lines.push(line);
      bytes += separatorBytes + lineBytes;
      endLine = lineNumber;
    }
    totalLines += 1;
    lineNumber += 1;
    startLine();
  };

  startLine();
  const abort = (): void => {
    stream.destroy(signal?.reason instanceof Error ? signal.reason : undefined);
  };
  signal?.addEventListener("abort", abort, { once: true });

  try {
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      sawData = true;
      const text = decoder.write(chunk as Buffer);
      let start = 0;
      let newline = text.indexOf("\n");

      while (newline !== -1) {
        appendLinePart(text.slice(start, newline));
        finishLine();
        start = newline + 1;
        newline = text.indexOf("\n", start);
      }
      appendLinePart(text.slice(start));
    }

    const remaining = decoder.end();
    if (remaining !== "") {
      sawData = true;
      appendLinePart(remaining);
    }
  } finally {
    signal?.removeEventListener("abort", abort);
  }

  if (sawData) {
    finishLine();
  }

  return {
    content: lines.join("\n"),
    totalLines,
    endLine,
    truncatedByLimit,
  };
}

export function createReadTool(workspaceDirectory: string): Tool {
  return {
    spec: {
      name: "read",
      description:
        "Read a text file or supported image (JPEG, PNG, GIF, WebP). Text output is truncated to 2,000 lines or 50 KiB; use offset and limit to continue reading large files. Image output is attached for vision-capable models.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: {
            type: "integer",
            description: "Line number to start reading from (1-indexed)",
          },
          limit: {
            type: "integer",
            description: "Maximum number of lines to read",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },

    async execute(input: unknown, signal?: AbortSignal): Promise<ReadResult | ToolExecutionResult> {
      signal?.throwIfAborted();
      const { path, offset = 1, limit } = parseInput(input);
      const resolvedPath = resolveToolPath(path, workspaceDirectory);
      const image = await detectImage(resolvedPath);
      signal?.throwIfAborted();

      if (image) {
        const attachment = await cacheImage(image, workspaceDirectory);
        const result: ToolExecutionResult = {
          kind: "tool-result",
          value: image,
          attachments: [attachment],
        };
        return result;
      }

      const text = await readTextFile(resolvedPath, offset, limit, signal);
      signal?.throwIfAborted();

      if (text.totalLines === 0) {
        return {
          path,
          content: "",
          totalLines: 0,
          startLine: 0,
          endLine: 0,
          truncated: false,
        };
      }

      if (offset > text.totalLines) {
        throw new Error(
          `read offset ${offset} is beyond the end of file (${text.totalLines} lines total)`,
        );
      }

      const hasMoreLines = text.endLine < text.totalLines;
      const truncated = text.truncatedByLimit || hasMoreLines;

      return {
        path,
        content: text.content,
        totalLines: text.totalLines,
        startLine: offset,
        endLine: text.endLine,
        truncated,
        ...(truncated ? { nextOffset: text.endLine + 1 } : {}),
      };
    },
  };
}
