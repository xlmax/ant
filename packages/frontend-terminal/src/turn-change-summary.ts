import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { promisify } from "node:util";

import type { AgentEvent, AgentObserver, Observation, ToolCall } from "@ant/core";

const execFileAsync = promisify(execFile);

interface GitEntry {
  status: string;
  fingerprint?: string;
}

interface GitSnapshot {
  available: boolean;
  entries: Map<string, GitEntry>;
}

export interface TurnChangeSummary {
  commands: string[];
  changedFiles: { path: string; status: string }[];
  toolWrittenFiles: string[];
  diffStat?: string;
  gitAvailable: boolean;
  baselineDirty: boolean;
}

function stringProperty(value: unknown, property: string): string | undefined {
  if (typeof value !== "object" || value === null || !(property in value)) return undefined;
  const candidate = (value as Record<string, unknown>)[property];
  return typeof candidate === "string" ? candidate : undefined;
}

function successful(observation: Observation | undefined): boolean {
  return observation?.ok === true;
}

async function fingerprint(workspace: string, path: string): Promise<string | undefined> {
  try {
    const absolutePath = `${workspace}/${path}`;
    const metadata = await lstat(absolutePath);
    const content = metadata.isSymbolicLink()
      ? Buffer.from(await readlink(absolutePath), "utf8")
      : await readFile(absolutePath);
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return undefined;
  }
}

function parsePorcelain(output: string): Map<string, string> {
  const fields = output.split("\0");
  const entries = new Map<string, string>();

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field || field.length < 4) continue;
    const status = field.slice(0, 2);
    const path = field.slice(3);
    entries.set(path, status);
    if (status.includes("R") || status.includes("C")) index += 1;
  }

  return entries;
}

async function gitSnapshot(workspace: string): Promise<GitSnapshot> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { cwd: workspace, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    );
    const statuses = parsePorcelain(stdout);
    const entries = new Map<string, GitEntry>();
    await Promise.all(
      [...statuses].map(async ([path, status]) => {
        const contentFingerprint = await fingerprint(workspace, path);
        entries.set(path, {
          status,
          ...(contentFingerprint === undefined ? {} : { fingerprint: contentFingerprint }),
        });
      }),
    );
    return { available: true, entries };
  } catch {
    return { available: false, entries: new Map() };
  }
}

async function gitDiffStat(workspace: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--stat", "--", "."], {
      cwd: workspace,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function changedSince(before: GitSnapshot, after: GitSnapshot): { path: string; status: string }[] {
  const paths = new Set([...before.entries.keys(), ...after.entries.keys()]);
  return [...paths]
    .filter((path) => {
      const previous = before.entries.get(path);
      const current = after.entries.get(path);
      return previous?.status !== current?.status || previous?.fingerprint !== current?.fingerprint;
    })
    .map((path) => ({ path, status: after.entries.get(path)?.status ?? "  " }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export class TurnChangeTracker implements AgentObserver {
  readonly #workspace: string;
  readonly #commands: string[] = [];
  readonly #writeCalls = new Map<string, ToolCall>();
  readonly #toolWrittenFiles = new Set<string>();
  #before: GitSnapshot | undefined;

  constructor(workspace: string) {
    this.#workspace = workspace;
  }

  async begin(): Promise<void> {
    this.#commands.length = 0;
    this.#writeCalls.clear();
    this.#toolWrittenFiles.clear();
    this.#before = await gitSnapshot(this.#workspace);
  }

  onEvent(event: AgentEvent): void {
    if (event.type === "tool.started") {
      if (event.call.name === "bash") {
        const command = stringProperty(event.call.input, "command");
        if (command) this.#commands.push(command);
      }
      if (event.call.name === "write" || event.call.name === "edit") {
        this.#writeCalls.set(event.call.id, event.call);
      }
      return;
    }

    if (event.type !== "tool.finished" || !successful(event.observation)) return;
    const call = this.#writeCalls.get(event.call.id);
    const path = call && stringProperty(call.input, "path");
    if (path) this.#toolWrittenFiles.add(path);
  }

  async finish(): Promise<TurnChangeSummary> {
    const before = this.#before ?? { available: false, entries: new Map() };
    const after = await gitSnapshot(this.#workspace);
    const baselineDirty = before.entries.size > 0;
    const diffStat =
      before.available && after.available && !baselineDirty
        ? await gitDiffStat(this.#workspace)
        : undefined;
    return {
      commands: [...this.#commands],
      changedFiles: before.available && after.available ? changedSince(before, after) : [],
      toolWrittenFiles: [...this.#toolWrittenFiles].sort(),
      ...(diffStat === undefined ? {} : { diffStat }),
      gitAvailable: before.available && after.available,
      baselineDirty,
    };
  }
}

export function formatTurnChangeSummary(summary: TurnChangeSummary): string | undefined {
  const writtenOutsideGit = summary.toolWrittenFiles.filter(
    (path) => !summary.changedFiles.some((file) => file.path === path),
  );
  if (
    summary.commands.length === 0 &&
    summary.changedFiles.length === 0 &&
    writtenOutsideGit.length === 0
  ) {
    return undefined;
  }

  const lines = ["Изменения за ход"];
  if (summary.commands.length > 0) {
    lines.push("Команды:", ...summary.commands.map((command) => `  $ ${command}`));
  }
  if (summary.changedFiles.length > 0) {
    lines.push(
      "Файлы:",
      ...summary.changedFiles.map(({ path, status }) => `  ${status.trim() || "✓"} ${path}`),
    );
  }
  if (writtenOutsideGit.length > 0) {
    lines.push("Записаны вне Git-отчёта:", ...writtenOutsideGit.map((path) => `  ${path}`));
  }
  if (summary.diffStat) lines.push("Diff stat:", summary.diffStat);
  if (summary.baselineDirty && summary.gitAvailable && summary.changedFiles.length > 0) {
    lines.push("Примечание: старые изменения рабочего дерева исключены по снимку состояния.");
  }
  return lines.join("\n");
}
