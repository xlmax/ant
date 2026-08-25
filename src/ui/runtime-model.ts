import type { ModelSettings, ReasoningEffort } from "../config/settings.js";

export type EffortSelection = ReasoningEffort | "off";

export function selectEffort(current: ModelSettings, selection: EffortSelection): ModelSettings {
  return {
    ...current,
    thinking: {
      enabled: selection !== "off",
      effort: selection === "off" ? current.thinking.effort : selection,
    },
  };
}

export function formatModelStatus(settings: ModelSettings): string {
  const thinking = settings.thinking.enabled
    ? `thinking ${settings.thinking.effort}`
    : "thinking off";
  return `${settings.provider}/${settings.id} · ${thinking} · context ${settings.contextWindow.toLocaleString("ru-RU")}`;
}
