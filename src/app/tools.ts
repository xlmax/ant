import type { ImageAttachment, SingleToolOutputHandler, ToolSpec } from "../core/agent.js";

export type ToolCapability = "filesystem.read" | "filesystem.write" | "process.spawn" | string;
export type ToolSideEffects = "none" | "workspace" | "process";

export interface ToolMetadata {
  readonly ownerId: string;
  readonly sideEffects: ToolSideEffects;
  readonly parallelSafe: boolean;
  readonly requiredCapabilities: readonly ToolCapability[];
}

export interface ToolExecutionResult {
  kind: "tool-result";
  value: unknown;
  attachments: readonly ImageAttachment[];
}

export interface Tool {
  readonly metadata: ToolMetadata;
  readonly spec: ToolSpec;
  execute(
    input: unknown,
    signal?: AbortSignal,
    onOutput?: SingleToolOutputHandler,
  ): Promise<unknown | ToolExecutionResult>;
}

export interface ToolLogger {
  debug(message: string): void;
}

export interface ToolContext {
  readonly workspace: string;
  readonly capabilities: ReadonlySet<ToolCapability>;
  readonly process: {
    readonly bashPath?: string;
  };
  readonly logger: ToolLogger;
}

export interface ToolPack {
  readonly id: string;
  create(context: ToolContext): readonly Tool[];
}
