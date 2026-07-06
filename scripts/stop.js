#!/usr/bin/env node
"use strict";

const { config, disabled, loadEnv } = require("./lib/env");
const { isChildSession, readHookInput } = require("./lib/hook-input");
const { writeContinue, writeHookOutput } = require("./lib/hook-output");
const { isLoopActivated, readLoopState, updateLoopState } = require("./lib/activation");
const { formatStopReason, runLoopStopReview } = require("./lib/loop-client");

async function main() {
  try {
    const input = readHookInput("Stop");
    loadEnv({ cwd: input.cwd });
    if (disabled() || isChildSession(input) || !isLoopActivated(input)) {
      writeContinue();
      return;
    }
    const cfg = config();
    const state = readLoopState(input);
    const continues = Number(state.continues) || 0;
    if (continues >= cfg.maxContinues) {
      process.stderr.write(`Loop reached LOOP_MAX_CONTINUES (${cfg.maxContinues}); allowing Codex to stop.\n`);
      writeContinue();
      return;
    }
    const review = await runLoopStopReview(input);
    if (review.status === "ready" && review.should_continue && review.amended_prompt) {
      updateLoopState(input, { continues: continues + 1, last_stop_review: review.review });
      writeHookOutput({
        continue: true,
        decision: "block",
        reason: formatStopReason(review)
      });
      return;
    }
    if (review.status === "ready") {
      updateLoopState(input, { continues: 0, last_stop_review: review.review });
    }
  } catch (error) {
    process.stderr.write(`Loop Stop review failed: ${error.message}\n`);
  }
  writeContinue();
}

main().catch((error) => {
  process.stderr.write(`Loop Stop failed: ${error.message}\n`);
  writeContinue();
});
