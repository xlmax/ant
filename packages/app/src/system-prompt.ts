/** Provider-neutral system prompt assembled by an external source adapter. */
export interface SystemPrompt {
  content: string;
  sources: string[];
}
