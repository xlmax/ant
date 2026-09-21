import { ansi, noArguments, type CommandModule, type CommandResult } from "@ant/frontend-terminal";
import type { DeepSeekCredentialSource } from "./credentials/deepseek-credentials.js";

export interface DoctorCredentialStatus {
  status(): Promise<DeepSeekCredentialSource | undefined>;
}

export interface DoctorCommandOptions {
  credentials: DoctorCredentialStatus;
  environment?: NodeJS.ProcessEnv;
  nodeVersion?: string;
  now?: () => number;
}

function formatDuration(milliseconds: number): string {
  return milliseconds < 1_000 ? `${milliseconds} ms` : `${(milliseconds / 1_000).toFixed(1)} s`;
}

function credentialSource(source: DeepSeekCredentialSource): string {
  switch (source) {
    case "environment":
      return "переменная окружения";
    case "credentials":
      return "хранилище ANT";
    case "session":
      return "текущий процесс";
  }
}

function nodeVersionSupported(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > 20 || (major === 20 && minor >= 12);
}

function diagnosticError(error: unknown, aborted: boolean): string {
  if (aborted) return "проверка отменена";
  return error instanceof Error ? error.message : String(error);
}

export function createDoctorCommand(options: DoctorCommandOptions): CommandModule<void> {
  const environment = options.environment ?? process.env;
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const now = options.now ?? Date.now;

  return {
    descriptor: {
      name: "doctor",
      usage: "/doctor",
      description: "Проверить окружение, DeepSeek API и реальный ответ выбранной модели.",
      aliases: ["d"],
    },
    parse(args) {
      return noArguments(args, "/doctor");
    },
    async handle(_input, { options: repl, terminal, process }): Promise<CommandResult> {
      terminal.log(ansi.bold("Диагностика ANT"));

      const supported = nodeVersionSupported(nodeVersion);
      terminal.log(
        supported
          ? `${ansi.green("✓")} Node.js: ${nodeVersion}`
          : `${ansi.red("✗")} Node.js: ${nodeVersion} — требуется 20.12 или новее`,
      );

      let source: DeepSeekCredentialSource | undefined;
      try {
        source = await options.credentials.status();
        terminal.log(
          source
            ? `${ansi.green("✓")} DeepSeek API key: ${credentialSource(source)}`
            : `${ansi.red("✗")} DeepSeek API key: не настроен`,
        );
      } catch (error) {
        terminal.log(
          `${ansi.red("✗")} DeepSeek API key: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!source) return "continue";

      const proxyNames = ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy"]
        .filter((name) => environment[name]?.trim())
        .filter((name, index, names) => names.indexOf(name) === index);
      terminal.log(
        `${ansi.dim("•")} Proxy: ${proxyNames.length === 0 ? "не настроен" : proxyNames.join(", ")}`,
      );

      const cancel = new AbortController();
      const removeInterrupt = process.onInterrupt(() => cancel.abort());
      try {
        terminal.log(ansi.dim("Проверяю DeepSeek Models API…"));
        const modelsStartedAt = now();
        let models: readonly string[];
        try {
          models = await repl.client.listModels(
            AbortSignal.any([cancel.signal, process.timeout(15_000)]),
          );
        } catch (error) {
          terminal.log(
            `${ansi.red("✗")} Models API: ${diagnosticError(error, cancel.signal.aborted)}`,
          );
          return "continue";
        }
        terminal.log(
          `${ansi.green("✓")} Models API: ${models.length} моделей · ${formatDuration(now() - modelsStartedAt)}`,
        );

        const descriptor = repl.client.modelDescriptor;
        const selectedAvailable = models.includes(descriptor.modelId);
        terminal.log(
          selectedAvailable
            ? `${ansi.green("✓")} Активная модель: ${descriptor.providerId}/${descriptor.modelId}`
            : `${ansi.yellow("⚠")} Активная модель: ${descriptor.providerId}/${descriptor.modelId} отсутствует в /models`,
        );

        terminal.log(
          ansi.dim(
            "Выполняю короткий реальный completion с текущими thinking и tools-настройками…",
          ),
        );
        try {
          const diagnostic = await repl.client.diagnoseModel(cancel.signal);
          terminal.log(
            `${ansi.green("✓")} Completion: первый сигнал ${formatDuration(diagnostic.firstActivityMs)} · всего ${formatDuration(diagnostic.durationMs)} · tools ${diagnostic.toolsEnabled ? "on" : "off"}`,
          );
        } catch (error) {
          terminal.log(
            `${ansi.red("✗")} Completion: ${diagnosticError(error, cancel.signal.aborted)}`,
          );
        }
      } finally {
        removeInterrupt();
      }

      return "continue";
    },
  };
}
