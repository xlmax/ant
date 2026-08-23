import { readFile } from "node:fs/promises";

import type { Tool } from "../core/environment.js";
import { writeFileAtomically } from "../fs/atomic-write.js";
import { parsePathInput, resolveToolPath } from "./path-utils.js";

interface Edit {
  oldText: string;
  newText: string;
}

interface Replacement extends Edit {
  index: number;
}

function parseInput(input: unknown): { path: string; edits: Edit[] } {
  const path = parsePathInput(input, "edit");

  if (
    typeof input !== "object" ||
    input === null ||
    !("edits" in input) ||
    !Array.isArray(input.edits) ||
    input.edits.length === 0
  ) {
    throw new Error("edit expects a non-empty array property 'edits'");
  }

  const edits = input.edits.map((edit, index): Edit => {
    if (
      typeof edit !== "object" ||
      edit === null ||
      !("oldText" in edit) ||
      !("newText" in edit) ||
      typeof edit.oldText !== "string" ||
      typeof edit.newText !== "string" ||
      edit.oldText === ""
    ) {
      throw new Error(
        `edit edits[${index}] must contain a non-empty string oldText and a string newText`,
      );
    }

    return { oldText: edit.oldText, newText: edit.newText };
  });

  return { path, edits };
}

function findUniqueReplacement(content: string, edit: Edit, editIndex: number): Replacement {
  const index = content.indexOf(edit.oldText);

  if (index === -1) {
    throw new Error(
      `Could not find edits[${editIndex}].oldText. It must match exactly including whitespace and newlines.`,
    );
  }

  if (content.indexOf(edit.oldText, index + 1) !== -1) {
    throw new Error(
      `Found multiple occurrences of edits[${editIndex}].oldText. Provide more context so it is unique.`,
    );
  }

  return { ...edit, index };
}

function applyEdits(content: string, edits: readonly Edit[]): string {
  const replacements = edits
    .map((edit, index) => findUniqueReplacement(content, edit, index))
    .sort((left, right) => left.index - right.index);

  for (let index = 1; index < replacements.length; index += 1) {
    const previous = replacements[index - 1];
    const current = replacements[index];

    if (previous === undefined || current === undefined) {
      continue;
    }

    if (previous.index + previous.oldText.length > current.index) {
      throw new Error("edit replacements overlap; merge them into one edit");
    }
  }

  return replacements
    .slice()
    .reverse()
    .reduce(
      (updated, replacement) =>
        updated.slice(0, replacement.index) +
        replacement.newText +
        updated.slice(replacement.index + replacement.oldText.length),
      content,
    );
}

export function createEditTool(workspaceDirectory: string): Tool {
  return {
    spec: {
      name: "edit",
      description:
        "Make precise text replacements in an existing file. Every oldText must match a unique, non-overlapping region of the original file.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          edits: {
            type: "array",
            items: {
              type: "object",
              properties: {
                oldText: { type: "string" },
                newText: { type: "string" },
              },
              required: ["oldText", "newText"],
              additionalProperties: false,
            },
          },
        },
        required: ["path", "edits"],
        additionalProperties: false,
      },
    },

    async execute(input: unknown, signal?: AbortSignal): Promise<unknown> {
      signal?.throwIfAborted();
      const { path, edits } = parseInput(input);
      const target = resolveToolPath(path, workspaceDirectory);
      const originalContent = await readFile(target, "utf8");
      const updatedContent = applyEdits(originalContent, edits);
      signal?.throwIfAborted();

      await writeFileAtomically(target, updatedContent);
      signal?.throwIfAborted();

      return {
        path,
        editsApplied: edits.length,
        bytesWritten: Buffer.byteLength(updatedContent, "utf8"),
      };
    },
  };
}
