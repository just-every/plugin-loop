---
name: loop
description: Use when the user asks for Loop, Ultracode plus Peer, goal-loop course correction, parallel Codex worker orchestration with stop-time review, or Fable-guided progress checks while using Ultracode-style workflows.
---

# Loop

Loop combines Ultracode's worker orchestration engine with Fable-powered prompt and Stop-hook review.

Users activate the hook layer by including the literal token `$loop` in their prompt. Do not treat `Loop:loop`/`loop:loop` as hook activation; those names only load this skill for manual Loop/Ultracode workflow guidance.

Use the CLI from the plugin root:

```bash
node scripts/loop-cli.js "investigate this bug with parallel workers"
```

The orchestration CLI is compatible with Ultracode's existing surfaces: task sentence, `steps[]` DAG, `workers_spec[]`, imperative Workflow script, saved workflows, `resume`, and `status`. Only run the CLI when the user explicitly asks for Loop/Ultracode worker orchestration; do not run it merely because `$loop` appears in a prompt, since the hook already handled that before the turn.

Hooks add two behaviors (both run Fable via `claude -p`, resuming one persistent reviewer session per Codex thread so Fable keeps the goal and prior findings in context):

- `UserPromptSubmit`: Fable reviews the prompt and injects an amended working brief as additional context. The activating prompt is recorded as the loop's goal.
- `Stop`: Fable verifies workspace state with read-only tools before deciding. It blocks with a course-correction instruction only for concrete unfinished work, failed verification, or a needed redirect, capped at `LOOP_MAX_CONTINUES` consecutive continuations.

Read `references/quality-patterns.md` before designing a non-trivial worker run, then use `references/cookbook.md` or `references/cli.md` for exact workflow shape.
