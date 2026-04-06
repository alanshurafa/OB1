/**
 * consolidation-metadata — Re-classify thoughts with weak metadata.
 *
 * Finds thoughts stuck with catch-all type="reference", default importance=3,
 * or empty topics where confidence is low, then re-evaluates them via LLM.
 *
 * Query params:
 *   ?limit=20     — batch size (default 20, max 100)
 *   ?dry_run=true — evaluate but don't write changes
 *
 * Auth: MCP_ACCESS_KEY via x-brain-key header, Authorization bearer, or ?key= param.
 *
 * Requires:
 *   - Enhanced thoughts schema (schemas/enhanced-thoughts)
 *   - Knowledge graph schema (schemas/knowledge-graph) for consolidation_log
 *
 * LLM provider priority: OpenRouter > OpenAI > Anthropic (OB1 standard).
 *
 * See docs/05-tool-audit.md for the full tool and worker inventory.
 */

import { createClient } from "npm:@supabase/supabase-js@2";
import {
  isRecord,
  asString,
  asNumber,
  asInteger,
  normalizeStringArray,
} from "../_shared/helpers.ts";
import {
  ALLOWED_TYPES,
  CLASSIFIER_MODEL_OPENROUTER,
  CLASSIFIER_MODEL_OPENAI,
  CLASSIFIER_MODEL_ANTHROPIC,
} from "../_shared/config.ts";

// --- Environment ---

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY") ?? "";
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY") ?? "";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

// OB1: OpenRouter-first model selection for classification
const CONSOLIDATION_MODEL = Deno.env.get("OPENROUTER_CLASSIFIER_MODEL") ?? CLASSIFIER_MODEL_OPENROUTER;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// --- CORS (wildcard for OB1) ---

function getCorsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-brain-key, x-mcp-key",
    "Content-Type": "application/json",
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: getCorsHeaders() });
}

// --- Auth ---

function isAuthorized(req: Request): boolean {
  const url = new URL(req.url);
  const key =
    req.headers.get("x-brain-key")?.trim() ||
    req.headers.get("x-mcp-key")?.trim() ||
    url.searchParams.get("key")?.trim() ||
    (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  return key === MCP_ACCESS_KEY;
}

// --- LLM call ---

const RECLASSIFY_PROMPT = `Re-evaluate this thought's metadata. The current classification may be inaccurate.

Current: type={type}, importance={importance}, topics={topics}
Content: {content}

Allowed types: idea, task, person_note, reference, decision, lesson, meeting, journal
Importance scale: 0 (noise/not useful) to 6 (user-flagged critical)
Assign 0-5 automatically. Never assign 6 unless the user explicitly flagged the item as critical.

Respond as STRICT JSON (no markdown fences): {"type": "...", "importance": N, "topics": ["...", "..."], "confidence": 0.0-1.0, "reason": "..."}`;

type ReclassifyResult = {
  type: string;
  importance: number;
  topics: string[];
  confidence: number;
  reason: string;
};

async function reclassifyThought(
  content: string,
  currentType: string,
  currentImportance: number,
  currentTopics: string[],
): Promise<ReclassifyResult | null> {
  const prompt = RECLASSIFY_PROMPT
    .replace("{type}", currentType)
    .replace("{importance}", String(currentImportance))
    .replace("{topics}", JSON.stringify(currentTopics))
    .replace("{content}", content.slice(0, 4000));

  const rawText = await callLLMWithFallback(prompt);
  if (!rawText?.trim()) return null;

  const parsed = JSON.parse(stripCodeFences(rawText));
  if (!isRecord(parsed)) return null;

  const newType = asString(parsed.type, "reference");
  const validType = ALLOWED_TYPES.has(newType) ? newType : "reference";

  return {
    type: validType,
    importance: asInteger(parsed.importance, 3, 0, 6),
    topics: normalizeStringArray(parsed.topics),
    confidence: asNumber(parsed.confidence, 0.5, 0, 1),
    reason: asString(parsed.reason, ""),
  };
}

// --- Three-tier fallback: OpenRouter > OpenAI > Anthropic (OB1 order) ---

async function callLLMWithFallback(prompt: string): Promise<string> {
  const providers: Array<{ name: string; fn: () => Promise<string> }> = [];

  if (OPENROUTER_API_KEY) {
    providers.push({ name: "openrouter", fn: () => fetchOpenRouterLLM(prompt) });
  }
  if (OPENAI_API_KEY) {
    providers.push({ name: "openai", fn: () => fetchOpenAILLM(prompt) });
  }
  if (ANTHROPIC_API_KEY) {
    providers.push({ name: "anthropic", fn: () => fetchAnthropicLLM(prompt) });
  }

  if (providers.length === 0) {
    throw new Error("No LLM API keys configured (need OPENROUTER_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY)");
  }

  for (const { name, fn } of providers) {
    try {
      return await fn();
    } catch (err) {
      console.warn(`Consolidation LLM call failed (${name}):`, err);
    }
  }
  throw new Error(`All ${providers.length} LLM providers failed`);
}

async function fetchOpenRouterLLM(prompt: string): Promise<string> {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: CONSOLIDATION_MODEL,
      temperature: 0.1,
      messages: [{ role: "user", content: prompt + "\nReturn only the JSON object." }],
    }),
  });
  if (!response.ok) throw new Error(`OpenRouter API failed (${response.status}): ${await response.text()}`);
  const payload = await response.json();
  return payload.choices?.[0]?.message?.content ?? "";
}

