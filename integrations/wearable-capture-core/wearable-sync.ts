/**
 * wearable-sync — generic capture engine for always-on wearables.
 *
 * A small, reusable core that turns ANY polling wearable (Omi, Limitless, and
 * future devices) into Open Brain thoughts. Each device supplies a tiny
 * `WearableAdapter`; this engine owns everything the adapters share:
 *
 *   1. pull records since a rolling time window (the adapter makes the call),
 *   2. skip records already captured (idempotent dedup on the device's own id),
 *   3. map each record to one or more thoughts (the adapter, using the device's
 *      OWN structured output — no per-item LLM cost),
 *   4. embed the text (OpenRouter, OB1's standard) and insert into `thoughts`.
 *
 * Design rules (per OB1 CONTRIBUTING):
 *   - Never modifies the `thoughts` schema — additive rows only.
 *   - No secrets in code — every credential comes from Deno.env.
 *   - Idempotency lives in the brain, not a local file: dedup queries
 *     `thoughts.metadata` for (wearable_source, provider_event_id), so re-runs
 *     and overlapping windows are safe and the engine self-heals after outages.
 *
 * Deploy this file to `supabase/functions/_shared/wearable-sync.ts`; each
 * per-wearable adapter (e.g. `wearable-omi-capture`) imports it.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** One thought produced from a wearable record. `metadata` is merged with the
 *  engine's provenance keys; `type` maps to the thought type (default 'meeting'). */
export interface WearableThought {
  content: string;
  type?: string;
  importance?: number;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

/** The per-wearable contract. Implement these four members and the engine does
 *  the rest. `Record` is opaque to the engine — whatever the device API returns. */
export interface WearableAdapter<Record = unknown> {
  /** Stable short id for the device, e.g. "omi", "limitless". Used for dedup + provenance. */
  sourceId: string;
  /** The brain `source_type` to tag thoughts with, e.g. "omi", "limitless_lifelog". */
  sourceType: string;
  /** Pull records created/started at or after `sinceISO` (UTC ISO 8601). */
  listSince(sinceISO: string): Promise<Record[]>;
  /** The device's own stable id for a record (idempotency key — survives content edits). */
  recordId(record: Record): string;
  /** Map a record to thoughts using the device's OWN structure (no LLM call). */
  recordToThoughts(record: Record): WearableThought[];
}

export interface SyncOptions {
  /** Rolling lookback window in hours (default 12). A wider window self-heals longer outages. */
  sinceHours?: number;
  /** Don't write — just report what would be captured. */
  dryRun?: boolean;
  /** Embed thought text via OpenRouter before insert (default true; false leaves NULL embeddings
   *  for a later backfill). */
  embed?: boolean;
  /** Optional pre-built client (tests). Defaults to a service-role client from env. */
  client?: SupabaseClient;
}

export interface SyncResult {
  source: string;
  pulled: number;
  imported: number;
  skipped: number;
  failed: number;
  dryRun: boolean;
}

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

/** Embed text via OpenRouter (openai/text-embedding-3-small — OB1's default).
 *  Returns null if no key is set, so the engine still inserts (embedding backfilled later). */
async function embedText(text: string): Promise<number[] | null> {
  const key = Deno.env.get("OPENROUTER_API_KEY");
  if (!key) return null;
  const r = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "openai/text-embedding-3-small", input: text.slice(0, 8000) }),
  });
  if (!r.ok) throw new Error(`OpenRouter embeddings ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  return d?.data?.[0]?.embedding ?? null;
}

function defaultClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  return createClient(url, key);
}

/**
 * Run one capture pass for a wearable. Idempotent + additive: safe to call on a
 * tight schedule (e.g. every 5 minutes via cron).
 */
export async function runWearableSync<R>(
  adapter: WearableAdapter<R>,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const supabase = opts.client ?? defaultClient();
  const sinceHours = opts.sinceHours ?? 12;
  const sinceISO = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
  const dryRun = opts.dryRun ?? false;
  const doEmbed = opts.embed ?? true;

  const records = await adapter.listSince(sinceISO);
  let imported = 0, skipped = 0, failed = 0;

  for (const record of records) {
    const providerEventId = adapter.recordId(record);
    if (!providerEventId) { skipped++; continue; }
    try {
      // Idempotency: have we already captured this device record? Dedup on the
      // device's own id (stable across content edits), scoped to this device.
      const { data: existing, error: selErr } = await supabase
        .from("thoughts")
        .select("id")
        .contains("metadata", { wearable_source: adapter.sourceId, provider_event_id: providerEventId })
        .limit(1);
      if (selErr) throw selErr;
      if (existing && existing.length > 0) { skipped++; continue; }

      const thoughts = adapter.recordToThoughts(record);
      if (thoughts.length === 0) { skipped++; continue; }

      for (const t of thoughts) {
        const metadata = {
          ...(t.metadata ?? {}),
          source: adapter.sourceType,
          wearable_source: adapter.sourceId,
          provider_event_id: providerEventId,
          captured_via: "wearable-sync",
        };
        if (dryRun) continue;
        const row: Record<string, unknown> = {
          content: t.content,
          metadata: { ...metadata, type: t.type ?? "meeting", importance: t.importance ?? 3 },
        };
        if (t.createdAt) row.created_at = t.createdAt;
        if (doEmbed) {
          const emb = await embedText(t.content);
          if (emb) row.embedding = emb;
        }
        const { error: insErr } = await supabase.from("thoughts").insert(row);
        if (insErr) throw insErr;
      }
      imported++;
    } catch (e) {
      failed++;
      console.error(`[wearable-sync:${adapter.sourceId}] ${providerEventId}: ${(e as Error).message}`);
    }
  }

  return { source: adapter.sourceId, pulled: records.length, imported, skipped, failed, dryRun };
}
