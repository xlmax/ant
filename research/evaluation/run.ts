import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import {
  createAgentState,
  runAgent,
  type AgentEvent,
  type AgentModel,
  type AgentResult,
  type AgentState,
  type ModelInput,
} from "../../src/core/agent.js";
import { createCodingTools } from "../../src/coding-tools.js";
import { loadSettings } from "../../src/config/settings.js";
import { loadSystemPrompt } from "../../src/config/system-prompt.js";
import { ToolEnvironment } from "../../src/core/environment.js";
import { DeepSeekModel } from "../../src/models/deepseek-model.js";
import { JsonlSessionStore } from "../../src/core/session-store.js";
import { SessionController } from "../../src/core/session-controller.js";

const MAX_MODEL_CALLS = 6;
const TASK_TIMEOUT_MS = 60_000;

interface EvalCheck {
  name: string;
  passed: boolean;
  details: string;
}

interface EvalContext {
  workspace: string;
  result: AgentResult;
}

interface EvalRunContext {
  workspace: string;
  model: AgentModel;
  environment: ToolEnvironment;
}

interface EvalTask {
  id: string;
  prompt: string;
  maxModelCalls?: number;
  setup(workspace: string): Promise<void>;
  run?(context: EvalRunContext): Promise<AgentResult>;
  verify(context: EvalContext): Promise<EvalCheck[]>;
}

interface EvalTaskReport {
  id: string;
  passed: boolean;
  durationMs: number;
  modelCalls: number;
  toolCalls: number;
  answer?: string;
  events?: AgentEvent[];
  error?: string;
  checks: EvalCheck[];
}

class CappedModel implements AgentModel {
  #calls = 0;
  readonly #delegate: AgentModel;
  readonly #maxCalls: number;

  constructor(delegate: AgentModel, maxCalls: number) {
    this.#delegate = delegate;
    this.#maxCalls = maxCalls;
  }

  get calls(): number {
    return this.#calls;
  }

  async decide(input: ModelInput, signal?: AbortSignal) {
    if (this.#calls >= this.#maxCalls) {
      throw new Error(`Достигнут лимит: ${this.#maxCalls} вызовов модели`);
    }

    this.#calls += 1;
    return this.#delegate.decide(input, signal);
  }
}

async function createModel(): Promise<DeepSeekModel> {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();

  if (!apiKey) {
    throw new Error("Для запуска eval необходима переменная DEEPSEEK_API_KEY");
  }

  const [systemPrompt, loadedSettings] = await Promise.all([
    loadSystemPrompt(process.cwd()),
    loadSettings(process.cwd()),
  ]);

  return new DeepSeekModel({
    apiKey,
    systemPrompt: systemPrompt.content,
    model: loadedSettings.settings.model.id,
    baseUrl: loadedSettings.settings.model.baseUrl,
    contextWindow: loadedSettings.settings.model.contextWindow,
    thinkingEnabled: loadedSettings.settings.model.thinking.enabled,
    reasoningEffort: loadedSettings.settings.model.thinking.effort,
  });
}

function completedAnswer(result: AgentResult): string {
  return result.status === "completed" ? result.answer : "";
}

function toolCalls(events: readonly AgentEvent[]): Array<{
  name: string;
  input: unknown;
}> {
  return events.flatMap((event) =>
    event.type === "decision" && event.decision.type === "tools"
      ? event.decision.calls.map((call) => ({
          name: call.name,
          input: call.input,
        }))
      : [],
  );
}

function containsToolCall(events: readonly AgentEvent[], name: string, path?: string): boolean {
  return toolCalls(events).some(
    (call) =>
      call.name === name &&
      (path === undefined ||
        (typeof call.input === "object" &&
          call.input !== null &&
          "path" in call.input &&
          call.input.path === path)),
  );
}

function hasFailedToolCall(events: readonly AgentEvent[], name: string, path?: string): boolean {
  return events.some(
    (event) =>
      event.type === "observation" &&
      !event.observation.ok &&
      event.call.name === name &&
      (path === undefined ||
        (typeof event.call.input === "object" &&
          event.call.input !== null &&
          "path" in event.call.input &&
          event.call.input.path === path)),
  );
}

function toolCallsAfterLastUser(events: readonly AgentEvent[]): Array<{
  name: string;
  input: unknown;
}> {
  const lastUserIndex = events.findLastIndex((event) => event.type === "user");
  return toolCalls(events.slice(lastUserIndex + 1));
}

function hasText(text: string, expected: string): boolean {
  return text.toLocaleLowerCase().includes(expected.toLocaleLowerCase());
}

async function fileEquals(path: string, expected: string): Promise<boolean> {
  try {
    return (await readFile(path, "utf8")) === expected;
  } catch {
    return false;
  }
}

