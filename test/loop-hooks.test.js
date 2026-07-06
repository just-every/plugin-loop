"use strict";

const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  hasLoopInvocation,
  isLoopActivated,
  markLoopActivated,
  stripLoopInvocation
} = require("../scripts/lib/activation");
const {
  formatPromptAdditionalContext,
  formatStopReason,
  runLoopPromptReview,
  runLoopStopReview
} = require("../scripts/lib/loop-client");

function fakeCreateToolFunction(fn, _description, _params, _returns, name) {
  return { name, function: fn };
}

function fakeEnsemble({ shouldContinue = false } = {}) {
  return {
    ensembleRequest(_messages, agent) {
      const returnTool = agent.tools.find((tool) => tool.name === "return_prompt");
      returnTool.function(
        shouldContinue ? "Run tests and fix the failing assertion." : "Proceed with tests.",
        shouldContinue ? "Verification is missing." : "Prompt sharpened.",
        shouldContinue,
        "high"
      );
      return (async function* stream() {})();
    },
    async ensembleResult() {
      return {
        completed: true,
        message: "done",
        requestStatus: "completed",
        messageIds: new Set(),
        startTime: new Date()
      };
    }
  };
}

test("loop invocation requires $loop and activation is session scoped", () => {
  assert.strictEqual(hasLoopInvocation("Please continue"), false);
  assert.strictEqual(hasLoopInvocation("$loop Please continue"), true);
  assert.strictEqual(stripLoopInvocation("$loop: Please continue"), "Please continue");

  const previous = process.env.CODEX_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-activation-"));
  process.env.CODEX_HOME = dir;
  try {
    const input = {
      cwd: process.cwd(),
      session_id: "session-a",
      transcript_path: path.join(dir, "transcript.jsonl")
    };
    assert.strictEqual(isLoopActivated(input), false);
    markLoopActivated(input);
    assert.strictEqual(isLoopActivated(input), true);
    assert.strictEqual(isLoopActivated({ ...input, session_id: "session-b" }), false);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});

test("hooks noop without $loop activation", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-hooks-"));
  const baseInput = {
    cwd: process.cwd(),
    session_id: "session-test",
    turn_id: "turn-test",
    model: "test-model",
    permission_mode: "default",
    transcript_path: path.join(dir, "transcript.jsonl")
  };
  const env = { ...process.env, ANTHROPIC_API_KEY: "", CODEX_HOME: dir };
  const userPrompt = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "user-prompt-submit.js")], {
    input: JSON.stringify({ ...baseInput, hook_event_name: "UserPromptSubmit", prompt: "ordinary prompt" }),
    encoding: "utf8",
    env
  });
  assert.strictEqual(userPrompt.status, 0, userPrompt.stderr);
  assert.deepStrictEqual(JSON.parse(userPrompt.stdout), { continue: true });

  const stop = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "stop.js")], {
    input: JSON.stringify({ ...baseInput, hook_event_name: "Stop", last_assistant_message: "Done." }),
    encoding: "utf8",
    env
  });
  assert.strictEqual(stop.status, 0, stop.stderr);
  assert.deepStrictEqual(JSON.parse(stop.stdout), { continue: true });
});

test("prompt review returns additional context text", async () => {
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  try {
    const review = await runLoopPromptReview({ prompt: "do it", cwd: process.cwd() }, {
      createToolFunction: fakeCreateToolFunction,
      ensemble: fakeEnsemble(),
      config: { model: "test-model", timeoutMs: 1000, maxContextChars: 4000 }
    });
    assert.strictEqual(review.status, "ready");
    assert.match(formatPromptAdditionalContext(review), /# Loop prompt review/);
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  }
});

test("stop review formats course correction only when continuation is requested", async () => {
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  try {
    const review = await runLoopStopReview({
      cwd: process.cwd(),
      last_assistant_message: "Done."
    }, {
      createToolFunction: fakeCreateToolFunction,
      ensemble: fakeEnsemble({ shouldContinue: true }),
      config: { model: "test-model", timeoutMs: 1000, maxContextChars: 4000 }
    });
    assert.strictEqual(review.should_continue, true);
    assert.match(formatStopReason(review), /Loop course correction/);
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  }
});

test("prompt review retries in the same message thread with only return_prompt", async () => {
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  let calls = 0;
  let secondMessages = null;
  try {
    const review = await runLoopPromptReview({ prompt: "do it", cwd: process.cwd() }, {
      createToolFunction: fakeCreateToolFunction,
      ensemble: {
        ensembleRequest(messages, agent) {
          calls += 1;
          if (calls === 2) {
            secondMessages = messages;
            assert.deepStrictEqual(agent.tools.map((tool) => tool.name), ["return_prompt"]);
            const returnTool = agent.tools.find((tool) => tool.name === "return_prompt");
            returnTool.function("Run the test suite.", "Converted exploration into a direct next step.", false, "high");
          }
          return (async function* stream() {})();
        },
        async ensembleResult() {
          if (calls === 1) {
            return {
              completed: false,
              failure: { error: "Tool call rounds limit reached (8)" },
              responseOutputs: [{ type: "message", role: "assistant", content: "I searched files but did not return." }],
              requestStatus: "failed",
              messageIds: new Set(),
              startTime: new Date()
            };
          }
          return {
            completed: true,
            message: "done",
            requestStatus: "completed",
            messageIds: new Set(),
            startTime: new Date()
          };
        }
      },
      config: { model: "test-model", timeoutMs: 1000, maxContextChars: 4000 }
    });
    assert.strictEqual(calls, 2);
    assert.ok(secondMessages.some((message) => message.content === "I searched files but did not return."));
    assert.ok(secondMessages.some((message) => /Continue the same message thread/.test(String(message.content || ""))));
    assert.strictEqual(review.amended_prompt, "Run the test suite.");
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  }
});
