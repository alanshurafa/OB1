#!/usr/bin/env node
/**
 * seed-profile.mjs — Living Profile one-time seed.
 *
 * Populates the profile_fact stream (source_type='profile_fact') from
 * whatever high-signal source you already have. Does NOT create or write a
 * wiki page / canonical thought — that is synthesize-profile.mjs's job, run
 * after seeding.
 *
 * Modes (exactly one required):
 *   --from-canonical      Fetch an existing single-blob profile/bio thought
 *                         (id via --thought-id or CANONICAL_PROFILE_THOUGHT_ID
 *                         in .env.local), LLM-split it into per-fact
 *                         statements, evidence_thought_ids = [that id].
 *   --from-omi-memories   ONE batch fetch of source_type='omi_memory' rows
 *                         (only meaningful if you've run a wearable-capture
 *                         recipe that produces this stream), map each to a
 *                         candidate fact preserving its metadata, one LLM
 *                         batch call assigns profile_category,
 *                         evidence_thought_ids = [the source thought's id].
 *
 * Safety:
 *   --dry-run is the DEFAULT (prints a table of what would be written).
 *   --live is REQUIRED to actually insert.
 *
 * Usage:
 *   node scripts/seed-profile.mjs --from-canonical --thought-id=12345    # dry-run
 *   node scripts/seed-profile.mjs --from-canonical --thought-id=12345 --live
 *   node scripts/seed-profile.mjs --from-omi-memories --live
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CATEGORY_KEYS, factRow } from "./lib.mjs";

const CWD = process.cwd();

// ── env + args ──────────────────────────────────────────────────────────────

/**
 * Line-based .env.local parser — read-only. Never logged, never written back.
 * process.env wins over .env.local values (documented in .env.example).
 */
function loadEnv() {
  const envPath = path.join(CWD, ".env.local");
  const env = {};
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return { ...env, ...process.env };
}

function parseArgs(argv) {
  const args = {
    fromCanonical: false,
    fromOmiMemories: false,
    live: false,
    limit: 0,
    thoughtId: null,
  };
  for (const a of argv.slice(2)) {
    if (a === "--from-canonical") args.fromCanonical = true;
    else if (a === "--from-omi-memories") args.fromOmiMemories = true;
    else if (a === "--live") args.live = true;
    else if (a === "--dry-run") args.live = false; // explicit no-op: dry-run is already default
    else if (a.startsWith("--limit=")) args.limit = parseInt(a.slice("--limit=".length), 10) || 0;
    else if (a.startsWith("--thought-id=")) args.thoughtId = parseInt(a.slice("--thought-id=".length), 10) || null;
    else throw new Error(`seed-profile: unrecognized argument "${a}"`);
  }
  return args;
}

/** Fail-early input validation (validate at boundaries; fail with a clear message). */
function validateArgs(args) {
  if (args.fromCanonical === args.fromOmiMemories) {
    throw new Error(
      "seed-profile: exactly one of --from-canonical or --from-omi-memories is required "
      + `(got from-canonical=${args.fromCanonical} from-omi-memories=${args.fromOmiMemories})`,
    );
  }
}

function validateEnv(env, args) {
  const missing = [];
  if (!env.OPEN_BRAIN_URL) missing.push("OPEN_BRAIN_URL");
  if (!env.OPEN_BRAIN_SERVICE_KEY) missing.push("OPEN_BRAIN_SERVICE_KEY");
  if (!env.LLM_API_KEY) missing.push("LLM_API_KEY");
  if (missing.length) {
    throw new Error(`seed-profile: missing required env var(s) in .env.local: ${missing.join(", ")}`);
  }
  if (args.fromCanonical) {
    const thoughtId = args.thoughtId ?? (env.CANONICAL_PROFILE_THOUGHT_ID ? Number(env.CANONICAL_PROFILE_THOUGHT_ID) : null);
    if (!Number.isInteger(thoughtId) || thoughtId <= 0) {
      throw new Error(
        "seed-profile: --from-canonical requires a source thought id — pass --thought-id=NNNN "
        + "or set CANONICAL_PROFILE_THOUGHT_ID in .env.local",
      );
    }
  }
}