async function commandExitsZero(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, {
        cwd,
        stdio: "ignore",
        windowsHide: true,
      });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

async function isSingleDoneLine(path: string): Promise<boolean> {
  try {
    const content = await readFile(path, "utf8");
    return content === "done" || content === "done\n";
  } catch {
    return false;
  }
}

const tasks: readonly EvalTask[] = [
  {
    id: "read-fact",
    prompt: "Прочитай facts.txt и ответь только кодовым словом.",
    async setup(workspace) {
      await writeFile(workspace + "/facts.txt", "Кодовое слово: ORBITAL-42\n", "utf8");
    },
    async verify({ result }) {
      const answer = completedAnswer(result);
      return [
        {
          name: "использован read для facts.txt",
          passed: containsToolCall(result.state.events, "read", "facts.txt"),
          details: "Ожидалось чтение facts.txt",
        },
        {
          name: "извлечено кодовое слово",
          passed: hasText(answer, "ORBITAL-42"),
          details: `Ответ: ${answer}`,
        },
      ];
    },
  },
  {
    id: "multi-read",
    prompt: "Прочитай alpha.txt и beta.txt, затем назови оба небесных тела.",
    async setup(workspace) {
      await Promise.all([
        writeFile(workspace + "/alpha.txt", "Первое небесное тело: Луна\n", "utf8"),
        writeFile(workspace + "/beta.txt", "Второе небесное тело: Марс\n", "utf8"),
      ]);
    },
    async verify({ result }) {
      const answer = completedAnswer(result);
      return [
        {
          name: "прочитаны оба файла",
          passed:
            containsToolCall(result.state.events, "read", "alpha.txt") &&
            containsToolCall(result.state.events, "read", "beta.txt"),
          details: "Ожидалось чтение alpha.txt и beta.txt",
        },
        {
          name: "названы оба факта",
          passed: hasText(answer, "Луна") && hasText(answer, "Марс"),
          details: `Ответ: ${answer}`,
        },
      ];
    },
  },
  {
    id: "direct-answer",
    prompt: "Ответь ровно словом «готово». Не используй инструменты.",
    async setup() {},
    async verify({ result }) {
      const answer = completedAnswer(result).trim().toLocaleLowerCase();
      return [
        {
          name: "не вызваны инструменты",
          passed: toolCalls(result.state.events).length === 0,
          details: `Вызовов инструментов: ${toolCalls(result.state.events).length}`,
        },
        {
          name: "получен прямой ответ",
          passed: answer === "готово",
          details: `Ответ: ${completedAnswer(result)}`,
        },
      ];
    },
  },
  {
    id: "write-file",
    prompt: "Создай файл result.txt в корне проекта с единственной строкой done.",
    async setup() {},
    async verify({ workspace, result }) {
      return [
        {
          name: "использован write",
          passed: containsToolCall(result.state.events, "write", "result.txt"),
          details: "Ожидался вызов write для result.txt",
        },
        {
          name: "создана единственная строка done",
          passed: await isSingleDoneLine(join(workspace, "result.txt")),
          details:
            "result.txt должен содержать только done и необязательный завершающий перевод строки",
        },
      ];
    },
  },
  {
    id: "exact-edit",
    prompt: "В config.txt замени значение status=old на status=new, не переписывая файл целиком.",
    async setup(workspace) {
      await writeFile(workspace + "/config.txt", "name=fixture\nstatus=old\n", "utf8");
    },
    async verify({ workspace, result }) {
      return [
        {
          name: "использован edit",
          passed: containsToolCall(result.state.events, "edit", "config.txt"),
          details: "Ожидался вызов edit для config.txt",
        },
        {
          name: "изменено только целевое значение",
          passed: await fileEquals(join(workspace, "config.txt"), "name=fixture\nstatus=new\n"),
          details: "config.txt должен содержать обновлённый status",
        },
      ];
    },
  },
  {
    id: "bash-command",
    prompt: "Через bash выполни команду printf 'ORACLE\\n' и назови результат.",
    async setup() {},
    async verify({ result }) {
      const answer = completedAnswer(result);
      return [
        {
          name: "использован bash",
          passed: containsToolCall(result.state.events, "bash"),
          details: "Ожидался хотя бы один вызов bash",
        },
        {
          name: "интерпретирован вывод команды",
          passed: hasText(answer, "ORACLE"),
          details: `Ответ: ${answer}`,
        },
      ];
    },
  },
  {
    id: "recover-from-tool-error",
    prompt:
      "Сначала попробуй прочитать missing.txt. После ошибки прочитай fallback.txt и назови резервную фразу.",
    async setup(workspace) {
      await writeFile(workspace + "/fallback.txt", "Резервная фраза: RECOVERED\n", "utf8");
    },
    async verify({ result }) {
      const answer = completedAnswer(result);
      return [
        {
          name: "зафиксирована ошибка read",
          passed: hasFailedToolCall(result.state.events, "read", "missing.txt"),
          details: "Ожидалась ошибка чтения missing.txt",
        },
        {
          name: "выполнено восстановление",
          passed: containsToolCall(result.state.events, "read", "fallback.txt"),
          details: "Ожидалось чтение fallback.txt после ошибки",
        },
        {
          name: "извлечена резервная фраза",
          passed: hasText(answer, "RECOVERED"),
          details: `Ответ: ${answer}`,
        },
      ];
    },
  },
  {
    id: "verify-write",
    prompt:
      "Создай verified.txt с единственной строкой verified. После записи обязательно прочитай этот файл и подтверди его содержимое.",
    async setup() {},
    async verify({ workspace, result }) {
      return [
        {
          name: "использован write",
          passed: containsToolCall(result.state.events, "write", "verified.txt"),
          details: "Ожидалась запись verified.txt",
        },
        {
          name: "выполнена проверка read",
          passed: containsToolCall(result.state.events, "read", "verified.txt"),
          details: "Ожидалось чтение verified.txt после записи",
        },
        {
          name: "файл содержит одну строку",
          passed:
            (await fileEquals(join(workspace, "verified.txt"), "verified")) ||
            (await fileEquals(join(workspace, "verified.txt"), "verified\n")),
          details: "verified.txt должен содержать только verified",
        },
      ];
    },
  },
  {
    id: "multi-file-edit",
    prompt:
      "Точечно замени status=old на status=new в first.txt и second.txt. Не переписывай файлы целиком.",
    async setup(workspace) {
      await Promise.all([
        writeFile(workspace + "/first.txt", "name=first\nstatus=old\n", "utf8"),
        writeFile(workspace + "/second.txt", "name=second\nstatus=old\n", "utf8"),
      ]);
    },
    async verify({ workspace, result }) {
      return [
        {
          name: "отредактированы оба файла",
          passed:
            containsToolCall(result.state.events, "edit", "first.txt") &&
            containsToolCall(result.state.events, "edit", "second.txt"),
          details: "Ожидались вызовы edit для двух файлов",
        },
        {
          name: "сохранено содержимое first.txt",
          passed: await fileEquals(join(workspace, "first.txt"), "name=first\nstatus=new\n"),
          details: "first.txt должен содержать status=new",
        },
        {
          name: "сохранено содержимое second.txt",
          passed: await fileEquals(join(workspace, "second.txt"), "name=second\nstatus=new\n"),
          details: "second.txt должен содержать status=new",
        },
      ];
    },
  },
  {
    id: "fix-failing-test",
    maxModelCalls: 8,
    prompt:
      "Запусти npm test. Исправь check.mjs точечным изменением, чтобы тест прошёл, затем снова запусти npm test. Используй относительный путь check.mjs.",
    async setup(workspace) {
      await Promise.all([
        writeFile(workspace + "/package.json", '{"scripts":{"test":"node check.mjs"}}\n', "utf8"),
        writeFile(
          workspace + "/check.mjs",
          'import assert from "node:assert/strict";\nassert.equal(2 + 2, 5);\n',
          "utf8",
        ),
      ]);
    },
    async verify({ workspace, result }) {
      const bashCommands = toolCalls(result.state.events).filter(
        (call) =>
          call.name === "bash" &&
          typeof call.input === "object" &&
          call.input !== null &&
          "command" in call.input &&
          typeof call.input.command === "string" &&
          call.input.command.includes("npm test"),
      );

      return [
        {
          name: "npm test запущен до и после исправления",
          passed: bashCommands.length >= 2,
          details: `Найдено запусков npm test: ${bashCommands.length}`,
        },
        {
          name: "использован точечный edit",
          passed: containsToolCall(result.state.events, "edit", "check.mjs"),
          details: "Ожидался edit для check.mjs",
        },
        {
          name: "исправленный тест действительно проходит",
          passed: await commandExitsZero(process.execPath, ["check.mjs"], workspace),
          details: "исправленный check.mjs должен завершаться кодом 0",
        },
      ];
    },
  },
  {
    id: "resume-context",
    prompt: "Прочитай memory.txt и запомни контрольную фразу.",
    async setup(workspace) {
      await writeFile(workspace + "/memory.txt", "Контрольная фраза: CONTEXT-OK\n", "utf8");
    },
    async run({ workspace, model, environment }) {
      const store = new JsonlSessionStore(join(workspace, ".ant", "sessions"));
      const initialState = createAgentState("Прочитай memory.txt и запомни контрольную фразу.");
      const session = await store.create(initialState);
      const firstResult = await runAgent(initialState, {
        model,
        environment,
        historyObserver: session.observer,
        signal: AbortSignal.timeout(TASK_TIMEOUT_MS),
      });

      if (firstResult.status !== "completed") {
        return firstResult;
      }

      // Reuse SessionController so the resumed user event follows the
      // persist-before-state contract (journal first, then in-memory state).
      const controller = new SessionController(store);
      await controller.resume(session.id);
      const resumed = await controller.prepareUserMessage(
        "Назови контрольную фразу без повторного чтения memory.txt и без инструментов.",
      );

      return runAgent(resumed.state, {
        model,
        environment,
        historyObserver: resumed.session.observer,
        signal: AbortSignal.timeout(TASK_TIMEOUT_MS),
      });
    },
    async verify({ result }) {
      const answer = completedAnswer(result);
      return [
        {
          name: "контекст сессии загружен",
          passed: hasText(answer, "CONTEXT-OK"),
          details: `Ответ: ${answer}`,
        },
        {
          name: "нет повторного чтения после resume",
          passed: toolCallsAfterLastUser(result.state.events).length === 0,
          details: `Инструментов после resume: ${toolCallsAfterLastUser(result.state.events).length}`,
        },
      ];
    },
  },
];

