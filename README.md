# ANT — Agentic Native Tool

Ant is a compact coding agent that lives in your terminal. You describe a task in plain language, and it reads the project, runs commands, and edits files.

## Usage

After installing, launch Ant in your project directory with `ant` (or `npm run dev` when developing from source) and describe what you want in plain language — for example, `ant "Refactor the logger and add tests"`. Ant inspects the project with its `read`, `grep`, `glob`, and `bash` tools, then edits files and runs commands to complete the task, confirming what changed and answering follow-up questions in the same session.

## Installation

### Prebuilt

The easiest way is to install it with a script.

Linux/macOS (or Git Bash on Windows):

```bash
curl -fsSL https://raw.githubusercontent.com/xlmax/ant/master/install.sh | sh
```

PowerShell (Windows):

```powershell
irm https://raw.githubusercontent.com/xlmax/ant/master/install.ps1 | iex
```

Or manually from GitHub Releases (replace with the latest version):

```bash
npm install -g https://github.com/xlmax/ant/releases/download/v0.5.8/ant-0.5.8.tgz
```

Requires Node.js ≥ 20.12. After installation, run it as `ant`.

### From source

```bash
npm install
npm run dev
```

## Tools

Ant works with files and the terminal:

- `read` — reads files, including images;
- `grep` and `glob` — search the project;
- `bash` — runs commands;
- `edit` and `write` — modify and create files.

This set covers most day-to-day tasks.

## Architecture

Ant is assembled by `AntApplication` from replaceable modules with stable TypeScript ports:

- `AgentRuntime` — the agent loop (the built-in implementation delegates to `runAgent`);
- `AntFrontend` — presentation (the built-in implementation is the terminal frontend);
- `ModelProvider` — provider-owned model discovery, selection, capabilities, and
  model/summarizer construction (DeepSeek is built in);
- `SessionStore` — durable history (JSONL is built in);
- `Environment` — execution of tools assembled by `ToolRegistry`.

For each invocation, the application creates an `AntApplicationClient`. It owns the active session, configured model and summarizer, and exposes application use cases such as submitting a turn, compacting context, and selecting a model. Frontends depend on this API instead of composing the runtime, provider, session store, and environment themselves. Agent policy remains in the runtime.

The application identifies a model with a provider-neutral `ModelConfiguration`
and consumes a standard `ModelDescriptor` for context-window, vision, and
reasoning capabilities. Provider-specific settings are opaque to the
application and presentation layers: the provider validates them and owns the
rules for model and reasoning selection. The existing flat DeepSeek settings
remain supported as a compatibility format.

Tools implement application-owned `Tool` and `ToolPack` contracts. Each tool
declares its owner, side effects, parallel-safety, and required platform
capabilities. The composition root registers the built-in coding pack and the
registry validates ownership, capabilities, and name conflicts before creating
the environment. Additional statically linked packs require one registration;
dynamic third-party loading is intentionally not supported yet.

Modules are selected statically at startup — Ant does not load third-party packages or hot-swap a running session.

Layer ownership is explicit: `core/` contains the infrastructure-independent agent domain and ports, `app/` contains application contracts and use cases, while `cli/`, `config/`, `models/`, `sessions/`, `tools/`, and `ui/` are concrete adapters. `main.ts` is the composition root. An AST-based architecture test checks every production layer, rejects outward dependencies, and detects runtime import cycles.

The terminal frontend is composed from presentation ports for terminal I/O, process signals/timeouts, update operations, and Git status. REPL commands are registered as independent modules with their own descriptor, parser, and handler; adding a command does not require editing a central parser or dispatch switch. The default Node.js terminal, updater, and Git implementations are wired only in the composition root and can be replaced in tests or by another frontend assembly.

Statically composed modules have a common application-owned descriptor (`id`, `kind`, API version, provided and required capabilities). The module registry validates the complete composition before startup, exposes health diagnostics, and guarantees reverse-order cleanup after successful runs, startup failures, and frontend errors.

> [!WARNING]
> Ant has no built-in guardrails: it runs commands and edits files with the same permissions as the user who launched it, and it is not confined to the working directory. Any consequences are your responsibility. Don't run it in directories with sensitive data or use keys with a valuable balance.

