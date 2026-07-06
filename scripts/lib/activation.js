"use strict";

const { readSessionState, updateSessionState } = require("./session-state");

const LOOP_TOKEN = /(^|[^\w-])\$loop\b:?/i;
const STATE_NAMESPACE = "loop";
const ACTIVATION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function hasLoopInvocation(prompt) {
  return LOOP_TOKEN.test(String(prompt || ""));
}

function stripLoopInvocation(prompt) {
  return String(prompt || "").replace(LOOP_TOKEN, "$1").replace(/[ \t]{2,}/g, " ").trim();
}

function markLoopActivated(input, { goal = "" } = {}) {
  return updateSessionState(STATE_NAMESPACE, input, {
    session_id: input.session_id,
    transcript_path: input.transcript_path,
    cwd: input.cwd,
    activated_at: new Date().toISOString(),
    goal: String(goal || "").trim(),
    continues: 0
  });
}

function readLoopState(input) {
  return readSessionState(STATE_NAMESPACE, input);
}

function updateLoopState(input, patch) {
  return updateSessionState(STATE_NAMESPACE, input, patch);
}

function isLoopActivated(input) {
  const activatedAt = Date.parse(readLoopState(input).activated_at || "");
  return Number.isFinite(activatedAt) && Date.now() - activatedAt <= ACTIVATION_MAX_AGE_MS;
}

module.exports = {
  STATE_NAMESPACE,
  hasLoopInvocation,
  isLoopActivated,
  markLoopActivated,
  readLoopState,
  stripLoopInvocation,
  updateLoopState
};