async function runTask(task: EvalTask): Promise<EvalTaskReport> {
  const workspace = await mkdtemp(join(tmpdir(), `ant-eval-${task.id}-`));
  const startedAt = performance.now();
  const model = new CappedModel(await createModel(), task.maxModelCalls ?? MAX_MODEL_CALLS);

  let result: AgentResult | undefined;
  let state: AgentState | undefined;

  try {
    await task.setup(workspace);
    const environment = new ToolEnvironment(createCodingTools(workspace));

    if (task.run) {
      result = await task.run({ workspace, model, environment });
    } else {
      state = createAgentState(task.prompt);
      result = await runAgent(state, {
        model,
        environment,
        signal: AbortSignal.timeout(TASK_TIMEOUT_MS),
      });
    }
    const checks = await task.verify({ workspace, result });

    return {
      id: task.id,
      passed: result.status === "completed" && checks.every((check) => check.passed),
      durationMs: Math.round(performance.now() - startedAt),
      modelCalls: model.calls,
      toolCalls: toolCalls(result.state.events).length,
      answer: completedAnswer(result),
      events: result.state.events,
      checks,
    };
  } catch (error) {
    return {
      id: task.id,
      passed: false,
      durationMs: Math.round(performance.now() - startedAt),
      modelCalls: model.calls,
      ...(() => {
        const events = result?.state.events ?? state?.events;

        return events
          ? {
              toolCalls: toolCalls(events).length,
              ...(result ? { answer: completedAnswer(result) } : {}),
              events,
            }
          : { toolCalls: 0 };
      })(),
      error: error instanceof Error ? error.message : String(error),
      checks: [],
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function selectTasks(args: readonly string[]): readonly EvalTask[] {
  if (args.length === 0) {
    return tasks;
  }

  if (args.length !== 2 || args[0] !== "--task") {
    throw new Error("Использование: npm run eval -- [--task <id>]");
  }

  const task = tasks.find((candidate) => candidate.id === args[1]);

  if (!task) {
    throw new Error(`Неизвестная eval-задача: ${args[1]}`);
  }

  return [task];
}

async function main(): Promise<void> {
  const startedAt = new Date();
  const selectedTasks = selectTasks(process.argv.slice(2));
  const reports: EvalTaskReport[] = [];

  for (const task of selectedTasks) {
    const report = await runTask(task);
    reports.push(report);
    console.log(`${report.passed ? "✓" : "✗"} ${report.id} (${report.durationMs} мс)`);

    if (!report.passed) {
      for (const check of report.checks.filter((check) => !check.passed)) {
        console.log(`  - ${check.name}: ${check.details}`);
      }

      if (report.error) {
        console.log(`  - ошибка: ${report.error}`);
      }
    }
  }

  const passed = reports.filter((report) => report.passed).length;
  const modelCalls = reports.reduce((total, report) => total + report.modelCalls, 0);
  const toolCallsCount = reports.reduce((total, report) => total + report.toolCalls, 0);
  const reportDirectory = join(process.cwd(), "research", "evaluation", "results");
  const reportPath = join(reportDirectory, `${startedAt.toISOString().replaceAll(":", "-")}.json`);

  await mkdir(reportDirectory, { recursive: true });
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        startedAt: startedAt.toISOString(),
        model: process.env.DEEPSEEK_MODEL?.trim() || "deepseek-v4-flash",
        passed,
        total: reports.length,
        modelCalls,
        toolCalls: toolCallsCount,
        reports,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  console.log(`\n${passed}/${reports.length} задач успешно`);
  console.log(`Вызовов модели: ${modelCalls}; инструментов: ${toolCallsCount}`);
  console.log(`Отчёт: ${reportPath}`);

  if (passed !== reports.length) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
