"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { markLoopActivated, readLoopState } = require("../scripts/lib/activation");
const { runLoopStopReview } = require("../scripts/lib/loop-client");
const {
  RAW_INCLUDE_LIMIT,
  collectTurnDigest,
  readTranscriptDelta
} = require("../scripts/lib/transcript-digest");

const CLAUDE_CONFIG = {
  backend: "claude",
  claudeBin: "claude",
  model: "test-model",
  effort: "",
  timeoutMs: 1000,
  maxContextChars: 4000,
  maxContinues: 8,
  digestModel: "haiku",
  digestTimeoutMs: 1000,
  digestMaxChars: 150000
};

function transcriptLine(role, text) {
  return `${JSON.stringify({ payload: { type: "message", role, content: text } })}\n`;
}

function plainCliResult(result) {
  return { status: 0, stdout: JSON.stringify({ type: "result", is_error: false, result, session_id: "x" }), stderr: "" };
}

function structuredCliResult(structured) {
  return {
    status: 0,
    stdout: JSON.stringify({
      type: "result",
      is_error: false,
      result: "ok",
      session_id: "66666666-6666-4666-8666-666666666666",
      structured_output: structured
    }),
    stderr: ""
  };
}

test("readTranscriptDelta only returns events past the stored offset", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-digest-"));
  const transcript = path.join(dir, "t.jsonl");
  fs.writeFileSync(transcript, transcriptLine("user", "first turn"), "utf8");
  const first = readTranscriptDelta(transcript, 0);
  assert.match(first.text, /user: first turn/);
  fs.appendFileSync(transcript, transcriptLine("assistant", "I did the thing"), "utf8");
  const second = readTranscriptDelta(transcript, first.offset);
  assert.strictEqual(second.text, "assistant: I did the thing");
  assert.ok(second.offset > first.offset);
  // A truncated/rotated transcript resets to the full content instead of erroring.
  const reset = readTranscriptDelta(transcript, second.offset + 9999);
  assert.match(reset.text, /first turn/);
});

test("small deltas are included verbatim without calling the digest model", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-digest-"));
  const transcript = path.join(dir, "t.jsonl");
  fs.writeFileSync(transcript, transcriptLine("assistant", "short update"), "utf8");
  let digestCalls = 0;
  const { digest } = collectTurnDigest(
    { transcript_path: transcript, cwd: dir },
    {},
    CLAUDE_CONFIG,
    () => { digestCalls += 1; return plainCliResult("unused"); }
  );
  assert.strictEqual(digestCalls, 0);
  assert.match(digest, /raw excerpt/);
  assert.match(digest, /short update/);
});

test("large deltas are summarized by the digest model and failures fall back to a raw tail", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-digest-"));
  const transcript = path.join(dir, "t.jsonl");
  fs.writeFileSync(transcript, transcriptLine("assistant", "x".repeat(RAW_INCLUDE_LIMIT + 100)), "utf8");

  const summarized = collectTurnDigest({ transcript_path: transcript, cwd: dir }, {}, CLAUDE_CONFIG, (invocation) => {
    assert.strictEqual(invocation.args[invocation.args.indexOf("--model") + 1], "haiku");
    assert.ok(invocation.args.includes("--no-session-persistence"));
    assert.strictEqual(invocation.args[invocation.args.indexOf("--tools") + 1], "");
    return plainCliResult("Codex changed 3 files; tests fail 2/40.");
  });
  assert.match(summarized.digest, /digest by haiku/);
  assert.match(summarized.digest, /tests fail 2\/40/);

  const fallback = collectTurnDigest({ transcript_path: transcript, cwd: dir }, {}, CLAUDE_CONFIG, () => ({
    status: 1,
    stdout: "",
    stderr: "boom"
  }));
  assert.match(fallback.digest, /raw excerpt; digest unavailable/);
});

test("stop review includes the digest and advances the transcript offset", async () => {
  const previous = process.env.CODEX_HOME;
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "loop-digest-home-"));
  process.env.CODEX_HOME = codexHome;
  try {
    const transcript = path.join(codexHome, "t.jsonl");
    fs.writeFileSync(transcript, transcriptLine("assistant", "y".repeat(RAW_INCLUDE_LIMIT + 100)), "utf8");
    const input = {
      cwd: process.cwd(),
      session_id: "loop-digest-session",
      transcript_path: transcript,
      last_assistant_message: "Done."
    };
    markLoopActivated(input, { goal: "the goal" });

    let mainPrompt = null;
    const review = await runLoopStopReview(input, {
      config: CLAUDE_CONFIG,
      runClaudeDigest: () => plainCliResult("Digest: two tests still failing."),
      runClaude: (invocation) => {
        mainPrompt = invocation.prompt;
        return structuredCliResult({ should_continue: false, review: "verified", confidence: "high" });
      }
    });
    assert.strictEqual(review.status, "ready");
    assert.match(mainPrompt, /Codex session activity since your last review \(digest by haiku\)/);
    assert.match(mainPrompt, /two tests still failing/);
    const state = readLoopState(input);
    assert.strictEqual(state.transcript_offset, fs.statSync(transcript).size);

    // Next stop with no new transcript content carries no digest section.
    let secondPrompt = null;
    await runLoopStopReview(input, {
      config: CLAUDE_CONFIG,
      runClaudeDigest: () => { throw new Error("must not be called"); },
      runClaude: (invocation) => {
        secondPrompt = invocation.prompt;
        return structuredCliResult({ should_continue: false, review: "still verified", confidence: "high" });
      }
    });
    assert.ok(!/Codex session activity/.test(secondPrompt));
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});
