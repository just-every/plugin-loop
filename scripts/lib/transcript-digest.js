"use strict";

const fs = require("node:fs");
const { runClaudePlain } = require("./claude-backend");
const { extractText } = require("./context");

// Deltas at or below this size are included verbatim — summarizing them would
// cost more than it saves.
const RAW_INCLUDE_LIMIT = 4000;

function transcriptLength(transcriptPath) {
  try {
    return fs.statSync(String(transcriptPath || "")).size;
  } catch {
    return 0;
  }
}

// Byte offsets: the stored offset marks how much of the transcript Fable has
// already been shown; only the remainder is digested.
function readTranscriptDelta(transcriptPath, offset) {
  let buffer;
  try {
    buffer = fs.readFileSync(String(transcriptPath || ""));
  } catch {
    return { text: "", offset: 0 };
  }
  const start = Number.isInteger(offset) && offset >= 0 && offset <= buffer.length ? offset : 0;
  return { text: extractEvents(buffer.subarray(start).toString("utf8")), offset: buffer.length };
}

function extractEvents(raw) {
  const parts = [];
  for (const line of String(raw || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = event && event.payload;
    if (!payload || payload.type !== "message") continue;
    if (payload.role !== "user" && payload.role !== "assistant") continue;
    const text = extractText(payload.content).trim();
    if (text) parts.push(`${payload.role}: ${text}`);
  }
  return parts.join("\n\n");
}

function collectTurnDigest(input, state, cfg, runner) {
  const { text, offset } = readTranscriptDelta(input.transcript_path, state.transcript_offset);
  if (!text) return { digest: "", offset };
  if (!cfg.digestModel || text.length <= RAW_INCLUDE_LIMIT) {
    return { digest: section("raw excerpt", tail(text)), offset };
  }
  try {
    const summary = runClaudePlain({
      bin: cfg.claudeBin,
      model: cfg.digestModel,
      prompt: buildDigestPrompt(text.slice(-cfg.digestMaxChars)),
      cwd: input.cwd,
      timeoutMs: cfg.digestTimeoutMs,
      runner
    });
    if (summary) return { digest: section(`digest by ${cfg.digestModel}`, summary), offset };
  } catch (error) {
    process.stderr.write(`Loop turn digest failed (${error.message}); falling back to a raw excerpt.\n`);
  }
  return { digest: section("raw excerpt; digest unavailable", tail(text)), offset };
}

function tail(text) {
  const raw = String(text || "");
  return raw.length <= RAW_INCLUDE_LIMIT ? raw : `[earlier activity omitted]\n${raw.slice(-RAW_INCLUDE_LIMIT)}`;
}

function section(label, body) {
  return `## Codex session activity since your last review (${label})\n\n${body}`;
}

function buildDigestPrompt(text) {
  return [
    "Summarize this Codex coding-agent session activity for a senior reviewer deciding whether the stated goal is met.",
    "Cover: what was attempted, files changed, commands and tests run with their results (include pass/fail counts), errors hit, anything left unfinished, and claims that need verification.",
    "Be factual and dense. Do not evaluate or recommend; just report. Maximum 400 words.",
    "",
    "Session activity:",
    text
  ].join("\n");
}

module.exports = {
  RAW_INCLUDE_LIMIT,
  buildDigestPrompt,
  collectTurnDigest,
  readTranscriptDelta,
  transcriptLength
};
