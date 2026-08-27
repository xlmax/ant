import type { AntApplicationRunOptions } from "@ant/app";
import type { SessionList } from "@ant/app";
import { cliHelp, parseCliOptions } from "./options.js";

export interface CliApplication {
  run(options: AntApplicationRunOptions): Promise<void>;
  listSessions(workspace: string): Promise<SessionList>;
}

export interface CliOutput {
  log(message: string): void;
  error(message: string): void;
}

export interface CliAdapterModules {
  application: CliApplication;
  version: string;
  applyEnvironment(workspace: string): void;
  output: CliOutput;
}

export interface CliRunOptions {
  workspace: string;
  args: readonly string[];
}

function formatSessionTask(task: string): string {
  const singleLine = task.replace(/\s+/gu, " ").trim();
  const characters = Array.from(singleLine);
  return characters.length <= 80 ? singleLine : `${characters.slice(0, 77).join("")}…`;
}

function printSessionList(list: SessionList, output: CliOutput): void {
  for (const warning of list.warnings) output.error(`Предупреждение: ${warning}`);
  if (list.sessions.length === 0) {
    output.log("Сохранённых сессий нет.");
    return;
  }

  output.log("Сохранённые сессии:");
  for (const session of list.sessions) {
    output.log(`${session.id} · ${session.updatedAt} · ${formatSessionTask(session.task)}`);
  }
}

/** Maps terminal CLI input onto the application API. */
export async function runCli(runOptions: CliRunOptions, modules: CliAdapterModules): Promise<void> {
  modules.applyEnvironment(runOptions.workspace);
  const options = parseCliOptions(runOptions.args);

  switch (options.action) {
    case "help":
      modules.output.log(cliHelp());
      return;

    case "version":
      modules.output.log(modules.version);
      return;

    case "list-sessions":
      printSessionList(
        await modules.application.listSessions(runOptions.workspace),
        modules.output,
      );
      return;

    case "run":
      await modules.application.run({
        workspace: runOptions.workspace,
        task: options.task,
        ...(options.resume === undefined ? {} : { resume: options.resume }),
        ...(options.continueLatest ? { continueLatest: true } : {}),
      });
  }
}
