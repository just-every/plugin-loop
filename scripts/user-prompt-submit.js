#!/usr/bin/env node
"use strict";

const { disabled, loadEnv } = require("./lib/env");
const { isChildSession, readHookInput } = require("./lib/hook-input");
const { additionalContextOutput, writeContinue, writeHookOutput } = require("./lib/hook-output");
const { submittedPrompt } = require("./lib/context");
const { appendLoopReview, hasLoopInvocation, isLoopActivated, markLoopActivated, stripLoopInvocation, updateLoopState } = require("./lib/activation");
const { formatPromptAdditionalContext, runLoopPromptReview } = require("./lib/loop-client");

async function main() {
  try {
    const input = readHookInput("UserPromptSubmit");
    loadEnv({ cwd: input.cwd });
    if (disabled() || isChildSession(input)) {
      writeContinue();
      return;
    }
    const submitted = submittedPrompt(input);
    if (!hasLoopInvocation(submitted)) {
      // Any new human prompt grants a fresh continuation budget for the
      // Stop-hook cap, even when it does not re-trigger prompt review.
      if (isLoopActivated(input)) updateLoopState(input, { continues: 0 });
      writeContinue();
      return;
    }
    const prompt = stripLoopInvocation(submitted);
    markLoopActivated(input, { goal: prompt });
    const review = await runLoopPromptReview({ ...input, prompt });
    if (review.status === "ready") {
      appendLoopReview(input, {
        kind: "prompt",
        decision: "reviewed",
        prompt: prompt.slice(0, 500),
        amended_prompt: review.amended_prompt,
        review: review.review,
        confidence: review.confidence,
        model: review.model,
        backend: review.backend
      });
      writeHookOutput(additionalContextOutput(formatPromptAdditionalContext(review)));
      return;
    }
  } catch (error) {
    process.stderr.write(`Loop prompt review failed: ${error.message}\n`);
  }
  writeContinue();
}

main().catch((error) => {
  process.stderr.write(`Loop UserPromptSubmit failed: ${error.message}\n`);
  writeContinue();
});
