/**
 * consolidation-bio — Generate a canonical biographical profile from existing thoughts.
 *
 * Synthesizes a "Who is [person]" anchor document from person_notes, decisions,
 * and journal entries, stored as a thought with metadata.generated_by = "consolidation-bio".
 *
 * Query params:
 *   ?dry_run=true  — generate the profile but don't save it
 *   ?name=<name>   — target person name (default: search across all person_notes)
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
  asInteger,
} from "../_shared/helpers.ts";
import {
  CLASSIFIER_MODEL_OPENROUTER,
  CLASSIFIER_MODEL_ANTHROPIC,
} from "../_shared/config.ts";

// --- Environment ---

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY") ?? "";
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY") ?? "";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

// OB1: OpenRouter-first model selection
const BIO_MODEL = Deno.env.get("OPENROUTER_CLASSIFIER_MODEL") ?? CLASSIFIER_MODEL_OPENROUTER;
const BIO_MODEL_ANTHROPIC = CLASSIFIER_MODEL_ANTHROPIC;

const MAX_SOURCE_THOUGHTS = 50;
const MAX_CONTENT_PER_THOUGHT = 2000;
const MAX_TOTAL_CONTENT = 80_000;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// --- CORS (wildcard for OB1 — users deploy to their own projects) ---

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

// --- Helpers ---

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

function readChatCompletionText(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.choices) || payload.choices.length === 0) {
    return "";
  }
  const firstChoice = payload.choices[0];
  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) return "";
  return asString(firstChoice.message.content, "");
}

// --- Gather source material ---

type SourceThought = {
  id: number;
  content: string;
  type: string;
  importance: number;
  created_at: string;
};

async function gatherSourceThoughts(targetName?: string): Promise<SourceThought[]> {
  const allThoughts: SourceThought[] = [];

  // 1. Person notes (optionally filtered by name)
  const personQuery = supabase
    .from("thoughts")
    .select("id, content, type, importance, created_at")
    .eq("type", "person_note")
    .is("metadata->>generated_by", null)
    .neq("sensitivity_tier", "restricted")
    .order("created_at", { ascending: false })
    .limit(20);

  if (targetName) {
    personQuery.ilike("content", `%${targetName}%`);
  }

  const { data: personNotes } = await personQuery;
  if (personNotes) allThoughts.push(...personNotes);

  // 2. High-importance decisions
  const { data: decisions } = await supabase
    .from("thoughts")
    .select("id, content, type, importance, created_at")
    .eq("type", "decision")
    .gte("importance", 4)
    .is("metadata->>generated_by", null)
    .neq("sensitivity_tier", "restricted")
    .order("created_at", { ascending: false })
    .limit(20);

  if (decisions) allThoughts.push(...decisions);

  // 3. Recent journal entries (last 90 days)
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

  const { data: journals } = await supabase
    .from("thoughts")
    .select("id, content, type, importance, created_at")
    .eq("type", "journal")
    .gte("created_at", ninetyDaysAgo.toISOString())
    .is("metadata->>generated_by", null)
    .neq("sensitivity_tier", "restricted")
    .order("created_at", { ascending: false })
    .limit(20);

  if (journals) allThoughts.push(...journals);

  // Deduplicate by ID and cap
  const seen = new Set<number>();
  const unique: SourceThought[] = [];
  for (const t of allThoughts) {
    if (!seen.has(t.id)) {
      seen.add(t.id);
      unique.push(t);
    }
  }

  unique.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  return unique.slice(0, MAX_SOURCE_THOUGHTS);
}

// --- Check for existing profile ---

async function findExistingProfile(): Promise<{ id: number; content: string } | null> {
  const { data } = await supabase
    .from("thoughts")
    .select("id, content")
    .eq("metadata->>generated_by", "consolidation-bio")
    .eq("metadata->>artifact_type", "biographical_profile")
    .order("created_at", { ascending: false })
    .limit(1);

  if (data && data.length > 0) {
    return { id: data[0].id, content: data[0].content };
  }
  return null;
}

// --- Build prompt ---

function buildPrompt(sources: SourceThought[], previousProfile: string | null): string {
  const previousSection = previousProfile
    ? `\nPrevious profile (update and refine, don't start from scratch):\n---\n${previousProfile.slice(0, 8000)}\n---\n`
    : "";

  let totalChars = 0;
  const sourceLines: string[] = [];
  for (const t of sources) {
    const truncated = t.content.slice(0, MAX_CONTENT_PER_THOUGHT);
    if (totalChars + truncated.length > MAX_TOTAL_CONTENT) break;
    sourceLines.push(`[${t.type}] (${t.created_at.slice(0, 10)}, importance: ${t.importance})\n${truncated}`);
    totalChars += truncated.length;
  }

  return `You are synthesizing a biographical profile from a person's own captured thoughts and memories.

Create or update a factual profile covering: name, family, roles, current projects, values/frameworks, living situation, professional background, key relationships, current priorities, health/wellness practices.
${previousSection}
Source thoughts (most recent first):
---
${sourceLines.join("\n\n---\n\n")}
---

Write in third person. Be specific and factual. Do not embellish. Start with "Canonical Profile:"`;
}

// --- Generate profile via LLM with three-tier fallback (OpenRouter first) ---

async function generateProfile(prompt: string): Promise<string> {
  const providers: Array<{ name: string; fn: () => Promise<string> }> = [];

  // OB1: OpenRouter first
  if (OPENROUTER_API_KEY) {
    providers.push({ name: "openrouter", fn: async () => {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: BIO_MODEL,
          max_tokens: 4096,
          temperature: 0.2,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!response.ok) throw new Error(`OpenRouter API failed (${response.status}): ${await response.text()}`);
      return readChatCompletionText(await response.json());
    }});
  }

  if (OPENAI_API_KEY) {
    providers.push({ name: "openai", fn: async () => {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o",
          max_tokens: 4096,
          temperature: 0.2,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!response.ok) throw new Error(`OpenAI API failed (${response.status}): ${await response.text()}`);
      return readChatCompletionText(await response.json());
    }});
  }

  if (ANTHROPIC_API_KEY) {
    providers.push({ name: "anthropic", fn: async () => {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: BIO_MODEL_ANTHROPIC,
          max_tokens: 4096,
          temperature: 0.2,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!response.ok) throw new Error(`Anthropic API failed (${response.status}): ${await response.text()}`);
      return readAnthropicText(await response.json());
    }});
  }

  if (providers.length === 0) {
    throw new Error("No LLM API keys configured");
  }

  for (const { name, fn } of providers) {
    try {
      const text = await fn();
      if (text.trim()) return text.trim();
    } catch (err) {
      console.warn(`Profile generation failed (${name}):`, err);
    }
  }
  throw new Error("Profile synthesis failed: all LLM providers exhausted");
}

// --- Upsert the profile thought ---

async function upsertProfile(
  profileContent: string,
  sourceCount: number,
  existingId: number | null,
): Promise<{ id: number; created: boolean }> {
  const now = new Date().toISOString();

  const profileMetadata = {
    generated_by: "consolidation-bio",
    artifact_type: "biographical_profile",
    canonical: true,
    source_thought_count: sourceCount,
    last_updated_at: now,
    model: BIO_MODEL,
  };

  if (existingId) {
    const { error: updateError } = await supabase
      .from("thoughts")
      .update({
        content: profileContent,
        type: "person_note",
        importance: 5,
        source_type: "system_profile",
        metadata: profileMetadata,
        updated_at: now,
      })
      .eq("id", existingId);

    if (updateError) {
      throw new Error(`Failed to update existing profile (id=${existingId}): ${updateError.message}`);
    }
    return { id: existingId, created: false };
  }

  const { data, error } = await supabase.rpc("upsert_thought", {
    p_content: profileContent,
    p_payload: {
      type: "person_note",
      importance: 5,
      source_type: "system_profile",
      metadata: profileMetadata,
    },
  });

  if (error) {
    throw new Error(`upsert_thought RPC failed: ${error.message}`);
  }

  const thoughtId = typeof data === "number" ? data : (isRecord(data) ? data.id : null);
  if (!thoughtId) {
    throw new Error("upsert_thought did not return an ID");
  }

  return { id: thoughtId as number, created: true };
}

// --- Log to consolidation_log ---

async function logConsolidation(
  profileId: number,
  sourceCount: number,
  created: boolean,
): Promise<void> {
  const { error } = await supabase
    .from("consolidation_log")
    .insert({
      operation: "biographical_profile",
      survivor_id: profileId,
      details: {
        source_thought_count: sourceCount,
        action: created ? "created" : "updated",
        model: BIO_MODEL,
        timestamp: new Date().toISOString(),
      },
    });

  if (error) {
    // Non-fatal
    console.error("Failed to log consolidation:", error);
  }
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
  const dryRun = url.searchParams.get("dry_run") === "true";
  const targetName = url.searchParams.get("name") || undefined;

  try {
    const sources = await gatherSourceThoughts(targetName);
    if (sources.length === 0) {
      return json({
        error: "No source thoughts found for profile synthesis",
        hint: "Need person_note, decision (importance >= 4), or journal entries",
      }, 404);
    }

    const existing = await findExistingProfile();
    const prompt = buildPrompt(sources, existing?.content ?? null);
    const profileContent = await generateProfile(prompt);

    let result: { id: number | null; created: boolean } = { id: null, created: false };
    if (!dryRun) {
      result = await upsertProfile(profileContent, sources.length, existing?.id ?? null);
      await logConsolidation(result.id!, sources.length, result.created);
    }

    return json({
      dry_run: dryRun,
      profile: profileContent,
      source_thought_count: sources.length,
      source_types: {
        person_notes: sources.filter((s) => s.type === "person_note").length,
        decisions: sources.filter((s) => s.type === "decision").length,
        journals: sources.filter((s) => s.type === "journal").length,
      },
      action: dryRun ? "preview" : (result.created ? "created" : "updated"),
      thought_id: result.id,
      previous_profile_existed: existing !== null,
    });
  } catch (err) {
    console.error("consolidation-bio failed:", err);
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: "Profile synthesis failed", details: message }, 500);
  }
});