## Sessions

Every run writes a JSONL journal to `.ant/sessions/<session-id>.jsonl`: tasks, model decisions, and final tool results. Each durable record has a versioned envelope and an opaque, independently versioned history payload; transient lifecycle events are not written. The application owns the history codec, while storage adapters only handle serializable records. Existing version 1 journals remain readable and are continued with current records. A torn final JSON line is repaired when the session is resumed. The directory is ignored by Git.

Launch flags:

```bash
npm run dev -- -h                    # help
npm run dev -- -v                    # print version and exit
npm run dev -- -r                    # list saved sessions
npm run dev -- -c                    # resume the latest session
npm run dev -- -s <session-id>        # resume a specific session
npm run dev -- -s <session-id> "now run the tests"
```

`-r` and `-h` work without an API key. Corrupted JSONL files are skipped and reported as warnings.

> A session file may contain `read` and `bash` results, model reasoning, and accidentally exposed secrets. It is meant for local inspection only.

## Running

Start Ant directly:

```bash
ant
```

If no DeepSeek key is configured, an interactive terminal asks for it without echoing the value and can save it for later launches. Stored credentials live in `~/.config/ant/credentials.json` on Unix and Android, and `%APPDATA%\ant\credentials.json` on Windows. They are separate from project settings.

For automation or an explicit override, set `DEEPSEEK_API_KEY` in the environment or put it in `.env.local` in the working directory (or globally in `~/.ant/.env.local`):

```dotenv
DEEPSEEK_API_KEY=your_temporary_key
```

The file in the working directory takes priority over the global one, and an environment variable takes priority over both. Any environment value has priority over the saved ANT credential. Both `.env.local` files are ignored by Git.

### System prompt

Before the first model call, Ant assembles the system prompt from Markdown files in this order:

1. bundled `SYSTEM.md` (`packages/cli/prompts/SYSTEM.md` in the repository, `prompts/SYSTEM.md` in the installed package) — base instructions;
2. `~/.ant/SYSTEM.md` — global user instructions, if the file exists;
3. `.ant/SYSTEM.md` in the working directory — project-specific instructions, if the file exists;
4. paths from `prompts.additionalPaths` in settings.

Later files extend earlier ones. The prompt applies to every model call in the current process, so restart the REPL after changing a file.

### Settings

Non-secret settings are layered: `~/.ant/settings.json`, then `.ant/settings.json` in the working directory. Settings are owned by versioned modules and routed through a configuration registry. The project file overrides the global one except for provider selection and `model.providerOptions.baseUrl`: because the endpoint controls where the API key is sent, it is accepted only from the user-level file. Secrets such as `DEEPSEEK_API_KEY` are never accepted from settings files.

```json
{
  "schemaVersion": 1,
  "sections": {
    "model": {
      "version": 1,
      "value": {
        "providerId": "deepseek",
        "modelId": "deepseek-v4-flash",
        "providerOptions": {
          "baseUrl": "https://api.deepseek.com",
          "contextWindow": 1000000,
          "vision": false,
          "thinking": { "enabled": true, "effort": "high" }
        }
      }
    },
    "ui": {
      "version": 1,
      "value": { "reasoningMode": "off", "reasoningMaxLines": 6 }
    },
    "prompts": {
      "version": 1,
      "value": { "additionalPaths": ["prompts/local.md"] }
    }
  }
}
```

The previous flat format remains supported and is migrated atomically when a command first saves user settings. Unknown sections and unsupported root or section versions are rejected instead of being silently ignored.

Only `deepseek` is supported. For a custom vision model, set `model.providerOptions.vision: true` in the canonical format (or `model.vision` in the legacy format). To reset an inherited `tools.bashPath` in project settings, set `"bashPath": null`. The model endpoint can only be set in the user-level `~/.ant/settings.json`. Use `/key` to inspect or manage the saved DeepSeek credential; the command never displays the key.

`contextWindow` defaults to 1 000 000. A turn is limited to 15 minutes. A model request is retried (up to three times with 1 and 2 second pauses) only if the model was silent for 90 seconds, on a network error, `429`, or `5xx`.

