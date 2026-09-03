import { noArguments, type CommandModule, type CommandResult } from "@ant/frontend-terminal";
import type { DeepSeekBalance } from "@ant/provider-deepseek";

export type DeepSeekBalanceLoader = (signal?: AbortSignal) => Promise<DeepSeekBalance>;

function formatBalance(balance: DeepSeekBalance): string {
  const lines = [
    `DeepSeek API balance: ${balance.available ? "available" : "unavailable"}`,
    ...balance.balances.map(
      (item) =>
        `${item.currency}: ${item.totalBalance} (topped up: ${item.toppedUpBalance}, granted: ${item.grantedBalance})`,
    ),
  ];
  return lines.join("\n");
}

export function createBalanceCommand(loadBalance: DeepSeekBalanceLoader): CommandModule<void> {
  return {
    descriptor: {
      name: "balance",
      usage: "/balance",
      description: "Показать текущий баланс DeepSeek API.",
    },
    parse(args) {
      noArguments(args, "/balance");
    },
    async handle(_input, { process, terminal }): Promise<CommandResult> {
      const cancel = new AbortController();
      const removeInterrupt = process.onInterrupt(() => cancel.abort());
      try {
        terminal.log(formatBalance(await loadBalance(cancel.signal)));
      } catch (error) {
        terminal.error(
          cancel.signal.aborted
            ? "Проверка баланса DeepSeek отменена."
            : `Не удалось получить баланс DeepSeek: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        removeInterrupt();
      }
      return "continue";
    },
  };
}
