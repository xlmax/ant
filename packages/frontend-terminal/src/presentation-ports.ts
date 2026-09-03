import type { ReasoningDisplayMode } from "@ant/app";
import type { AntApplicationApi, SubmittedTurn } from "@ant/app";
import type { AgentSession } from "@ant/app";
import type { AgentObserver, AgentResult } from "@ant/core";
import type { InputHistory } from "./input-history.js";
import type { TurnChangeSummary } from "./turn-change-summary.js";
import type { UpdateInfo } from "./updates/updates.js";

export interface TerminalPort {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  write(message: string): void;
  clear(): void;
  read(history: InputHistory, prompt: string): Promise<string | undefined>;
  readSecret(prompt: string, signal?: AbortSignal): Promise<string | undefined>;
  confirm(prompt: string, signal?: AbortSignal): Promise<boolean | undefined>;
  close(): void;
}

export interface ProcessControl {
  onInterrupt(listener: () => void): () => void;
  timeout(milliseconds: number): AbortSignal;
  setExitCode(code: number): void;
}

export interface UpdateService {
  readonly managedByNpm: boolean;
  check(currentVersion: string, signal: AbortSignal): Promise<UpdateInfo | undefined>;
  install(url: string): Promise<void>;
}

export interface ChangeTracker extends AgentObserver {
  begin(): Promise<void>;
  finish(): Promise<TurnChangeSummary>;
}

export interface GitPresentationService {
  branch(workspace: string): Promise<string | undefined>;
  createChangeTracker(workspace: string): ChangeTracker;
}

export interface TerminalRenderer extends AgentObserver {
  readonly reasoningMode: ReasoningDisplayMode;
  readonly reasoningMaxLines: number;
  setReasoningMode(mode: ReasoningDisplayMode): void;
  beginTurn(): void;
  readonly onTextDelta: (text: string) => void;
  readonly onReasoningDelta: (text: string) => void;
  printCancellationPending(): void;
  printResult(result: AgentResult): Promise<void>;
  printChangeSummary(summary: TurnChangeSummary): Promise<void>;
  dispose(): void;
}

export interface TurnExecutor {
  run(
    content: string,
    onSessionPrepared?: (session: AgentSession, created: boolean) => void | Promise<void>,
  ): Promise<SubmittedTurn>;
}

export interface TurnExecutorOptions {
  workspace: string;
  client: AntApplicationApi;
  renderer: TerminalRenderer;
  process: ProcessControl;
  git: GitPresentationService;
  showChanges?: boolean;
}
