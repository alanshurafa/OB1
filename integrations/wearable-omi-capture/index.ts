/**
 * wearable-omi-capture — Omi pendant adapter for the wearable-capture-core engine.
 *
 * Omi (https://omi.me) is an always-on wearable that records spoken
 * conversations and returns them already structured: a title, an overview, a
 * category, and a list of action items, plus the raw transcript segments. This
 * adapter maps that device-native structure straight into Open Brain thoughts —
 * no LLM call of its own. The shared core (`_shared/wearable-sync.ts`) owns
 * everything else: idempotent dedup on the device's id, embedding via
 * OpenRouter, and the insert into `thoughts`.
 *
 * Deploy this file to `supabase/functions/wearable-omi-capture/index.ts`.
 * It imports the core from `../_shared/wearable-sync.ts`, so install
 * wearable-capture-core FIRST (see this integration's README).
 *
 * Omi API facts this adapter relies on:
 *   - Auth: `Authorization: Bearer <OMI_API_KEY>` (personal key, `omi_dev_...`).
 *   - Base: https://api.omi.me/v1/dev
 *   - List: GET /user/conversations?include_transcript=true&limit=50&offset=0
 *           -> a BARE JSON array of conversations (not wrapped).
 *   - No `since` parameter: page recent conversations and filter to the window.
 */
import {
  runWearableSync,
  type WearableAdapter,
  type WearableThought,
} from "../_shared/wearable-sync.ts";

const OMI_BASE = "https://api.omi.me/v1/dev";
const PAGE_SIZE = 50;
/** Safety cap on pages, so a far-back window can't loop forever. */
const MAX_PAGES = 20;

/** A single Omi transcript line. */
interface OmiSegment {
  speaker_id?: string | number;
  speaker_name?: string;
  start?: number;
  end?: number;
  text?: string;
}

/** Omi's device-native structured summary of a conversation. */
interface OmiStructured {
  title?: string;
  overview?: string;
  category?: string;
  emoji?: string;
  /** Each item is either a plain string or an object with `description`/`content`. */
  action_items?: Array<string | { description?: string; content?: string }>;
}

/** One Omi conversation as returned by the list endpoint. */
interface OmiConversation {
  id: string;
  created_at?: string;
  started_at?: string;
  finished_at?: string;
  discarded?: boolean;
  structured?: OmiStructured;
  transcript_segments?: OmiSegment[];
}

function omiKey(): string {
  const key = Deno.env.get("OMI_API_KEY");
  if (!key) throw new Error("OMI_API_KEY is required");
  return key;
}

/** Fetch one page of conversations (newest first), as the bare array Omi returns. */
async function fetchPage(offset: number): Promise<OmiConversation[]> {
  const url =
    `${OMI_BASE}/user/conversations?include_transcript=true&limit=${PAGE_SIZE}&offset=${offset}`;
  const r = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${omiKey()}`,
      "Accept": "application/json",
    },
  });
  if (!r.ok) {
    throw new Error(
      `Omi conversations ${r.status}: ${(await r.text()).slice(0, 200)}`,
    );
  }
  const body = await r.json();
  // The Omi list endpoint returns a bare JSON array, not a wrapped object.
  return Array.isArray(body) ? (body as OmiConversation[]) : [];
}

/** The timestamp Omi orders by and we filter on. */
function conversationStart(c: OmiConversation): string | undefined {
  return c.started_at ?? c.created_at;
}

/** Normalise one action item (string OR object) to its text, or "" to skip. */
function actionItemText(
  item: string | { description?: string; content?: string },
): string {
  if (typeof item === "string") return item.trim();
  return (item.description ?? item.content ?? "").trim();
}

/** Build a short fallback body from the first transcript segments. */
function transcriptSnippet(
  segments: OmiSegment[] | undefined,
  limit = 600,
): string {
  if (!segments || segments.length === 0) return "";
  const lines: string[] = [];
  for (const seg of segments) {
    const text = (seg.text ?? "").trim();
    if (!text) continue;
    const who = (seg.speaker_name ?? "").trim();
    lines.push(who ? `${who}: ${text}` : text);
    if (lines.join("\n").length >= limit) break;
  }
  return lines.join("\n").slice(0, limit).trim();
}

const omiAdapter: WearableAdapter<OmiConversation> = {
  sourceId: "omi",
  sourceType: "omi",

  /**
   * Omi has no `since` parameter, so page newest-first (limit 50, increasing
   * offset) and keep only conversations started at/after the window. Stop once
   * a page yields an item older than the window — pages are ordered newest
   * first, so everything beyond it is older too.
   */
  async listSince(sinceISO: string): Promise<OmiConversation[]> {
    const sinceMs = Date.parse(sinceISO);
    const kept: OmiConversation[] = [];

    for (let page = 0; page < MAX_PAGES; page++) {
      const batch = await fetchPage(page * PAGE_SIZE);
      if (batch.length === 0) break;

      let reachedOlder = false;
      for (const c of batch) {
        const startedRaw = conversationStart(c);
        const startedMs = startedRaw ? Date.parse(startedRaw) : NaN;
        // Undated conversations can't be windowed safely — skip them.
        if (Number.isNaN(startedMs)) continue;
        if (startedMs >= sinceMs) {
          kept.push(c);
        } else {
          reachedOlder = true;
          break;
        }
      }

      // Older-than-window item seen, or a short (final) page -> no more recent data.
      if (reachedOlder || batch.length < PAGE_SIZE) break;
    }

    return kept;
  },

  recordId(c: OmiConversation): string {
    return c.id;
  },

  /**
   * Map one Omi conversation to thoughts using the device's OWN structure:
   *   - skip entirely if Omi flagged it `discarded`,
   *   - one `meeting` thought from title + overview (transcript fallback),
   *   - one `task` thought per structured action item.
   * No LLM call — the core handles embedding, dedup, and insert.
   */
  recordToThoughts(c: OmiConversation): WearableThought[] {
    if (c.discarded === true) return [];

    const structured = c.structured ?? {};
    const title = (structured.title ?? "").trim() || "Omi conversation";
    const overview = (structured.overview ?? "").trim();
    const startedAt = conversationStart(c);

    // Prefer Omi's overview; fall back to a transcript snippet if it's too thin.
    const body = overview.length >= 40
      ? overview
      : (transcriptSnippet(c.transcript_segments) || overview);
    const content = body ? `${title} — ${body}` : title;

    const baseMeta = {
      omi_conversation_id: c.id,
      title,
      category: structured.category,
      started_at: c.started_at,
      finished_at: c.finished_at,
    };

    const thoughts: WearableThought[] = [{
      content,
      type: "meeting",
      metadata: baseMeta,
      createdAt: startedAt,
    }];

    for (const raw of structured.action_items ?? []) {
      const text = actionItemText(raw);
      if (!text) continue;
      thoughts.push({
        content: text,
        type: "task",
        metadata: { ...baseMeta, derived_from: "omi_action_item" },
        createdAt: startedAt,
      });
    }

    return thoughts;
  },
};

Deno.serve(async (): Promise<Response> => {
  try {
    const result = await runWearableSync(omiAdapter, { sinceHours: 12 });
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(`[wearable-omi-capture] ${(err as Error).message}`);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
