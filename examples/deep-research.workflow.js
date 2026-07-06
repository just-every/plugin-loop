// ultracode example: a deep-research harness — plan -> gather -> verify -> synthesize.
//
// This is the ultracode twin of Claude Code's /deep-research skill. The shape is
// the canonical research pipeline, and it works the same whether you are
// researching INFORMATION (the open web) or CODE (this repo):
//
//   1. PLAN        one agent decomposes the topic into focused sub-questions
//   2. GATHER      one agent per sub-question researches it, returning cited claims
//   3. VERIFY      adversarialVerify keeps only claims that survive a skeptic vote
//   4. SYNTHESIZE  one writer merges the surviving claims into a cited report
//
// The only thing the `mode` arg changes is the sourcing instruction woven into
// each prompt ("code" => grep/read this repo and cite file:line; "web" => search
// and cite URLs). GATHER and VERIFY stream per sub-question (a barrier-free
// pipeline): a lane's claims hit the skeptic vote the moment that lane resolves,
// while other lanes are still gathering. Only the final synthesis waits for all.
//
// Run it for free against the mock codex (no paid calls). The mock is seeded
// with one planner sub-question and an empty gather result, so the orchestration
// is exercised end to end without inventing research claims:
//   CODEX_HOME=$(mktemp -d) MOCK_CODEX_COUNTER=$(mktemp) \
//   CODEX_CLI_PATH=test/fixtures/mock-codex.js \
//   MOCK_CODEX_RESPONSE='{"summary":"mock plan","findings":["Inspect the budget gate implementation"],"recommended_actions":[],"risks":[],"verification":[],"confidence":"high"}' \
//   MOCK_CODEX_ALT_RESPONSE='{"summary":"mock gather","findings":[],"recommended_actions":[],"risks":[],"verification":[],"confidence":"high"}' \
//   node scripts/ultracode-cli.js examples/deep-research.workflow.js \
//     --args '{"topic":"How does the ultracode budget gate work?","mode":"code"}'
//
// Against the real codex: drop the mock env vars. For code research keep the
// default read-only sandbox; for web research the worker uses its own search tools.
//   node scripts/ultracode-cli.js examples/deep-research.workflow.js --progress \
//     --args '{"topic":"State of WebGPU support in browsers in 2026","mode":"web"}'
//
// WARNING: a script runs arbitrary Node.js in-process with full host privileges.
// It is NOT sandboxed. Only run scripts you trust.

const topic =
  (args && typeof args.topic === "string" && args.topic.trim()) ||
  "How does this codebase orchestrate parallel agents?";
const mode = args && args.mode === "web" ? "web" : "code"; // "code" => research THIS repo; "web" => research the open web
const maxLanes = Math.max(1, Math.min(8, (args && Number(args.lanes)) || 4));

// A mode-specific sourcing rule reused by every research worker so each claim is
// traceable to where it came from.
const sourcing =
  mode === "web"
    ? "Search the web and read primary sources. Cite each claim with a URL."
    : "Read the codebase (grep, open files). Cite each claim with a file:line reference.";

phase("plan");
log(`researching "${topic}" (${mode} mode, up to ${maxLanes} lanes)`, { topic, mode, lanes: maxLanes });

// 1. PLAN — one agent splits the topic into focused, non-overlapping sub-questions.
//    They go in `findings` (the default WORKER_SCHEMA string[]) so no custom schema
//    is needed. An empty plan is an instruction/schema problem, so fail loudly.
const planned = await agent(
  `Decompose this research topic into ${maxLanes} focused, non-overlapping sub-questions ` +
    `that together fully answer it. Topic: "${topic}". ` +
    `Return ONE sub-question per entry in \`findings\`.`
);
const subquestions = (planned && Array.isArray(planned.findings) ? planned.findings : [])
  .map((question) => (typeof question === "string" ? question.trim() : ""))
  .filter(Boolean)
  .slice(0, maxLanes);

if (!subquestions.length) {
  throw new Error("Planner returned no sub-questions; improve the planning prompt or output schema before retrying.");
}

log(`planned ${subquestions.length} sub-question(s)`, { count: subquestions.length });

// 2 + 3. GATHER -> VERIFY, streamed per sub-question with NO barrier between them.
phase("research");
const perLane = await pipeline(
  subquestions,
  // GATHER: research one sub-question; each finding is a claim WITH its citation.
  (question) =>
    agent(
      `Research this sub-question and report only what you can SUPPORT WITH EVIDENCE.\n` +
        `Sub-question: "${question}"\n${sourcing}\n` +
        `Return each supported claim as one entry in \`findings\`, formatted "claim — [source]".`
    ),
  // VERIFY: adversarial skeptic vote; keep only the survivors. Distinct lenses
  // catch distinct failure modes (a fabricated/missing source vs a wrong inference).
  (gathered, question) => {
    const claims = gathered && Array.isArray(gathered.findings) ? gathered.findings : [];
    if (!claims.length) return { question, claims: [] };
    return adversarialVerify(claims, {
      skeptics: 3,
      lenses: ["source-exists", "claim-follows-from-source"]
    }).then((survived) => ({ question, claims: survived }));
  }
);

// pipeline turns a throwing/failed stage into null; keep only lanes with survivors.
const verified = perLane.filter(Boolean).filter((lane) => lane.claims.length);
const allClaims = verified.flatMap((lane) => lane.claims);

log(`verified ${allClaims.length} claim(s) across ${verified.length} lane(s)`, {
  claims: allClaims.length,
  lanes: verified.length
});

// 4. SYNTHESIZE — one writer merges the SURVIVING claims into a cited report.
//    schema:null => free-text prose instead of the structured WORKER_SCHEMA value.
phase("synthesize");
const report = await agent(
  `Write a concise, well-structured research report answering: "${topic}".\n` +
    `Use ONLY these verified, cited claims — keep every citation, invent nothing:\n` +
    (allClaims.length
      ? allClaims.map((c, i) => `${i + 1}. ${c}`).join("\n")
      : "(no claims survived verification)"),
  { schema: null }
);

export default {
  topic,
  mode,
  subquestions,
  verified_claims: allClaims,
  dropped_lanes: subquestions.length - verified.length, // honest: lanes that found nothing or failed verification
  report
};
