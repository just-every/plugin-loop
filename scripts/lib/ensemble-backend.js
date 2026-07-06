"use strict";

const { requireKey } = require("./env");
const { readRecentConversation } = require("./context");
const { createWorkspaceTools } = require("./workspace-tools");

const PROMPT_INSTRUCTIONS = [
  "You are Fable acting as a Loop peer programmer for Codex.",
  "Improve the submitted prompt for a goal-loop coding agent.",
  "Preserve user intent while tightening scope, risks, verification, and course-correction signals.",
  "You must call return_prompt.",
  "End position: the prompt review is complete only after return_prompt has been called with amended_prompt, review, should_continue, and confidence."
].join("\n");

const STOP_INSTRUCTIONS = [
  "You are Fable acting as a Stop-hook progress reviewer for Loop.",
  "Check whether Codex genuinely completed the user's request.",
  "Use read-only tools only when needed.",
  "Call return_prompt with a concise review.",
  "Set should_continue true only for concrete unfinished work, failed verification, or a course correction Codex should perform now.",
  "End position: the stop review is complete only after return_prompt has been called with amended_prompt, review, should_continue, and confidence."
].join("\n");

async function runEnsemblePromptReview(input, options, cfg) {
  return runFableToolLoop({
    input,
    options,
    cfg,
    instructions: PROMPT_INSTRUCTIONS,
    prompt: buildPromptReviewPrompt(input),
    mode: "prompt"
  });
}

async function runEnsembleStopReview(input, options, cfg) {
  return runFableToolLoop({
    input,
    options,
    cfg,
    instructions: STOP_INSTRUCTIONS,
    prompt: buildStopReviewPrompt(input),
    mode: "stop"
  });
}

async function runFableToolLoop({ input, options, cfg, instructions, prompt, mode }) {
  requireKey();
  const ensemble = options.ensemble || await loadEnsemble();
  const createToolFunction = options.createToolFunction || ensemble.createToolFunction;
  const cwd = input.cwd || options.cwd || process.cwd();
  let returned = null;
  const workspaceTools = createWorkspaceTools(cwd, createToolFunction);
  const returnTool = createToolFunction(
      async function return_prompt(amended_prompt, review = "", should_continue = false, confidence = "medium") {
        returned = {
          amended_prompt: String(amended_prompt || "").trim(),
          review: String(review || "").trim(),
          should_continue: Boolean(should_continue),
          confidence: normalizeConfidence(confidence)
        };
        return "Loop review received.";
      },
      "Return the Loop review. This tool is required.",
      {
        amended_prompt: { type: "string", description: "Prompt or continuation instruction." },
        review: { type: "string", description: "Short reason for the recommendation.", optional: true },
        should_continue: { type: "boolean", description: "Whether Codex should continue instead of stopping.", optional: true },
        confidence: { type: "string", description: "low, medium, or high.", enum: ["low", "medium", "high"], optional: true }
      },
      undefined,
      "return_prompt",
      false
  );

  const messages = [{
    type: "message",
    role: "user",
    content: `${prompt}\n\nRequired end position: call return_prompt with amended_prompt, review, should_continue, and confidence. Do not end in plain text.`.slice(0, cfg.maxContextChars)
  }];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    returned = null;
    const agent = {
      model: cfg.model,
      instructions,
      tools: attempt === 1 ? [...workspaceTools, returnTool] : [returnTool],
      maxToolCallRoundsPerTurn: 8,
      maxToolCalls: 20,
      modelSettings: { timeout_ms: cfg.timeoutMs }
    };
    const result = await ensemble.ensembleResult(ensemble.ensembleRequest(messages, agent));
    appendResultToThread(messages, result);
    if (!result.completed) {
      const reason = result.failure?.error || result.error || "Loop Fable request failed.";
      if (isReturnPromptRetryable(reason) && attempt < 3) {
        messages.push({
          type: "message",
          role: "user",
          content: buildRetryPrompt({ reason, mode, nextAttempt: attempt + 1 })
        });
        continue;
      }
      throw new Error(reason);
    }
    if (returned && returned.amended_prompt) {
      return {
        status: "ready",
        mode,
        ...returned,
        attempts: attempt,
        model: cfg.model,
        backend: "ensemble",
        usage: result.cost
      };
    }
    if (attempt < 3) {
      messages.push({
        type: "message",
        role: "user",
        content: buildRetryPrompt({
          reason: result.message || "The previous attempt completed without calling return_prompt.",
          mode,
          nextAttempt: attempt + 1
        })
      });
    }
  }
  throw new Error("Fable did not call return_prompt after 3 attempts.");
}

function isReturnPromptRetryable(reason) {
  return /tool call rounds limit reached|tool calls limit reached/i.test(String(reason || ""));
}

function appendResultToThread(messages, result) {
  if (Array.isArray(result.responseOutputs) && result.responseOutputs.length > 0) {
    messages.push(...result.responseOutputs);
    return;
  }
  if (result.message) {
    messages.push({ type: "message", role: "assistant", content: result.message });
  }
}

function buildRetryPrompt({ reason, mode, nextAttempt }) {
  return [
    `Continue the same message thread for ${mode} review attempt ${nextAttempt}.`,
    "Use the tool calls, tool outputs, and reasoning already present in this thread. Do not repeat workspace exploration.",
    "Only the return_prompt tool is available now.",
    "Required end position: the next assistant tool action should be return_prompt({ amended_prompt, review, should_continue, confidence }).",
    "",
    "Previous attempt did not reach that end position:",
    String(reason || "return_prompt was not called.")
  ].join("\n");
}

function buildPromptReviewPrompt(input) {
  const conversation = input.conversation || readRecentConversation(input.transcript_path);
  return [
    "Review this new Loop/Codex prompt before the agent acts.",
    "",
    "Submitted prompt:",
    input.prompt || "",
    "",
    "Recent conversation:",
    conversation.map((message) => `${message.role}: ${message.text}`).join("\n\n") || "none",
    "",
    "Return an amended prompt that improves execution quality without changing intent."
  ].join("\n");
}

function buildStopReviewPrompt(input) {
  const conversation = readRecentConversation(input.transcript_path);
  return [
    "Review whether Codex should stop or continue.",
    "",
    "Latest assistant message:",
    input.last_assistant_message || "",
    "",
    "Recent conversation:",
    conversation.map((message) => `${message.role}: ${message.text}`).join("\n\n") || "none",
    "",
    "If continuing is needed, return a direct next prompt for Codex. Otherwise set should_continue false."
  ].join("\n");
}

function normalizeConfidence(value) {
  return ["low", "medium", "high"].includes(value) ? value : "medium";
}

async function loadEnsemble() {
  return require("@just-every/ensemble");
}

module.exports = {
  buildPromptReviewPrompt,
  buildRetryPrompt,
  buildStopReviewPrompt,
  isReturnPromptRetryable,
  normalizeConfidence,
  runEnsemblePromptReview,
  runEnsembleStopReview
};
