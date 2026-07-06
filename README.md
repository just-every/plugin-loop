# Loop

Loop combines Ultracode's parallel Codex worker orchestration with Fable-powered prompt review and Stop-hook course correction. Fable oversees the goal loop; Codex executes.

The Fable hook layer is opt-in per Codex thread. Start a prompt with `[loop]` or include `[loop]` in the prompt to activate Loop review for that thread. Prompts without `[loop]` are passed through unchanged, and the Stop hook stays inactive until a `[loop]` prompt marks the thread active.

The orchestration engine is copied from Ultracode so this plugin can be installed as a standalone public plugin. The CLI wrapper is:

```bash
node scripts/loop-cli.js "investigate this bug with parallel workers"
```

The underlying workflow surfaces remain compatible with Ultracode: task fan-out, `steps[]` DAGs, `workers_spec[]`, imperative Workflow scripts, saved workflows, resume, status, budgets, and the run dashboard.

## Fable Hooks

`hooks/hooks.json` defines:

- `UserPromptSubmit`: when the prompt contains `[loop]`, asks Fable to improve the prompt and injects the result as additional context. The activating prompt is recorded as the loop's goal.
- `Stop`: after a `[loop]` prompt has activated the current thread, asks Fable whether the goal is genuinely met — Fable verifies with read-only tools (git status/diff, file reads) rather than trusting Codex's final message. Fable also receives a **turn digest**: the hook reads the full transcript delta since Fable's last review and summarizes it with a cheap model (`LOOP_DIGEST_MODEL`, default `haiku`, one-shot `claude -p` with no tools) so Fable sees what Codex actually did — commands run, test results, errors — not just the final claim. Small deltas are included verbatim; digest failures fall back to a raw excerpt. It blocks with a course-correction instruction only for concrete unfinished work, failed verification, or a needed redirect. Consecutive forced continuations are capped by `LOOP_MAX_CONTINUES` (default 8); the counter resets on any new user prompt or an approved stop.

Loop does not install or trust hooks automatically.

## How Fable is called

Loop talks to Fable through the Claude Code CLI in headless mode (`claude -p`) by default:

- **Subscription auth** — uses your existing `claude` login; no `ANTHROPIC_API_KEY` needed.
- **One persistent Fable session per Codex thread** — the prompt review creates a Claude session and every later review (including Stop reviews) `--resume`s it, so Fable remembers the goal and everything it already verified. State lives under `$CODEX_HOME/loop/sessions/`.
- **Structurally read-only** — the child gets `--tools Read,Glob,Grep` only (no Bash, no write tools), `--permission-mode dontAsk`, `--setting-sources user`, `--strict-mcp-config`, and hooks disabled. Git state (branch, status, commits, diffstat — plus the working-tree diff for Stop reviews) is collected by the hook with a sanitized environment and injected into the prompt.
- **Structured output** via `--json-schema` — no tool-call retry protocol.
- **No key leakage** — `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` and `NODE_OPTIONS` are stripped from the child environment; `.env` files are read with an allowlist (only `LOOP_*` keys and `ANTHROPIC_API_KEY`).

If the `claude` CLI is not installed and `ANTHROPIC_API_KEY` is set, Loop falls back to the legacy `@just-every/ensemble` API backend.

## Configuration

Optional environment variables (environment, project `.env`, plugin `.env`, or `~/.env`):

```bash
LOOP_DISABLED=1              # turn the hooks off
LOOP_BACKEND=auto            # auto (default) | claude | ensemble
LOOP_CLAUDE_BIN=claude       # path to the Claude Code CLI
LOOP_MODEL=claude-fable-5    # model passed to the backend
LOOP_EFFORT=                 # optional --effort for the claude backend (low..max)
LOOP_TIMEOUT_MS=1200000      # per-review timeout (20 minutes)
LOOP_MAX_CONTEXT_CHARS=16000 # cap on conversation context sent with the prompt
LOOP_MAX_CONTINUES=8         # max consecutive Stop-hook continuations
LOOP_DIGEST_MODEL=haiku      # model that summarizes the turn transcript for stop reviews (off to disable)
LOOP_DIGEST_TIMEOUT_MS=60000 # digest call timeout
LOOP_DIGEST_MAX_CHARS=150000 # cap on transcript text fed to the digest model
```

`ANTHROPIC_API_KEY` is only required for the `ensemble` backend.

## Development

```bash
npm test
```