## Verification gate

Before a turn is allowed to finish, Ant runs a mechanical self-verification gate: deterministic checks against the turn history and the proposed final answer, with no extra model call. If a check fails, the feedback is fed back to the model and the turn continues so it can correct the answer (or keep working). The gate never loops forever — it stops after `verification.maxRounds` extra attempts and then accepts the answer.

Available checks (`verification.checks`):

- `empty-answer` — the turn must not finish with a blank answer;
- `echo-task` — the answer must not just repeat the task verbatim;
- `failed-tools` — tool errors from this turn must be acknowledged in the final answer (by error code such as `ENOENT`, or by a failure phrase — quoting the full error text is not required).

Set `verification.enabled: false` to turn the gate off.

## Interactive mode

```bash
npm run dev
```

Or just `ant` if installed globally.

There are commands inside — `/help` shows the full list. Key ones: `/help (?, h)`, `/new (n)`, `/session (s)`, `/clear (c)`, `/context (ctx)`, `/compact (cmp)`, `/model (m)`, `/think (t)`, `/reasoning (r)`, `/key (k)`, `/balance (bal)`, `/update (u)`, `/exit (q)`.

- `/context` estimates context window usage locally and shows a breakdown; it does not call the API.
- `/compact` compresses the older part of the history into a summary, keeping the last two user turns verbatim. Original events stay in the JSONL.
- `/key` reports only whether the DeepSeek key is configured and its source; `/key set` securely replaces the saved credential and `/key clear` removes only the saved credential. `DEEPSEEK_API_KEY` is never changed and always has priority.
- `/balance` queries DeepSeek's official account endpoint directly. It does not use the configurable model `baseUrl`, so the API key is never sent to a model proxy for this account operation.
- `/model (m)` and `/think (t)` switch the model and reasoning mode on the fly:

```text
/model                     # show the current model
/model list                # list available models
/model deepseek-v4-pro     # switch the model
/model 2                   # switch by number from /model list
/think                     # show the reasoning mode
/think low|high|max|off    # set depth or disable thinking
/reasoning off|compact|full # choose reasoning display mode
```

`/model [list|id|N]` accepts either a model id or a 1-based number from `/model list`. If the argument looks like a positive integer, the number wins.

`/model`, `/think`, and `/reasoning` choices are saved to `~/.ant/settings.json`. If the project `.ant/settings.json` has the same keys, it wins — the command warns about it. `/help` also accepts `?` and `h`.

Reasoning display modes:

- `off` — hide model reasoning;
- `compact` — show a live scrolling viewport limited by `ui.reasoningMaxLines` (6 by default, 1–20);
- `full` — keep the complete reasoning stream in the terminal transcript.

The compact viewport grows gradually to its limit and then scrolls upward. Completed tables are aligned before display; tables wider than the terminal are shortened with ellipses so each record stays on one terminal row. Legacy `ui.showReasoning: true` is read as `compact`.

After each turn, Ant can print a short summary: which commands ran and which files changed (based on Git snapshots). It's off by default; enable it with `ui.showChanges: true` in settings. It's for visibility and doesn't block anything. Colored output can be disabled with `ui.color: false`.

### REPL input

On Windows the REPL uses the Windows Console API, so it supports multiline input without a TUI:

- `Enter` — send the message;
- `Shift+Enter` — new line;
- `Ctrl+C` — clear the draft (during a turn — cancel it);
- `↑`/`↓` — history of sent messages when the field is empty;
- `←`/`→`, `Home`, `End`, `Backspace`, `Delete` — editing.

Other platforms use standard `readline`. Emoji and wide Unicode characters may still affect the cursor position.

One-off task:

```bash
npm run dev -- "Read package.json and README.md, then explain the project structure"
```

Resume a saved session:

```bash
npm run dev -- -c
npm run dev -- -s <session-id>
```

## Updates

When the interactive mode starts, Ant checks GitHub Releases and, if a newer version is available, shows a hint below the banner:

