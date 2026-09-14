export const DEFAULT_DEEPSEEK_MODEL_ID = "deepseek-flash";

const LEGACY_FLASH_MODEL_IDS = new Set(["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]);

export function canonicalDeepSeekModelId(modelId: string): string {
  return LEGACY_FLASH_MODEL_IDS.has(modelId) ? DEFAULT_DEEPSEEK_MODEL_ID : modelId;
}

export function deepSeekModelSupportsVision(modelId: string): boolean {
  return (
    modelId === DEFAULT_DEEPSEEK_MODEL_ID ||
    LEGACY_FLASH_MODEL_IDS.has(modelId) ||
    /vision/iu.test(modelId)
  );
}
