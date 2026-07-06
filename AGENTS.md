# Loop Repository Guide

- NEVER write mock code or fallbacks to solve product issues. Mock data is allowed in test suites only.
- Prefer removing deprecated code over hiding it behind flags or leaving unused code paths around.
- Avoid large monolithic files. Put new code into logically separated modules when the behavior is substantial.
- Treat LLM failures as instruction, schema, normalization, or edge-case handling failures. Fix those directly instead of adding fallbacks.
- Keep worker execution parallel by default. Add throttling only after measuring real limits.

Loop is a Codex CLI plugin that combines Ultracode's parallel worker orchestration layer with Fable-powered prompt and Stop-hook review. Worker orchestration still fans out real `codex exec` subprocesses. Hook review runs Fable 5 through the Claude Code CLI (`claude -p` with read-only tools and one resumable session per Codex thread), with a legacy `@just-every/ensemble` API fallback.

## Main Components

- `.codex-plugin/plugin.json` declares Loop metadata, hooks, and interface.
- `hooks/hooks.json` declares `UserPromptSubmit` and `Stop` command hooks.
- `scripts/loop-cli.js` is the public CLI wrapper.
- `scripts/ultracode-engine.js` owns worker spawning, schema validation, concurrency, usage accounting, persisted workflow state, resume, and exported scripted primitives.
- `scripts/lib/loop-client.js` owns Fable prompt and Stop review, dispatching to `lib/claude-backend.js` (claude -p, structured output, session resume via `lib/session-state.js`) or `lib/ensemble-backend.js` (legacy `return_prompt` tool-call loop).
- `scripts/ultracode-script-runner.js` is the imperative Workflow-script runner.
- `scripts/app-server-client.js` is the dependency-free `codex app-server` JSON-RPC client for the opt-in `transport: 'app-server'` path.
- `test/` holds the Node test suite and mock Codex fixtures.
- `examples/` holds runnable Workflow scripts.

## Runtime Behavior

Loop workers are real Codex subprocesses, not mocked agents. Worker output is schema-validated when a schema is provided, usage is aggregated from Codex JSON events, and workflow state is written under `$CODEX_HOME/ultracode/runs/` for compatibility with the inherited engine.

Fable hook review fails open on configuration or provider errors. Stop review blocks only when Fable returns concrete unfinished work or a course correction, capped at `LOOP_MAX_CONTINUES` consecutive continuations tracked in `$CODEX_HOME/loop/sessions/`.

Temporary schemas, last-message files, and isolated worktrees are created under the OS temp directory. They should not create tracked files in this repository.

The Workflow-script runner executes scripts in-process through the CLI. Do not add environment dumps or noisy host-state logging.

## Testing

The orchestration suite runs entirely offline against a mock Codex binary. Tests must never call the real, paid `codex` CLI or Fable provider.

- Run everything with `npm test` or directly with `node --test "test/**/*.test.js"`.
- Run a single file with `node --test test/<file>.test.js`.
- `test/fixtures/mock-codex.js` is the env-driven stand-in for `codex`.
- Always set `CODEX_HOME` to a temp dir and point `CODEX_CLI_PATH` or `codex_bin` at the mock when running examples or tests.

## Development Notes

- Keep the inherited orchestration engine dependency-free unless there is a strong reason to change that.
- Keep Fable review code in `scripts/lib/` (loop-client, claude-backend, ensemble-backend, session-state) and hook scripts, away from the engine core.
- Preserve the existing CLI and engine contracts when adding orchestration features.
- Prefer explicit failures and logged events over silent fallbacks.
- The script runner top-level-`require`s the engine; the engine must NOT top-level-`require` the runner.
- Do not commit local `.claude/` files, `.DS_Store`, `node_modules/`, or generated run state.
