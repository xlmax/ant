import type { Observation, ToolCall } from "@ant/core";
import { ansi } from "./ansi.js";

const TOOL_LABEL_MAX_CHARS = 60;
const ERROR_REASON_MAX_CHARS = 120;

function formatValue(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
}

function singleLine(value: string, maxChars: number): string {
  const collapsed = value.replace(/\s+/gu, " ").trim();
  if (collapsed === "") return "";
  const chars = Array.from(collapsed);
  if (chars.length <= maxChars) return collapsed;
  return `${chars.slice(0, maxChars - 1).join("")}…`;
}

function stringProperty(value: unknown, property: string): string | undefined {
  if (typeof value !== "object" || value === null || !(property in value)) return undefined;
  const candidate = (value as Record<string, unknown>)[property];
  return typeof candidate === "string" ? candidate : undefined;
}

function bashExitCode(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null || !("exitCode" in value)) return undefined;
  const exitCode = (value as Record<string, unknown>).exitCode;
  return typeof exitCode === "number" ? exitCode : undefined;
}

export function formatToolLabel(name: string, input: unknown): string {
  const record = typeof input === "object" && input !== null ? input : undefined;
  switch (name) {
    case "bash":
      return singleLine(stringProperty(record, "command") ?? "", TOOL_LABEL_MAX_CHARS);
    case "grep":
    case "glob":
      return singleLine(stringProperty(record, "pattern") ?? "", TOOL_LABEL_MAX_CHARS);
    case "read":
    case "write":
    case "edit":
      return singleLine(stringProperty(record, "path") ?? "", TOOL_LABEL_MAX_CHARS);
    default:
      return singleLine(formatValue(input), TOOL_LABEL_MAX_CHARS);
  }
}

export function formatReplayToolStatus(call: ToolCall, observation: Observation): string {
  if (!observation.ok) {
    const reason = singleLine(observation.error ?? "ошибка", ERROR_REASON_MAX_CHARS);
    return `${ansi.red("✗")} ${call.name}${reason === "" ? "" : ` — ${reason}`}`;
  }

  const exitCode = bashExitCode(observation.value);
  if (call.name === "bash" && exitCode !== undefined && exitCode !== 0) {
    return `${ansi.red("✗")} ${call.name} exit ${exitCode}`;
  }

  return `${ansi.green("✓")} ${call.name}`;
}
