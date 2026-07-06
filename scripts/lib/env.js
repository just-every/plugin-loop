"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function loadEnv({ cwd = process.cwd(), pluginRoot = path.resolve(__dirname, "..", "..") } = {}) {
  for (const file of [path.join(cwd, ".env"), path.join(pluginRoot, ".env"), path.join(os.homedir(), ".env")]) {
    loadEnvFile(file);
  }
}

// Only keys this plugin actually uses may be imported from .env files. A
// cloned repository's .env must never be able to set NODE_OPTIONS,
// GIT_EXTERNAL_DIFF, ANTHROPIC_BASE_URL, or anything else that changes how
// spawned processes behave.
function allowedEnvKey(key) {
  return key === "ANTHROPIC_API_KEY" || key.startsWith("LOOP_");
}

function loadEnvFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (parsed && allowedEnvKey(parsed.key) && process.env[parsed.key] === undefined) {
      process.env[parsed.key] = parsed.value;
    }
  }
}

function parseEnvLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const source = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
  const eq = source.indexOf("=");
  if (eq <= 0) return null;
  const key = source.slice(0, eq).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
  return { key, value: unquote(source.slice(eq + 1).trim()) };
}

function unquote(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  const comment = value.match(/^(.*?)(?:\s+#.*)$/);
  return comment ? comment[1].trimEnd() : value;
}

function disabled() {
  return ["1", "true", "yes", "on"].includes(String(process.env.LOOP_DISABLED || "").trim().toLowerCase());
}

function config() {
  return {
    backend: normalizeBackend(process.env.LOOP_BACKEND),
    claudeBin: process.env.LOOP_CLAUDE_BIN || "claude",
    model: process.env.LOOP_MODEL || "claude-fable-5",
    effort: process.env.LOOP_EFFORT || "",
    timeoutMs: positiveInt(process.env.LOOP_TIMEOUT_MS, 1200000),
    maxContextChars: positiveInt(process.env.LOOP_MAX_CONTEXT_CHARS, 16000),
    maxContinues: positiveInt(process.env.LOOP_MAX_CONTINUES, 8),
    digestModel: normalizeDigestModel(process.env.LOOP_DIGEST_MODEL),
    digestTimeoutMs: positiveInt(process.env.LOOP_DIGEST_TIMEOUT_MS, 60000),
    digestMaxChars: positiveInt(process.env.LOOP_DIGEST_MAX_CHARS, 150000)
  };
}

function normalizeDigestModel(value) {
  const model = String(value === undefined ? "" : value).trim();
  if (!model) return "haiku";
  return ["off", "none", "0", "false", "disabled"].includes(model.toLowerCase()) ? "" : model;
}

function normalizeBackend(value) {
  const backend = String(value || "").trim().toLowerCase();
  return ["claude", "ensemble"].includes(backend) ? backend : "auto";
}

function hasApiKey() {
  return Boolean(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim());
}

function requireKey() {
  if (!hasApiKey()) {
    throw new Error("ANTHROPIC_API_KEY is required for the Loop ensemble backend.");
  }
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

module.exports = {
  config,
  disabled,
  hasApiKey,
  loadEnv,
  parseEnvLine,
  requireKey
};
