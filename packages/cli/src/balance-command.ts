import { ansi, noArguments, type CommandModule, type CommandResult } from "@ant/frontend-terminal";
import type { DeepSeekBalance } from "@ant/provider-deepseek";

export type DeepSeekBalanceLoader = (signal?: AbortSignal) => Promise<DeepSeekBalance>;

function visibleBalances(balance: DeepSeekBalance): DeepSeekBalance["balances"] {
  const nonZero = balance.balances.filter((item) =>
    [item.totalBalance, item.toppedUpBalance, item.grantedBalance].some(
      (value) => Number(value) !== 0,
    ),
  );
  if (nonZero.length > 0) return nonZero;
  const preferred = balance.balances.find((item) => item.currency === "USD");
  return preferred ? [preferred] : balance.balances.slice(0, 1);
}

function formatBalance(balance: DeepSeekBalance): string {
  const lines = [
    ansi.bold(ansi.cyan("DeepSeek API balance")),
    `${ansi.dim("Status:")} ${balance.available ? ansi.green("available") : ansi.red("unavailable")}`,
  ];
  for (const item of visibleBalances(balance)) {
    lines.push(
      "",
      ansi.bold(ansi.cyan(item.currency)),
      `  ${ansi.dim("Total:")}      ${ansi.bold(item.totalBalance)}`,
      `  ${ansi.dim("Topped up:")}  ${item.toppedUpBalance}`,
      `  ${ansi.dim("Granted:")}    ${item.grantedBalance}`,
    );
  }
  return lines.join("\n");
}

export function createBalanceCommand(loadBalance: DeepSeekBalanceLoader): CommandModule<void> {
  return {
    descriptor: {
      name: "balance",
      usage: "/balance",
      description: "Показать текущий баланс DeepSeek API.",
      aliases: ["bal"],
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
