import { CommandUsageError, type CommandModule, type CommandResult } from "@ant/frontend-terminal";
import type { DeepSeekCredentialManager } from "./deepseek-credentials.js";

type KeyAction = "status" | "set" | "clear";

export function createKeyCommand(manager: DeepSeekCredentialManager): CommandModule<KeyAction> {
  return {
    descriptor: {
      name: "key",
      usage: "/key [set|clear]",
      description: "Проверить, задать или удалить DeepSeek API key.",
    },
    parse(args) {
      if (args.length === 0) return "status";
      if (args.length === 1 && (args[0] === "set" || args[0] === "clear")) return args[0];
      throw new CommandUsageError("Использование: /key [set|clear]");
    },
    async handle(action, { terminal }): Promise<CommandResult> {
      try {
        if (action === "status") {
          const source = await manager.status();
          terminal.log(
            source === undefined
              ? "DeepSeek API key: not configured"
              : `DeepSeek API key: configured\nsource: ${source === "environment" ? "environment" : source === "credentials" ? "ANT credentials" : "current session"}`,
          );
          return "continue";
        }

        if (action === "set") {
          const result = await manager.promptAndSave();
          terminal.log(
            result === "saved"
              ? "DeepSeek API key saved. It will be used after ANT is restarted."
              : "DeepSeek API key was not changed.",
          );
          if (result === "saved" && manager.hasEnvironmentKey()) {
            terminal.warn("DEEPSEEK_API_KEY from the environment still has priority.");
          }
          return "continue";
        }

        const removed = await manager.clearStored();
        terminal.log(
          removed
            ? "Stored DeepSeek API key cleared. The current process keeps its already loaded key."
            : "Stored DeepSeek API key was not configured.",
        );
        if (manager.hasEnvironmentKey()) {
          terminal.warn(
            "DEEPSEEK_API_KEY from the environment is unchanged and still has priority.",
          );
        }
      } catch (error) {
        terminal.error(error instanceof Error ? error.message : String(error));
      }
      return "continue";
    },
  };
}