async function fetchOpenAILLM(prompt: string): Promise<string> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: CLASSIFIER_MODEL_OPENAI,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt + "\nReturn only the JSON object." }],
    }),
  });
  if (!response.ok) throw new Error(`OpenAI API failed (${response.status}): ${await response.text()}`);
  const payload = await response.json();
  return payload.choices?.[0]?.message?.content ?? "";
}

async function fetchAnthropicLLM(prompt: string): Promise<string> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: CLASSIFIER_MODEL_ANTHROPIC,
      max_tokens: 512,
      temperature: 0.1,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!response.ok) throw new Error(`Anthropic API failed (${response.status}): ${await response.text()}`);
  return readAnthropicText(await response.json());
}

function readAnthropicText(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.content) || payload.content.length === 0) {
    return "";
  }
  return payload.content
    .map((block: unknown) => {
      if (!isRecord(block) || asString(block.type, "") !== "text") return "";
      return asString(block.text, "");
    })
    .join("");
}

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  return match ? match[1].trim() : trimmed;
}

// --- Materiality check ---

function isMaterialChange(
  old: { type: string; importance: number; topics: string[] },
  result: ReclassifyResult,
): boolean {
  if (result.type !== old.type) return true;
  if (Math.abs(result.importance - old.importance) >= 2) return true;
  if (old.topics.length === 0 && result.topics.length > 0) return true;
  return false;
}

