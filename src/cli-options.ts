export interface CliOptions {
  task: string;
  action: "run" | "help" | "list-sessions";
  resume?: string;
  continueLatest: boolean;
}

export function parseCliOptions(args: readonly string[]): CliOptions {
  const taskParts: string[] = [];
  let action: CliOptions["action"] = "run";
  let resume: string | undefined;
  let continueLatest = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    switch (argument) {
      case "-h":
        action = "help";
        continue;

      case "-r":
        action = "list-sessions";
        continue;

      case "-c":
        if (continueLatest || resume !== undefined) {
          throw new Error("Укажите только один способ выбрать сессию: -c или -s <id>");
        }
        continueLatest = true;
        continue;

      case "-s": {
        if (continueLatest || resume !== undefined) {
          throw new Error("Укажите только один способ выбрать сессию: -c или -s <id>");
        }
        const sessionId = args[index + 1];
        if (!sessionId || sessionId.startsWith("-")) {
          throw new Error("Для -s нужно указать идентификатор сессии");
        }
        resume = sessionId;
        index += 1;
        continue;
      }

      default:
        if (argument !== undefined) {
          taskParts.push(argument);
        }
    }
  }

  const task = taskParts.join(" ").trim();
  if (action === "list-sessions" && (task || resume || continueLatest)) {
    throw new Error("Ключ -r нельзя сочетать с задачей или выбором сессии");
  }

  return {
    task,
    action,
    continueLatest,
    ...(resume === undefined ? {} : { resume }),
  };
}

export function cliHelp(): string {
  return [
    "Использование: ant [ключ] [задача]",
    "",
    "Ключи:",
    "  -h       показать эту справку",
    "  -r       показать сохранённые сессии и выйти",
    "  -c       продолжить последнюю сессию",
    "  -s <id>  продолжить указанную сессию",
  ].join("\n");
}
