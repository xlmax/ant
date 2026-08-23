export interface ReplCommand {
  name: string;
  usage: string;
  description: string;
}

export type CommandAction =
  | { type: "help"; command?: ReplCommand }
  | { type: "new" }
  | { type: "session" }
  | { type: "clear" }
  | { type: "reasoning"; enabled?: boolean }
  | { type: "exit" }
  | { type: "error"; message: string };

const commands: readonly ReplCommand[] = [
  {
    name: "help",
    usage: "/help [команда]",
    description: "Показать список команд или справку по одной команде.",
  },
  {
    name: "new",
    usage: "/new",
    description: "Начать новую сессию следующим сообщением.",
  },
  {
    name: "session",
    usage: "/session",
    description: "Показать идентификатор и путь текущей сессии.",
  },
  {
    name: "clear",
    usage: "/clear",
    description: "Очистить экран терминала.",
  },
  {
    name: "reasoning",
    usage: "/reasoning [on|off]",
    description: "Показать или скрыть блок рассуждений модели.",
  },
  {
    name: "exit",
    usage: "/exit",
    description: "Выйти из интерактивного режима.",
  },
];

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = [leftIndex + 1];

    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      current.push(
        Math.min(
          (previous[rightIndex] ?? 0) + 1,
          (current[rightIndex] ?? 0) + 1,
          (previous[rightIndex] ?? 0) +
            (left[leftIndex] === right[rightIndex] ? 0 : 1),
        ),
      );
    }

    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length] ?? Number.POSITIVE_INFINITY;
}

function findCommand(name: string): ReplCommand | undefined {
  return commands.find((command) => command.name === name);
}

function suggestion(name: string): ReplCommand | undefined {
  const candidate = commands
    .map((command) => ({ command, distance: editDistance(name, command.name) }))
    .sort((left, right) => left.distance - right.distance)[0];

  return candidate && candidate.distance <= 2 ? candidate.command : undefined;
}

export function getReplCommands(): readonly ReplCommand[] {
  return commands;
}

export function parseReplCommand(input: string): CommandAction | undefined {
  if (!input.startsWith("/") || input.includes("\n")) {
    return undefined;
  }

  const [name, ...args] = input.slice(1).trim().split(/\s+/u);

  if (!name) {
    return { type: "error", message: "Введите /help, чтобы увидеть команды." };
  }

  const command = findCommand(name);

  if (!command) {
    const similar = suggestion(name);
    return {
      type: "error",
      message: similar
        ? `Неизвестная команда: /${name}. Возможно, вы имели в виду /${similar.name}.`
        : `Неизвестная команда: /${name}. Введите /help, чтобы увидеть команды.`,
    };
  }

  switch (command.name) {
    case "help": {
      const requestedName = args[0];

      if (args.length > 1) {
        return { type: "error", message: "Использование: /help [команда]" };
      }

      if (!requestedName) {
        return { type: "help" };
      }

      const requestedCommand = findCommand(requestedName.replace(/^\//u, ""));
      return requestedCommand
        ? { type: "help", command: requestedCommand }
        : {
            type: "error",
            message: `Команда /${requestedName.replace(/^\//u, "")} не найдена.`,
          };
    }

    case "reasoning":
      if (args.length === 0) {
        return { type: "reasoning" };
      }
      if (args.length === 1 && (args[0] === "on" || args[0] === "off")) {
        return { type: "reasoning", enabled: args[0] === "on" };
      }
      return { type: "error", message: "Использование: /reasoning [on|off]" };

    case "new":
    case "session":
    case "clear":
    case "exit":
      return args.length === 0
        ? { type: command.name }
        : { type: "error", message: `Использование: ${command.usage}` };
  }
}