// --- Main handler ---

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: getCorsHeaders() });
  }

  if (!MCP_ACCESS_KEY) {
    console.warn("MCP_ACCESS_KEY not set — rejecting all requests.");
    return json({ error: "Service misconfigured: auth key not set" }, 503);
  }
  if (!isAuthorized(req)) {
    return json({ error: "Unauthorized" }, 401);
  }

  if (!OPENROUTER_API_KEY && !OPENAI_API_KEY && !ANTHROPIC_API_KEY) {
    return json({ error: "No LLM API keys configured" }, 503);
  }

  const url = new URL(req.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "20", 10) || 20, 1), 100);
  const dryRun = url.searchParams.get("dry_run") === "true";

  // Step 1: Find candidate thoughts with weak metadata
  const { data: candidates, error: queryError } = await supabase
    .from("thoughts")
    .select("id, content, type, importance, metadata")
    .or(
      "and(type.eq.reference,metadata->>confidence.lt.0.7)," +
      "and(importance.eq.3,metadata->>confidence.lt.0.7)"
    )
    .is("metadata->>generated_by", null)
    .is("metadata->>consolidation_reviewed", null)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (queryError) {
    console.error("Failed to query candidates:", queryError);
    return json({ error: "Failed to query candidates", details: queryError.message }, 500);
  }

  if (!candidates || candidates.length === 0) {
    return json({ candidates_found: 0, reviewed: 0, changed: 0, skipped: 0, errors: 0, dry_run: dryRun });
  }

  const summary = {
    candidates_found: candidates.length,
    reviewed: 0,
    changed: 0,
    skipped: 0,
    errors: 0,
    dry_run: dryRun,
    changes: [] as Record<string, unknown>[],
  };

  // Step 2: Process each candidate
  for (const thought of candidates) {
    summary.reviewed++;

    const currentType = asString(thought.type, "reference");
    const currentImportance = thought.importance ?? 3;
    const currentMetadata = isRecord(thought.metadata) ? thought.metadata : {};
    const currentTopics = normalizeStringArray(currentMetadata.topics);

    let result: ReclassifyResult | null = null;
    try {
      result = await reclassifyThought(
        thought.content ?? "",
        currentType,
        currentImportance,
        currentTopics,
      );
    } catch (err) {
      console.error(`Error reclassifying thought ${thought.id}:`, err);
      summary.errors++;
      continue;
    }

    if (!result) {
      summary.skipped++;
      continue;
    }

    // Only apply if confidence > 0.8 and change is material
    if (result.confidence <= 0.8) {
      summary.skipped++;
      continue;
    }

    if (!isMaterialChange({ type: currentType, importance: currentImportance, topics: currentTopics }, result)) {
      if (!dryRun) {
        const updatedMeta = { ...currentMetadata, consolidation_reviewed: true };
        await supabase
          .from("thoughts")
          .update({ metadata: updatedMeta })
          .eq("id", thought.id);
      }
      summary.skipped++;
      continue;
    }

    const changeRecord = {
      thought_id: thought.id,
      old: { type: currentType, importance: currentImportance, topics: currentTopics },
      new: { type: result.type, importance: result.importance, topics: result.topics },
      confidence: result.confidence,
      reason: result.reason,
    };
    summary.changes.push(changeRecord);

    if (dryRun) {
      summary.changed++;
      continue;
    }

    // Step 3: Write changes
    const mergedTopics = normalizeStringArray([...currentTopics, ...result.topics]);
    const updatedMetadata = {
      ...currentMetadata,
      topics: mergedTopics,
      consolidation_reviewed: true,
      consolidation_model: CONSOLIDATION_MODEL,
      consolidation_reason: result.reason,
      consolidation_confidence: result.confidence,
    };

    const { error: updateError } = await supabase
      .from("thoughts")
      .update({
        type: result.type,
        importance: result.importance,
        metadata: updatedMetadata,
      })
      .eq("id", thought.id);

    if (updateError) {
      console.error(`Failed to update thought ${thought.id}:`, updateError);
      summary.errors++;
      continue;
    }

    // Step 4: Log to consolidation_log
    const { error: logError } = await supabase
      .from("consolidation_log")
      .insert({
        operation: "metadata_quality",
        survivor_id: thought.id,
        details: {
          old_type: currentType,
          new_type: result.type,
          old_importance: currentImportance,
          new_importance: result.importance,
          old_topics: currentTopics,
          new_topics: mergedTopics,
          confidence: result.confidence,
          reason: result.reason,
          model: CONSOLIDATION_MODEL,
        },
      });

    if (logError) {
      console.error(`Failed to log consolidation for thought ${thought.id}:`, logError);
    }

    summary.changed++;
  }

  return json(summary);
});
