import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ModelSettings } from "../config/settings.js";
import { VERSION } from "../version.js";
import { ansi } from "./ansi.js";
const execFileAsync = promisify(execFile);

const LOGO = [
  " █████╗ ███╗   ██╗████████╗",
  "██╔══██╗████╗  ██║╚══██╔══╝",
  "███████║██╔██╗ ██║   ██║",
  "██╔══██║██║╚██╗██║   ██║",
  "██║  ██║██║ ╚████║   ██║",
  "╚═╝  ╚═╝╚═╝  ╚═══╝   ╚═╝",
];

const TOP_COMMANDS = ["/model", "/think", "/context", "/compact", "/new", "/exit"];

function normalizePath(workspace: string): string {
  return workspace.replaceAll("\\", "/");
}

function formatModelShort(settings: ModelSettings): string {
  const thinking = settings.thinking.enabled
    ? `thinking ${settings.thinking.effort}`
    : "thinking off";
  return `${settings.provider}/${settings.id} · ${thinking}`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}k`;
  }
  return String(tokens);
}

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

export async function resolveGitBranch(workspace: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["branch", "--show-current"], {
      cwd: workspace,
      encoding: "utf8",
    });
    const branch = stdout.trim();
    return branch === "" ? undefined : branch;
  } catch {
    return undefined;
  }
}

export function formatStartScreen(options: {
  workspace: string;
  branch: string | undefined;
  modelSettings: ModelSettings;
  sessionUsage?: SessionUsage;
}): string {
  const location =
    options.branch === undefined
      ? normalizePath(options.workspace)
      : `${normalizePath(options.workspace)} · ${options.branch}`;
  const commands = TOP_COMMANDS.map((command) => ansi.cyan(command)).join(ansi.dim("  "));
  const usage =
    options.sessionUsage === undefined
      ? []
      : [
          ansi.dim(
            `сессия: ↑${formatTokens(options.sessionUsage.inputTokens)} ↓${formatTokens(
              options.sessionUsage.outputTokens,
            )} · ${options.sessionUsage.calls} запр.`,
          ),
        ];

  return [
    "",
    ...LOGO.map((line) => ansi.bold(ansi.terracotta(line))),
    "",
    ansi.dim(`ant ${VERSION}`),
    ansi.dim(formatModelShort(options.modelSettings)),
    ...usage,
    ansi.dim(location),
    "",
    commands,
  ].join("\n");
}
