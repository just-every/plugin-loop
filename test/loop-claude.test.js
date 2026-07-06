"use strict";

const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { appendLoopReview, markLoopActivated, readLoopState, updateLoopState } = require("../scripts/lib/activation");
const { buildClaudeArgs } = require("../scripts/lib/claude-backend");
const { runLoopPromptReview, runLoopStopReview } = require("../scripts/lib/loop-client");

const CLAUDE_CONFIG = {
  backend: "claude",
  claudeBin: "claude",
  model: "test-model",
  effort: "",
  timeoutMs: 1000,
  maxContextChars: 4000,
  maxContinues: 8
};

function cliResult(structured, sessionId = "33333333-3333-4333-8333-333333333333") {
  return {
    status: 0,
    stdout: JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "ok",
      session_id: sessionId,
      structured_output: structured,
      total_cost_usd: 0.2
    }),
    stderr: ""
  };
}

function withTempCodexHome(fn) {
  const previous = process.env.CODEX_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-claude-"));
  process.env.CODEX_HOME = dir;
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    });
}

test("buildClaudeArgs allows only read-only workspace and web tools", () => {
  const args = buildClaudeArgs({
    schema: { type: "object" },
    model: "test-model",
    systemPrompt: "sys",
    resumeSessionId: "abc",
    effort: "high"
  });
  const tools = args[args.indexOf("--tools") + 1];
  const allowed = args[args.indexOf("--allowedTools") + 1];
  assert.strictEqual(tools, "Read,Glob,Grep,LS,WebSearch,WebFetch");
  assert.strictEqual(allowed, "Read,Glob,Grep,LS,WebSearch,WebFetch");
  assert.ok(!/Bash|Write|Edit|MultiEdit|NotebookEdit|TodoWrite/.test(tools + allowed), "no shell or write tools may reach the child");
  assert.ok(args.includes("--strict-mcp-config"), "workspace MCP configs must be ignored");
  assert.strictEqual(args[args.indexOf("--permission-mode") + 1], "dontAsk");
});

test("prompt and stop reviews share one resumable Fable session", () => withTempCodexHome(async (codexHome) => {
  const input = {
    cwd: process.cwd(),
    session_id: "loop-session",
    transcript_path: path.join(codexHome, "loop-transcript.jsonl")
  };
  markLoopActivated(input, { goal: "make all tests pass" });
  const calls = [];
  const runner = (invocation) => {
    calls.push(invocation);
    return calls.length === 1
      ? cliResult({ amended_prompt: "make tests pass, verify with npm test", review: "sharpened", confidence: "high" })
      : cliResult({ should_continue: true, next_prompt: "fix the failing assertion in foo.test.js", review: "tests still fail", confidence: "high" });
  };

  const promptReview = await runLoopPromptReview({ ...input, prompt: "make all tests pass" }, {
    config: CLAUDE_CONFIG,
    runClaude: runner
  });
  assert.strictEqual(promptReview.status, "ready");
  assert.strictEqual(promptReview.backend, "claude");
  assert.ok(!calls[0].args.includes("--resume"));
  assert.strictEqual(readLoopState(input).claude_session_id, "33333333-3333-4333-8333-333333333333");

  const stopReview = await runLoopStopReview({ ...input, last_assistant_message: "All done." }, {
    config: CLAUDE_CONFIG,
    runClaude: runner
  });
  assert.strictEqual(calls[1].args[calls[1].args.indexOf("--resume") + 1], "33333333-3333-4333-8333-333333333333");
  assert.match(calls[1].prompt, /make all tests pass/);
  assert.match(calls[1].prompt, /Codex's final message:\nAll done\./);
  assert.strictEqual(stopReview.should_continue, true);
  assert.strictEqual(stopReview.amended_prompt, "fix the failing assertion in foo.test.js");
}));

test("stop review does not continue without a next_prompt", () => withTempCodexHome(async () => {
  const input = { cwd: process.cwd(), session_id: "loop-session-2" };
  markLoopActivated(input, { goal: "goal" });
  const review = await runLoopStopReview({ ...input, last_assistant_message: "Done." }, {
    config: CLAUDE_CONFIG,
    runClaude: () => cliResult({ should_continue: true, review: "vague unease", confidence: "low" })
  });
  assert.strictEqual(review.should_continue, false);
}));

test("appendLoopReview keeps bounded review history", () => withTempCodexHome(async () => {
  const input = { cwd: process.cwd(), session_id: "loop-history" };
  markLoopActivated(input, { goal: "goal" });
  for (let index = 0; index < 55; index += 1) {
    appendLoopReview(input, { kind: "stop", decision: "allow", review: `review ${index}` });
  }
  const state = readLoopState(input);
  assert.strictEqual(state.reviews.length, 50);
  assert.strictEqual(state.reviews[0].review, "review 5");
  assert.strictEqual(state.reviews[49].review, "review 54");
}));

function spawnStopHook({ codexHome, cwd, sessionId, extraEnv = {} }) {
  return spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "stop.js")], {
    input: JSON.stringify({
      hook_event_name: "Stop",
      cwd,
      session_id: sessionId,
      turn_id: "turn-test",
      model: "test-model",
      permission_mode: "default",
      last_assistant_message: "I believe the goal is met."
    }),
    encoding: "utf8",
    env: { ...process.env, CODEX_HOME: codexHome, ANTHROPIC_API_KEY: "", ...extraEnv }
  });
}

