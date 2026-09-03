import type {
  ProcessControl,
  TerminalPort,
  TerminalRenderer,
  UpdateService,
} from "./presentation-ports.js";
import type { ReplOptions } from "./repl.js";

export interface CommandDescriptor {
  readonly name: string;
  readonly usage: string;
  readonly description: string;
  readonly aliases?: readonly string[];
}

export interface CommandContext {
  readonly options: ReplOptions;
  readonly renderer: TerminalRenderer;
  readonly terminal: TerminalPort;
  readonly process: ProcessControl;
  readonly updates: UpdateService;
}

export type CommandResult = "continue" | "exit";

export interface CommandModule<T = unknown> {
  readonly descriptor: CommandDescriptor;
  parse(args: readonly string[], registry: CommandRegistry): T;
  handle(input: T, context: CommandContext): Promise<CommandResult> | CommandResult;
}

export interface CommandInvocation {
  readonly module: CommandModule;
  readonly input: unknown;
}

export type ParsedCommand = CommandInvocation | { readonly error: string } | undefined;

export class CommandUsageError extends Error {}

const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9-]*$/u;

function isValidCommandToken(value: string): boolean {
  return value === "?" || COMMAND_NAME_PATTERN.test(value);
}

function formatAliasList(aliases: readonly string[]): string {
  return aliases.length === 0 ? "" : ` (${aliases.join(", ")})`;
}

export function formatCommandUsage(descriptor: CommandDescriptor): string {
  const aliases = descriptor.aliases ?? [];
  if (aliases.length === 0) return descriptor.usage;
  const commandPrefix = `/${descriptor.name}`;
  if (!descriptor.usage.startsWith(commandPrefix)) {
    return `${descriptor.usage}${formatAliasList(aliases)}`;
  }
  return `${commandPrefix}${formatAliasList(aliases)}${descriptor.usage.slice(commandPrefix.length)}`;
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = [leftIndex + 1];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      current.push(
        Math.min(
          (previous[rightIndex] ?? 0) + 1,
          (current[rightIndex] ?? 0) + 1,
          (previous[rightIndex] ?? 0) + (left[leftIndex] === right[rightIndex] ? 0 : 1),
        ),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? Number.POSITIVE_INFINITY;
}

export class CommandRegistry {
  readonly #modules = new Map<string, CommandModule>();
  readonly #aliases = new Map<string, CommandModule>();

  register(module: CommandModule): void {
    const { name, aliases = [] } = module.descriptor;
    if (!COMMAND_NAME_PATTERN.test(name)) throw new Error(`Invalid command name: ${name}`);
    if (this.#modules.has(name) || this.#aliases.has(name))
      throw new Error(`Duplicate command: /${name}`);
    const uniqueAliases = new Set<string>();
    for (const alias of aliases) {
      if (!isValidCommandToken(alias)) throw new Error(`Invalid command alias: ${alias}`);
      if (alias === name) throw new Error(`Duplicate alias: /${alias}`);
      if (uniqueAliases.has(alias)) throw new Error(`Duplicate alias: /${alias}`);
      if (this.#modules.has(alias) || this.#aliases.has(alias)) {
        throw new Error(`Duplicate alias: /${alias}`);
      }
      uniqueAliases.add(alias);
    }
    this.#modules.set(name, module);
    for (const alias of uniqueAliases) this.#aliases.set(alias, module);
  }

  get descriptors(): readonly CommandDescriptor[] {
    return [...this.#modules.values()].map(({ descriptor }) => descriptor);
  }

  find(name: string): CommandDescriptor | undefined {
    return this.#modules.get(name)?.descriptor ?? this.#aliases.get(name)?.descriptor;
  }

  parse(input: string): ParsedCommand {
    if (!input.startsWith("/") || input.includes("\n")) return undefined;
    const [name, ...args] = input.slice(1).trim().split(/\s+/u);
    if (!name) return { error: "Введите /help, чтобы увидеть команды." };
    const module = this.#modules.get(name) ?? this.#aliases.get(name);
    if (!module) {
      let candidate: { item: CommandModule; distance: number } | undefined;
      for (const item of this.#modules.values()) {
        const names = [item.descriptor.name, ...(item.descriptor.aliases ?? [])];
        const distance = Math.min(
          ...names.map((candidateName) => editDistance(name, candidateName)),
        );
        if (
          candidate === undefined ||
          distance < candidate.distance ||
          (distance === candidate.distance && item.descriptor.name < candidate.item.descriptor.name)
        ) {
          candidate = { item, distance };
        }
      }
      return {
        error:
          candidate && candidate.distance <= 2
            ? `Неизвестная команда: /${name}. Возможно, вы имели в виду /${candidate.item.descriptor.name}.`
            : `Неизвестная команда: /${name}. Введите /help, чтобы увидеть команды.`,
      };
    }
    try {
      return { module, input: module.parse(args, this) };
    } catch (error) {
      if (error instanceof CommandUsageError) return { error: error.message };
      throw error;
    }
  }

  async dispatch(
    parsed: Exclude<ParsedCommand, undefined>,
    context: CommandContext,
  ): Promise<CommandResult> {
    if ("error" in parsed) {
      context.terminal.error(parsed.error);
      return "continue";
    }
    return parsed.module.handle(parsed.input, context);
  }
}

export function noArguments(args: readonly string[], usage: string): void {
  if (args.length > 0) throw new CommandUsageError(`Использование: ${usage}`);
}
