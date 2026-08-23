import { createContext, Script } from "node:vm";

const MATCHER_SCRIPT = new Script(`
  (() => {
    const re = new RegExp(pattern, flags);
    const lines = content.split("\\n");
    const matched = [];
    for (let index = 0; index < lines.length && matched.length < maxResults; index++) {
      if (re.test(lines[index])) {
        matched.push(index + 1);
      }
    }
    return matched;
  })()
`);

export interface RegexMatcherOptions {
  pattern: string;
  flags: string;
  maxResults: number;
  timeoutMs: number;
}

export interface RegexMatchOutcome {
  lineNumbers: number[];
  timedOut: boolean;
}

/**
 * Runs a regular expression against text inside a fresh V8 context with a
 * hard execution timeout. This bounds catastrophic backtracking so a hostile
 * or accidental pattern cannot freeze the agent process.
 */
export class RegexMatcher {
  readonly #pattern: string;
  readonly #flags: string;
  readonly #maxResults: number;
  readonly #timeoutMs: number;
  #context: ReturnType<typeof createContext>;

  constructor(options: RegexMatcherOptions) {
    this.#pattern = options.pattern;
    this.#flags = options.flags;
    this.#maxResults = options.maxResults;
    this.#timeoutMs = options.timeoutMs;
    this.#context = createContext({});
  }

  match(content: string): RegexMatchOutcome {
    const context = this.#context;
    context.pattern = this.#pattern;
    context.flags = this.#flags;
    context.content = content;
    context.maxResults = this.#maxResults;

    try {
      const lineNumbers = MATCHER_SCRIPT.runInContext(context, {
        timeout: this.#timeoutMs,
      });
      return { lineNumbers: lineNumbers as number[], timedOut: false };
    } catch (error) {
      if ((error as { code?: unknown }).code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
        this.#context = createContext({});
        return { lineNumbers: [], timedOut: true };
      }

      throw error;
    }
  }
}
