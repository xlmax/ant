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

> [!WARNING]
> Ant has no built-in guardrails: it runs commands and edits files with the same permissions as the user who launched it, and it is not confined to the working directory. Any consequences are your responsibility. Don't run it in directories with sensitive data or use keys with a valuable balance.

## Sessions

Every run writes a JSONL journal to `.ant/sessions/<session-id>.jsonl`: tasks, model decisions, and final tool results. Transient events are not written there, and the directory is ignored by Git.

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

Put a temporary key in `.env.local` in the working directory, or globally in `~/.ant/.env.local`:

```dotenv
DEEPSEEK_API_KEY=your_temporary_key
```

The file in the working directory takes priority over the global one, and an environment variable takes priority over both. Both files are ignored by Git.

### System prompt

Before the first model call, Ant assembles the system prompt from Markdown files in this order:

1. `prompts/SYSTEM.md` — base instructions;
2. `~/.ant/SYSTEM.md` — global user instructions, if the file exists;
3. `.ant/SYSTEM.md` in the working directory — project-specific instructions, if the file exists;
4. paths from `prompts.additionalPaths` in settings.

Later files extend earlier ones. The prompt applies to every model call in the current process, so restart the REPL after changing a file.

### Settings

Non-secret settings are layered: `~/.ant/settings.json`, then `.ant/settings.json` in the working directory. The project file overrides the global one.

```json
{
  "model": {
    "provider": "deepseek",
    "id": "deepseek-v4-flash",
    "baseUrl": "https://api.deepseek.com",
    "contextWindow": 1000000,
    "vision": false,
    "thinking": { "enabled": true, "effort": "high" }
  },
  "ui": { "showReasoning": false, "showChanges": false, "color": true },
  "prompts": { "additionalPaths": ["prompts/local.md"] },
  "tools": { "bashPath": "C:\\Program Files\\Git\\bin\\bash.exe" },
  "limits": {
    "turnTimeoutSeconds": 900,
    "modelRequestTimeoutSeconds": 90,
    "modelMaxAttempts": 3
  },
  "verification": {
    "enabled": true,
    "maxRounds": 2,
    "checks": ["empty-answer", "echo-task", "failed-tools"]
  }
}
```

Only `deepseek` is supported. For a custom vision model, set `model.vision: true`. To reset an inherited `tools.bashPath` in project settings, set `"bashPath": null`. `model.baseUrl` can only be set in the user-level `~/.ant/settings.json` — a project file cannot override it. All app settings live in JSON; keep only `DEEPSEEK_API_KEY` in `.env.local`.

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

There are commands inside — `/help` shows the full list. Key ones: `/new`, `/session`, `/clear`, `/context`, `/compact`, `/model`, `/think`, `/reasoning`, `/update`, `/exit`.

- `/context` estimates context window usage locally and shows a breakdown; it does not call the API.
- `/compact` compresses the older part of the history into a summary, keeping the last two user turns verbatim. Original events stay in the JSONL.
- `/model` and `/think` switch the model and reasoning mode on the fly:

```text
/model                     # show the current model
/model list                # list available models
/model deepseek-v4-pro     # switch the model
/think                     # show the reasoning mode
/think low|high|max|off    # set depth or disable thinking
/reasoning on|off          # show or hide reasoning in the UI
```

`/model`, `/think`, and `/reasoning` choices are saved to `~/.ant/settings.json`. If the project `.ant/settings.json` has the same keys, it wins — the command warns about it.

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

## Checks

```bash
npm run format:check
npm run lint
npm run check
npm test
npm run build
npm start -- "Read README.md"
```