// ── PostgREST client ─────────────────────────────────────────────────────

function sbClient(env) {
  const base = `${String(env.OPEN_BRAIN_URL).replace(/\/+$/, "")}/rest/v1`;
  const headers = {
    apikey: env.OPEN_BRAIN_SERVICE_KEY,
    Authorization: `Bearer ${env.OPEN_BRAIN_SERVICE_KEY}`,
    "Content-Type": "application/json",
  };
  async function sb(method, relPath, body, extraHeaders = {}) {
    const res = await fetch(`${base}/${relPath}`, {
      method,
      headers: { ...headers, ...extraHeaders },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 429) {
      const err = new Error(`${method} ${relPath}: 429 rate limited`);
      err.status = 429;
      throw err;
    }
    if (!res.ok) {
      const text = await res.text();
      const err = new Error(`${method} ${relPath}: ${res.status} ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    const ct = res.headers.get("content-type") || "";
    return ct.includes("json") ? res.json() : null;
  }
  return {
    get: (p) => sb("GET", p),
    post: (p, body, extra) => sb("POST", p, body, extra),
  };
}

// ── LLM call (any OpenAI-compatible Chat Completions endpoint) ─────────────

/**
 * Run a single-turn LLM call against LLM_BASE_URL and return raw text.
 * Defaults to OpenRouter; works against OpenAI direct, a local Ollama/LM
 * Studio server, or Anthropic via OpenRouter — anything speaking the
 * Chat Completions shape.
 */
async function callLlm({ systemPrompt, userPrompt, env }) {
  const baseUrl = (env.LLM_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
  const model = env.LLM_MODEL || "anthropic/claude-haiku-4-5";
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.LLM_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      temperature: 0.2,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });
  if (res.status === 429) {
    const err = new Error("LLM API 429: rate limited");
    err.status = 429;
    throw err;
  }
  if (!res.ok) throw new Error(`LLM API ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text || !text.trim()) throw new Error("LLM response had no text");
  return text.trim();
}

/**
 * Extract a JSON array from LLM output. Models sometimes wrap JSON in prose
 * or a ```json fence despite instructions — strip those defensively before
 * parsing, then fail loudly (no silent fallback) if it still isn't valid JSON.
 */
export function extractJsonArray(text) {
  const trimmed = String(text ?? "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  // If prose wraps the array, take the outermost [...] span.
  const start = candidate.indexOf("[");
  const end = candidate.lastIndexOf("]");
  const jsonSlice = start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate;
  let parsed;
  try {
    parsed = JSON.parse(jsonSlice);
  } catch (err) {
    throw new Error(`extractJsonArray: LLM output was not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(parsed)) throw new Error("extractJsonArray: parsed JSON was not an array");
  return parsed;
}

// ── fact candidate validation (shared by both modes) ────────────────────────

/**
 * Validate + normalize one raw LLM-proposed fact into the shape
 * factMetadata() expects. Throws on invalid category/missing statement so
 * callers can reject-and-count rather than silently coercing bad output.
 */
export function normalizeFactCandidate(raw, { evidenceThoughtIds, originStream, defaultConfidence = 0.7 }) {
  if (!raw || typeof raw !== "object") throw new Error("normalizeFactCandidate: candidate is not an object");
  const statement = String(raw.statement ?? "").trim();
  if (!statement) throw new Error("normalizeFactCandidate: missing/empty statement");
  const category = String(raw.category ?? raw.profile_category ?? "").trim();
  if (!CATEGORY_KEYS.includes(category)) {
    throw new Error(`normalizeFactCandidate: unknown category "${category}" (expected one of ${CATEGORY_KEYS.join(", ")})`);
  }
  const slot = raw.slot ? String(raw.slot).trim() : null;
  const confidence = Number.isFinite(raw.confidence) ? raw.confidence : defaultConfidence;
  return {
    statement,
    category,
    slot: slot || null,
    confidence,
    evidenceThoughtIds,
    originStream,
  };
}

// ── mode A: split the canonical profile thought ─────────────────────────────

function buildCanonicalSplitPrompt(subjectName) {
  return `You are extracting discrete, durable facts about a person named ${subjectName} from a
single biographical profile document.

Rules:
- Each fact must be ONE standalone sentence that makes sense without the
  surrounding document (e.g. "${subjectName} lives in Seattle." not "He also lives there.").
- Only durable facts: identity, family, relationships, work, health routines,
  preferences, values, skills, places. Skip transient states, one-off events,
  or vague summary sentences that don't assert a specific fact.
- Assign each fact exactly one category from this fixed list:
  ${CATEGORY_KEYS.join(", ")}
- Optionally assign a "slot" — a short stable key for single-valued facts
  that later updates should replace (e.g. "residence", "employer", "diet").
  Omit slot (or use null) for facts that don't have a natural single-value key.
- Assign a confidence from 0 to 1 reflecting how directly the source text
  states the fact (1.0 = stated verbatim, lower = inferred/paraphrased).

Return ONLY a JSON array, no prose, no markdown fence, in this exact shape:
[{"statement": "...", "category": "...", "slot": null, "confidence": 0.9}, ...]`;
}

async function fetchCanonicalThought(sb, thoughtId) {
  const rows = await sb.get(`thoughts?id=eq.${thoughtId}&select=id,content,sensitivity_tier`);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) {
    throw new Error(
      `seed-profile: source thought id=${thoughtId} not found `
      + "(pass --thought-id=NNNN or set CANONICAL_PROFILE_THOUGHT_ID to an existing thought)",
    );
  }
  return row;
}

async function buildCandidatesFromCanonical({ sb, env, thoughtId }) {
  const thought = await fetchCanonicalThought(sb, thoughtId);
  const raw = await callLlm({
    systemPrompt: buildCanonicalSplitPrompt(env.SUBJECT_NAME || "the user"),
    userPrompt: `SOURCE DOCUMENT:\n\n${thought.content}`,
    env,
  });
  const rawFacts = extractJsonArray(raw);

  const accepted = [];
  const rejected = [];
  for (const rf of rawFacts) {
    try {
      accepted.push(normalizeFactCandidate(rf, {
        evidenceThoughtIds: [thought.id],
        originStream: "seed-canonical-profile",
      }));
    } catch (err) {
      rejected.push({ raw: rf, error: err.message });
    }
  }
  return { accepted, rejected, sourceThought: thought };
}

// ── mode B: map omi_memory rows ──────────────────────────────────────────────

function buildOmiCategoryPrompt() {
  return `You are categorizing a batch of short personal-memory facts into a fixed
taxonomy. Each input has an "id" (batch-local, echo it back unchanged) and a
"content" string.

Assign each memory exactly one category from this fixed list:
${CATEGORY_KEYS.join(", ")}

Return ONLY a JSON array, no prose, no markdown fence, in this exact shape:
[{"id": 0, "category": "..."}, ...]`;
}

/**
 * ONE batch fetch of all omi_memory thoughts — never per-row metadata
 * filters. A per-row filter on an un-indexed JSON path degrades to a full
 * scan per row and can hang a batch job at scale; fetch once, filter/map in
 * memory instead.
 */
async function fetchOmiMemoryThoughts(sb, { limit = 0 } = {}) {
  const rows = await sb.get(
    "thoughts?source_type=eq.omi_memory&select=id,content,sensitivity_tier,metadata&order=id.asc&limit=5000",
  );
  const all = Array.isArray(rows) ? rows : [];
  return limit > 0 ? all.slice(0, limit) : all;
}

/**
 * Assign categories to a batch of memory rows via one LLM call. Falls back
 * to leaving unmapped ids out of the returned Map — callers reject those as
 * invalid candidates rather than guessing a category.
 */
export async function assignOmiCategories(rows, { env, llmFn = callLlm } = {}) {
  if (rows.length === 0) return new Map();
  const batchInput = rows.map((r, i) => ({ id: i, content: r.content.slice(0, 500) }));
  const raw = await llmFn({
    systemPrompt: buildOmiCategoryPrompt(),
    userPrompt: JSON.stringify(batchInput, null, 2),
    env,
  });
  const parsed = extractJsonArray(raw);
  const byId = new Map();
  for (const entry of parsed) {
    if (entry && Number.isInteger(entry.id) && typeof entry.category === "string") {
      byId.set(entry.id, entry.category);
    }
  }
  return byId;
}

/**
 * Map one omi_memory thought row -> a fact candidate (pre-category-assignment
 * shape). Exported so tests can exercise the mapping without an LLM call.
 * manually_added memories carry confidence 0.9; machine-only memories
 * default lower via normalizeFactCandidate's defaultConfidence.
 */
export function mapOmiMemoryToCandidate(row) {
  const manuallyAdded = row.metadata?.manually_added === true;
  return {
    statement: String(row.content ?? "").trim(),
    sourceThoughtId: row.id,
    sensitivityTier: row.sensitivity_tier || "standard",
    omiMemoryId: row.metadata?.omi_memory_id ?? null,
    manuallyAdded,
    confidence: manuallyAdded ? 0.9 : 0.7,
  };
}

async function buildCandidatesFromOmiMemories({ sb, env, limit }) {
  const rows = await fetchOmiMemoryThoughts(sb, { limit });
  const mapped = rows
    .map((r) => ({ row: r, candidate: mapOmiMemoryToCandidate(r) }))
    .filter((m) => m.candidate.statement.length > 0);

  const categoryById = await assignOmiCategories(mapped.map((m) => m.row), { env });

  const accepted = [];
  const rejected = [];
  mapped.forEach(({ row, candidate }, i) => {
    const category = categoryById.get(i);
    try {
      accepted.push(normalizeFactCandidate(
        { statement: candidate.statement, category, confidence: candidate.confidence },
        {
          evidenceThoughtIds: [row.id],
          originStream: "omi_memory",
          defaultConfidence: candidate.confidence,
        },
      ));
      // Stash the pieces the write step needs that normalizeFactCandidate
      // doesn't carry (sensitivity tier + source-specific metadata extras).
      accepted[accepted.length - 1].sensitivityTier = candidate.sensitivityTier;
      accepted[accepted.length - 1].extraMetadata = {
        omi_memory_id: candidate.omiMemoryId,
        manually_added: candidate.manuallyAdded,
      };
    } catch (err) {
      rejected.push({ raw: { id: row.id, content: candidate.statement, category }, error: err.message });
    }
  });
  return { accepted, rejected, sourceCount: rows.length };
}

// ── write step ────────────────────────────────────────────────────────────

/**
 * Insert one fact candidate as a `thoughts` row. Direct INSERT (relying on
 * the fact's own salted content_fingerprint for dedup, not an upsert RPC) —
 * dedup happens on the profile_fact fingerprint (content-only, via
 * factFingerprint), which is a distinct identity space from whatever
 * dedup convention your `upsert_thought` RPC (if you have one) uses for raw
 * captured content.
 *
 * Row assembly lives in lib.mjs's factRow() — shared with
 * synthesize-profile.mjs so importance/quality_score/tier rules cannot drift
 * between the seed and the loop.
 */
async function writeFact(sb, candidate) {
  const row = factRow({
    statement: candidate.statement,
    category: candidate.category,
    slot: candidate.slot,
    confidence: candidate.confidence,
    evidenceThoughtIds: candidate.evidenceThoughtIds,
    originStream: candidate.originStream,
    sensitivityTier: candidate.sensitivityTier ?? null,
    extra: candidate.extraMetadata || {},
  });
  try {
    await sb.post("thoughts?select=id", row, { Prefer: "return=representation" });
    return "inserted";
  } catch (err) {
    if (err.status === 409 || /duplicate key|23505/.test(err.message)) return "skipped_duplicate";
    throw err;
  }
}

// ── reporting ─────────────────────────────────────────────────────────────

function printCandidateTable(accepted, rejected, { mode }) {
  console.log(`\n== ${mode}: ${accepted.length} candidate fact(s), ${rejected.length} rejected ==\n`);
  for (const c of accepted.slice(0, 50)) {
    const slot = c.slot ? ` [slot=${c.slot}]` : "";
    console.log(`  (${c.category}, conf=${c.confidence.toFixed(2)})${slot} ${c.statement}`);
  }
  if (accepted.length > 50) console.log(`  ... and ${accepted.length - 50} more`);
  if (rejected.length) {
    console.log(`\n  rejected:`);
    for (const r of rejected.slice(0, 10)) {
      console.log(`    - ${r.error} :: ${JSON.stringify(r.raw).slice(0, 120)}`);
    }
    if (rejected.length > 10) console.log(`    ... and ${rejected.length - 10} more`);
  }
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  validateArgs(args);

  const env = loadEnv();
  validateEnv(env, args);
  const sb = sbClient(env);

  const mode = args.fromCanonical ? "from-canonical" : "from-omi-memories";
  console.log(`\n[seed-profile] mode=${mode} model=${env.LLM_MODEL || "anthropic/claude-haiku-4-5"} live=${args.live}\n`);

  let result;
  try {
    result = args.fromCanonical
      ? await buildCandidatesFromCanonical({
          sb,
          env,
          thoughtId: args.thoughtId ?? Number(env.CANONICAL_PROFILE_THOUGHT_ID),
        })
      : await buildCandidatesFromOmiMemories({ sb, env, limit: args.limit });
  } catch (err) {
    if (err.status === 429) {
      console.warn(`[seed-profile] rate-limited (429); exiting 0 to allow a later retry. ${err.message}`);
      process.exit(0);
    }
    throw err;
  }

  printCandidateTable(result.accepted, result.rejected, { mode });

  if (!args.live) {
    console.log(`\n[seed-profile] DRY RUN — nothing written. Re-run with --live to insert.`);
    return;
  }

  let inserted = 0;
  let skipped = 0;
  let failed = 0;
  for (const candidate of result.accepted) {
    try {
      const outcome = await writeFact(sb, candidate);
      if (outcome === "inserted") inserted++;
      else skipped++;
    } catch (err) {
      if (err.status === 429) {
        console.warn(`[seed-profile] rate-limited mid-write (429); stopping early and exiting 0. ${err.message}`);
        console.log(`\n== SUMMARY (partial) == inserted=${inserted} skipped=${skipped} failed=${failed} rejected=${result.rejected.length}`);
        process.exit(0);
      }
      failed++;
      console.warn(`[seed-profile] write failed for "${candidate.statement.slice(0, 60)}...": ${err.message}`);
    }
  }

  console.log(`\n== SUMMARY == inserted=${inserted} skipped_duplicate=${skipped} failed=${failed} rejected_by_llm_validation=${result.rejected.length}`);
  if (failed > 0) process.exit(1);
}

// Only run main() when executed directly (not when imported by tests). Using
// pathToFileURL for the comparison (rather than hand-built file:// strings)
// keeps this correct on Windows, where drive letters and separators would
// otherwise need manual normalization.
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error("[seed-profile] FAILED:", err.message);
    process.exit(1);
  });
}
