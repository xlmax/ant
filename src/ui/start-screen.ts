import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ModelSettings } from "../app/configuration.js";
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
}): string {
  const model = `${options.modelSettings.provider}/${options.modelSettings.id}`;
  const thinking = options.modelSettings.thinking.enabled
    ? `think: ${options.modelSettings.thinking.effort}`
    : "think: off";
  const commands = TOP_COMMANDS.map((command) => ansi.cyan(command)).join(ansi.dim("  "));

  const lines: string[] = [
    "",
    ...LOGO.map((line) => " " + ansi.bold(ansi.terracotta(line))),
    "",
    " " + ansi.dim(`Agentic Native Tool · v${VERSION}`),
    "",
    " " + ansi.dim("●") + " " + model + " " + ansi.dim(`· ${thinking}`),
    " " + ansi.dim("▸") + " " + ansi.dim(normalizePath(options.workspace)),
  ];

  if (options.branch !== undefined) {
    lines.push(" " + ansi.dim("└") + " " + ansi.dim(options.branch));
  }

  lines.push("", " " + ansi.dim("›") + " " + commands);

  return lines.join("\n");
}
