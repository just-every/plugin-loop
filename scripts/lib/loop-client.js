"use strict";

const { config, hasApiKey, loadEnv } = require("./env");
const { readRecentConversation } = require("./context");
const { runClaudeStructured } = require("./claude-backend");
const { collectGitContext } = require("./git-context");
const { collectTurnDigest, transcriptLength } = require("./transcript-digest");
const { readLoopState, updateLoopState } = require("./activation");
const {
  buildPromptReviewPrompt,
  buildRetryPrompt,
  buildStopReviewPrompt,
  isReturnPromptRetryable,
  normalizeConfidence,
  runEnsemblePromptReview,
  runEnsembleStopReview
} = require("./ensemble-backend");

const PROMPT_SCHEMA = {
  type: "object",
  properties: {
    amended_prompt: {
      type: "string",
      description: "The improved working brief for the goal loop. Preserve the user's intent; define the goal state, constraints, risks, and how Codex should verify completion."
    },
    review: {
      type: "string",
      description: "Short explanation of what you changed or flagged, and why."
    },
    confidence: {
      type: "string",
      enum: ["low", "medium", "high"]
    }
  },
  required: ["amended_prompt", "review", "confidence"],
  additionalProperties: false
};

const STOP_SCHEMA = {
  type: "object",
  properties: {
    should_continue: {
      type: "boolean",
      description: "True only for concrete unfinished work, failed verification, or a course correction Codex should perform now."
    },
    next_prompt: {
      type: "string",
      description: "When should_continue is true: a direct, self-contained instruction for what Codex must do next."
    },
    review: {
      type: "string",
      description: "Short justification of the decision, citing what you verified."
    },
    confidence: {
      type: "string",
      enum: ["low", "medium", "high"]
    }
  },
  required: ["should_continue", "review", "confidence"],
  additionalProperties: false
};

const CLAUDE_SYSTEM_PROMPT = [
  "You are Fable acting as the peer reviewer overseeing a Codex goal-loop session (Loop).",
  "Codex executes all work, often with parallel workers; you provide oversight only. Never write code or edit files yourself.",
  "You are consulted at two points: when a prompt is submitted (turn it into a sharper working brief with a clear goal state and verification steps) and when Codex tries to stop (decide whether the goal is genuinely met).",
  "For stop reviews, verify rather than trust: current git state is included in each request, and you can read the touched files with your read-only tools (Read, Glob, Grep) before deciding. Only continue the loop for concrete unfinished work, failed verification, or a needed course correction — not for optional polish.",
  "This session persists across the whole Codex thread. Remember the goal and what you already verified; do not re-explore from scratch."
].join("\n");

async function runLoopPromptReview(input, options = {}) {
  return dispatch("prompt", input, options);
}

async function runLoopStopReview(input, options = {}) {
  return dispatch("stop", input, options);
}

async function dispatch(mode, input, options) {
  loadEnv({ cwd: input.cwd || options.cwd, pluginRoot: options.pluginRoot });
  const cfg = { ...config(), ...(options.config || {}) };
  const backend = options.config && options.config.backend
    ? options.config.backend
    : (options.ensemble ? "ensemble" : cfg.backend);
  const runEnsemble = mode === "prompt" ? runEnsemblePromptReview : runEnsembleStopReview;
  if (backend === "ensemble") return runEnsemble(input, options, cfg);
  try {
    return await runClaudeReview(mode, input, options, cfg);
  } catch (error) {
    if (backend === "auto" && error.code === "ENOENT" && hasApiKey()) {
      return runEnsemble(input, options, cfg);
    }
    throw error;
  }
}

async function runClaudeReview(mode, input, options, cfg) {
  const cwd = input.cwd || options.cwd || process.cwd();
  const state = readLoopState(input);
  const resumeSessionId = state.claude_session_id || null;
  const gitContext = collectGitContext(cwd, { includeDiff: mode === "stop" });
  // Stop reviews carry a digest of everything Codex did since Fable last saw
  // the transcript; prompt reviews just advance the offset (the conversation
  // tail already covers what they need).
  let digest = "";
  let transcriptOffset;
  if (mode === "stop") {
    const collected = collectTurnDigest(input, state, cfg, options.runClaudeDigest);
    digest = collected.digest;
    transcriptOffset = collected.offset;
  } else {
    transcriptOffset = transcriptLength(input.transcript_path);
  }
  const buildPromptFor = (resumed) => (mode === "prompt"
    ? buildClaudePromptReview({ input, gitContext, resumed, maxContextChars: cfg.maxContextChars })
    : buildClaudeStopReview({ input, state, cfg, gitContext, digest }));
  const outcome = runClaudeStructured({
    bin: cfg.claudeBin,
    prompt: buildPromptFor(Boolean(resumeSessionId)),
    freshPrompt: buildPromptFor(false),
    schema: mode === "prompt" ? PROMPT_SCHEMA : STOP_SCHEMA,
    model: cfg.model,
    systemPrompt: CLAUDE_SYSTEM_PROMPT,
    resumeSessionId,
    effort: cfg.effort,
    cwd,
    timeoutMs: cfg.timeoutMs,
    runner: options.runClaude
  });
  updateLoopState(input, {
    claude_session_id: outcome.sessionId,
    cwd,
    model: cfg.model,
    transcript_offset: transcriptOffset
  });
  return mode === "prompt"
    ? toPromptReview(outcome, cfg)
    : toStopReview(outcome, cfg);
}