test("stop hook allows stopping once the continuation cap is reached", () => withTempCodexHome(async (codexHome) => {
  const input = { cwd: process.cwd(), session_id: "loop-capped" };
  markLoopActivated(input, { goal: "goal" });
  updateLoopState(input, { continues: 2 });
  const result = spawnStopHook({
    codexHome,
    cwd: process.cwd(),
    sessionId: "loop-capped",
    extraEnv: { LOOP_MAX_CONTINUES: "2", LOOP_CLAUDE_BIN: "/nonexistent/claude" }
  });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.deepStrictEqual(JSON.parse(result.stdout), { continue: true });
  assert.match(result.stderr, /LOOP_MAX_CONTINUES/);
}));

test("stop hook blocks with a course correction and counts the continuation", () => withTempCodexHome(async (codexHome) => {
  const input = { cwd: process.cwd(), session_id: "loop-blocking" };
  markLoopActivated(input, { goal: "finish the feature" });

  const mockClaude = path.join(codexHome, "mock-claude.js");
  fs.writeFileSync(mockClaude, [
    "#!/usr/bin/env node",
    "process.stdout.write(JSON.stringify({",
    "  type: 'result', subtype: 'success', is_error: false, result: 'ok',",
    "  session_id: '44444444-4444-4444-8444-444444444444',",
    "  structured_output: { should_continue: true, next_prompt: 'Run npm test and fix the two failures.', review: 'Verification failed.', confidence: 'high' }",
    "}));",
    ""
  ].join("\n"), { mode: 0o755 });

  const result = spawnStopHook({
    codexHome,
    cwd: process.cwd(),
    sessionId: "loop-blocking",
    extraEnv: { LOOP_CLAUDE_BIN: mockClaude, LOOP_BACKEND: "claude" }
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.decision, "block");
  assert.match(output.reason, /Loop course correction/);
  assert.match(output.reason, /Run npm test and fix the two failures\./);
  const state = readLoopState(input);
  assert.strictEqual(state.continues, 1);
  assert.strictEqual(state.claude_session_id, "44444444-4444-4444-8444-444444444444");
  assert.strictEqual(state.reviews.length, 1);
  assert.strictEqual(state.reviews[0].decision, "block");
  assert.strictEqual(state.reviews[0].next_prompt, "Run npm test and fix the two failures.");
}));

test("a plain user prompt resets the continuation budget", () => withTempCodexHome(async (codexHome) => {
  const input = { cwd: process.cwd(), session_id: "loop-plain-prompt" };
  markLoopActivated(input, { goal: "goal" });
  updateLoopState(input, { continues: 5 });
  const result = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "user-prompt-submit.js")], {
    input: JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      cwd: process.cwd(),
      session_id: "loop-plain-prompt",
      turn_id: "turn-test",
      model: "test-model",
      permission_mode: "default",
      prompt: "ordinary follow-up without the loop token"
    }),
    encoding: "utf8",
    env: { ...process.env, CODEX_HOME: codexHome, ANTHROPIC_API_KEY: "" }
  });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.deepStrictEqual(JSON.parse(result.stdout), { continue: true });
  const state = readLoopState(input);
  assert.strictEqual(state.continues, 0);
}));

test("stop hook resets the counter when Fable approves stopping", () => withTempCodexHome(async (codexHome) => {
  const input = { cwd: process.cwd(), session_id: "loop-approving" };
  markLoopActivated(input, { goal: "finish the feature" });
  updateLoopState(input, { continues: 3 });

  const mockClaude = path.join(codexHome, "mock-claude-stop.js");
  fs.writeFileSync(mockClaude, [
    "#!/usr/bin/env node",
    "process.stdout.write(JSON.stringify({",
    "  type: 'result', subtype: 'success', is_error: false, result: 'ok',",
    "  session_id: '55555555-5555-4555-8555-555555555555',",
    "  structured_output: { should_continue: false, review: 'Goal verified met.', confidence: 'high' }",
    "}));",
    ""
  ].join("\n"), { mode: 0o755 });

  const result = spawnStopHook({
    codexHome,
    cwd: process.cwd(),
    sessionId: "loop-approving",
    extraEnv: { LOOP_CLAUDE_BIN: mockClaude, LOOP_BACKEND: "claude" }
  });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.deepStrictEqual(JSON.parse(result.stdout), { continue: true });
  const state = readLoopState(input);
  assert.strictEqual(state.continues, 0);
  assert.strictEqual(state.reviews.length, 1);
  assert.strictEqual(state.reviews[0].decision, "allow");
}));
