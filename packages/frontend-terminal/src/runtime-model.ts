import type { ModelDescriptor } from "@ant/app";

export function formatModelStatus(descriptor: ModelDescriptor): string {
  const reasoning = descriptor.capabilities.reasoning;
  const thinking = reasoning.enabled ? `thinking ${reasoning.effort ?? "on"}` : "thinking off";
  return `${descriptor.providerId}/${descriptor.modelId} · ${thinking} · context ${descriptor.contextWindow.toLocaleString("ru-RU")}`;
}