function toPromptReview(outcome, cfg) {
  const structured = outcome.structured;
  const amended = String(structured.amended_prompt || "").trim();
  if (!amended) throw new Error("Loop prompt review returned an empty amended_prompt.");
  return {
    status: "ready",
    mode: "prompt",
    amended_prompt: amended,
    review: String(structured.review || "").trim(),
    should_continue: false,
    confidence: normalizeConfidence(structured.confidence),
    model: cfg.model,
    backend: "claude",
    resumed: outcome.resumed,
    claude_session_id: outcome.sessionId,
    usage: outcome.result && outcome.result.total_cost_usd
  };
}

function toStopReview(outcome, cfg) {
  const structured = outcome.structured;
  const shouldContinue = Boolean(structured.should_continue);
  const nextPrompt = String(structured.next_prompt || "").trim();
  return {
    status: "ready",
    mode: "stop",
    amended_prompt: nextPrompt,
    review: String(structured.review || "").trim(),
    should_continue: shouldContinue && Boolean(nextPrompt),
    confidence: normalizeConfidence(structured.confidence),
    model: cfg.model,
    backend: "claude",
    resumed: outcome.resumed,
    claude_session_id: outcome.sessionId,
    usage: outcome.result && outcome.result.total_cost_usd
  };
}

function buildClaudePromptReview({ input, gitContext, resumed, maxContextChars }) {
  const conversation = input.conversation || readRecentConversation(input.transcript_path);
  const context = (conversation || []).map((message) => `${message.role}: ${message.text}`).join("\n\n");
  const parts = [
    resumed
      ? "A new prompt was submitted in the Codex goal-loop session you are overseeing. Review it before Codex acts."
      : "You are starting oversight of a Codex goal-loop session. Review this activating prompt before Codex acts.",
    "",
    "Submitted prompt:",
    input.prompt || "",
    "",
    context ? `Recent conversation:\n${truncate(context, maxContextChars)}` : "Recent conversation: none"
  ];
  if (gitContext) parts.push("", gitContext);
  return parts.join("\n");
}

function buildClaudeStopReview({ input, state, cfg, gitContext, digest }) {
  const continues = Number(state.continues) || 0;
  const parts = [
    "Codex wants to stop. Decide whether the goal is met.",
    "",
    "Goal (from the activating prompt):",
    state.goal || "(not recorded — infer it from this session's history)",
    "",
    `Loop continuations used so far: ${continues} of ${cfg.maxContinues} allowed.`,
    "",
    "Codex's final message:",
    input.last_assistant_message || "(none provided)"
  ];
  if (digest) parts.push("", digest);
  if (gitContext) parts.push("", gitContext);
  parts.push(
    "",
    "Verify the claim against the git state above and by reading the touched files with your read-only tools, rather than trusting the message.",
    "Set should_continue=true only for concrete unfinished work, failed verification, or a needed course correction, and put a direct instruction in next_prompt.",
    "If the goal is met or only optional polish remains, set should_continue=false."
  );
  return parts.join("\n");
}

function truncate(text, maxChars) {
  const raw = String(text || "");
  if (!maxChars || raw.length <= maxChars) return raw;
  return `${raw.slice(0, maxChars)}\n[conversation truncated]`;
}

function formatPromptAdditionalContext(review) {
  return [
    "# Loop prompt review (Fable)",
    "",
    "A senior peer reviewed this prompt before execution. Treat the brief below as guidance for how to run the goal loop; the user's own message remains authoritative if they conflict.",
    "This Loop prompt hook has already run for the current prompt. Do not invoke the Loop skill or CLI again solely because the prompt contains $loop.",
    "",
    "## Amended brief",
    review.amended_prompt,
    "",
    "## Reviewer notes",
    review.review || "No additional notes.",
    "",
    `Confidence: ${review.confidence || "medium"}`
  ].join("\n");
}

function formatStopReason(review) {
  return [
    "# Loop course correction (Fable)",
    "",
    review.review || "Fable found concrete unfinished work.",
    "",
    "Continue with this instruction:",
    review.amended_prompt
  ].join("\n");
}

module.exports = {
  CLAUDE_SYSTEM_PROMPT,
  PROMPT_SCHEMA,
  STOP_SCHEMA,
  buildClaudePromptReview,
  buildClaudeStopReview,
  buildPromptReviewPrompt,
  buildRetryPrompt,
  buildStopReviewPrompt,
  formatPromptAdditionalContext,
  formatStopReason,
  isReturnPromptRetryable,
  runLoopPromptReview,
  runLoopStopReview
};