```text
A new version of ant is available: v0.5.8 (you have 0.5.7)
Update globally: /update
```

`/update` downloads and installs the latest version globally. After updating, restart: `/exit`, then `ant -c` to resume the same session.

In development mode (`npm run dev` / `npm start`) the auto-check is disabled so it doesn't get in the way.

## Research materials

The live eval set and its documentation live in [`research/evaluation/`](research/evaluation/README.md). It is not part of the production build and makes paid API calls only when you explicitly run `npm run eval`.

## Workspace architecture

Ant is an npm-workspaces repository with explicit build and dependency boundaries:

- `packages/contracts` — shared release-level contracts such as the CLI version;
- `packages/core` — agent state, runtime, context and verification;
- `packages/app` — application use cases and public module ports;
- `packages/provider-deepseek` — the DeepSeek provider and its configuration section;
- `packages/session-jsonl` — JSONL and in-memory session stores;
- `packages/tools-coding` — the built-in coding tool pack;
- `packages/frontend-terminal` — terminal presentation, commands and platform ports;
- `packages/cli` — the composition root and the single distributable `ant` executable.

Every package exports only its root public API. Cross-package imports use package names; imports from another package's `src`, `dist`, or undeclared subpaths are rejected by architecture tests. `npm run build` compiles all TypeScript project references and then bundles the production composition into the CLI artifact. `npm pack --workspace ant` produces the installable tarball; users do not need to install or compose the internal workspaces themselves.

## External plugins

Ant supports explicitly installed external tool-pack plugins. A plugin runs as trusted JavaScript inside the Ant process: permissions record what the user approved and constrain the host capabilities passed to its tool pack, but they are not a security sandbox. Install only code you trust.

Plugin management does not require `DEEPSEEK_API_KEY`:

```bash
ant plugins list
ant plugins inspect example.tools
ant plugins install ./example-plugin --trust --allow=filesystem.read
ant plugins disable example.tools
ant plugins enable example.tools
ant plugins remove example.tools
```

`install` accepts a local npm-compatible directory or tarball and always invokes npm with lifecycle scripts disabled. Reinstalling is an atomic update: Ant validates and stages the new package before replacing the current version. Removal moves the installed package under `~/.ant/plugins/.trash`, so the files remain recoverable. Ant never downloads plugins directly or updates them automatically.

Each package contains `ant-plugin.json`:

```json
{
  "schemaVersion": 1,
  "id": "example.tools",
  "version": "1.0.0",
  "apiVersion": "^1.0.0",
  "entry": "./dist/index.js",
  "permissions": ["filesystem.read"]
}
```

Supported permissions are `filesystem.read`, `filesystem.write`, `process.spawn`, and `network`. The entrypoint must stay inside the installed package and default-export an object with `activate(context)`. Activation may return `toolPacks`; pack ids must equal the plugin id or start with `<plugin-id>.`, and every tool's `ownerId` must equal its pack id.

TypeScript authors can depend on the installed `ant` package without importing private workspaces:

```ts
import type { AntPlugin } from "ant/plugin-api";
import { validateExternalToolPack } from "ant/plugin-api";

const plugin: AntPlugin = {
  activate() {
    return { toolPacks: [myToolPack] };
  },
};

validateExternalToolPack("example.tools", myToolPack, testContext);
export default plugin;
```

The reusable validator applies the same ownership, duplicate-name, non-empty-pack, and permission checks used by the host. At startup, malformed, incompatible, disabled, or broken plugins are reported individually; they do not prevent other plugins or the built-in CLI from loading. Plugin API `1.x` currently supports tool packs only. Dynamic model providers, frontends, and session stores remain intentionally out of scope until their permission and lifecycle models are proven independently.

## Checks

```bash
npm run format:check
npm run lint
npm run check
npm test
npm run test:integration
npm run test:all
npm run build
npm start -- "Read README.md"
```

`test:integration` runs full CLI cycles in temporary directories against a local fake DeepSeek server. It covers both the source composition and an `npm pack` tarball installed into a clean project, including legacy settings, provider protocol, agent loop, a real file tool, terminal output, and the JSONL journal without using the external network or a paid API key.
