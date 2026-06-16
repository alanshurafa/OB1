# Wearable Capture Core

> **A reusable engine that turns any always-on wearable into Open Brain thoughts.** Write a ~40-line adapter for your device; the core handles auth, idempotent dedup, embedding, and writes. Powers the [Omi](../wearable-omi-capture/) and [Limitless](../wearable-limitless-capture/) capture integrations.

---

## What It Does

Always-on wearables (Omi, Limitless, …) record your spoken life and expose it through a polling API. Each one needs the *same* plumbing to land in your brain — pull recent records, skip ones already captured, embed, insert. Rebuilding that per device is wasteful.

`wearable-sync.ts` is that plumbing, once. A per-device **adapter** supplies only what's unique — how to list records and how to turn one into a thought — and the core does the rest:

1. **Pull** records since a rolling time window (the adapter makes the call).
2. **Dedup** against the brain on the device's *own* record id, so re-runs and overlapping windows are safe and a missed run self-heals on the next pass — no local state file.
3. **Map** each record to one or more thoughts via the adapter, using the device's **own** structured output (title, summary, action items) — **no per-item LLM cost**.
4. **Embed** the text via OpenRouter (`openai/text-embedding-3-small`) and **insert** into `thoughts`.

It never modifies the `thoughts` schema (additive rows only) and never holds a secret in code (everything from `Deno.env`).

---

## The adapter contract

A wearable adapter implements four members:

```typescript
export interface WearableAdapter<Record = unknown> {
  sourceId: string;        // short device id, e.g. "omi" — used for dedup + provenance
  sourceType: string;      // brain source_type to tag, e.g. "omi"
  listSince(sinceISO: string): Promise<Record[]>;      // pull records at/after a UTC ISO time
  recordId(record: Record): string;                     // the device's own stable id (idempotency key)
  recordToThoughts(record: Record): WearableThought[];  // map one record -> thought(s), no LLM
}
```

The engine then runs a capture pass:

```typescript
import { runWearableSync } from "../_shared/wearable-sync.ts";
const result = await runWearableSync(myAdapter, { sinceHours: 12 });
// -> { source, pulled, imported, skipped, failed, dryRun }
```

Idempotency is keyed on `(metadata.wearable_source, metadata.provider_event_id)` — the device's own id, which is stable even when the device re-processes or edits a record's text later (so content-hash dedup would wrongly duplicate it).

---

## Prerequisites

- A working Open Brain setup (Supabase project with the `thoughts` table and pgvector).
- An [OpenRouter](https://openrouter.ai) API key (for embeddings).
- Supabase CLI installed and logged in.

**Cost**: OpenRouter embeddings only (no per-item LLM classification — adapters reuse the device's own summaries). Roughly **$0.02–0.10/month** for typical personal volume.

---

## Credential Tracker

| Credential | Where it comes from | Value |
|---|---|---|
| `OPENROUTER_API_KEY` | [openrouter.ai/keys](https://openrouter.ai/keys) | |
| `SUPABASE_URL` | Auto-injected by Supabase | (skip) |
| `SUPABASE_SERVICE_ROLE_KEY` | Auto-injected by Supabase | (skip) |

> [!WARNING]
> API keys are credentials. Set them with `supabase secrets set` — never paste them into code, commits, or screenshots.

---

## Steps

### Step 1 — Add the shared engine to your Supabase project

From the root of your Supabase project, create the shared module that every wearable adapter imports:

```bash
mkdir -p supabase/functions/_shared
```

Copy [`wearable-sync.ts`](./wearable-sync.ts) from this folder to `supabase/functions/_shared/wearable-sync.ts`.

✅ **Done when:** `supabase/functions/_shared/wearable-sync.ts` exists and `deno check supabase/functions/_shared/wearable-sync.ts` is clean.

---

### Step 2 — Set the embedding key

```bash
supabase secrets set OPENROUTER_API_KEY="sk-or-v1-your-openrouter-key"
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically by the Supabase runtime, so you don't set those yourself.

✅ **Done when:** `supabase secrets list` shows `OPENROUTER_API_KEY`.

---

### Step 3 — Add a device adapter

This package is the engine only — it captures nothing on its own. Add at least one device:

- **[Omi](../wearable-omi-capture/)** — Omi pendant conversations.
- **[Limitless](../wearable-limitless-capture/)** — Limitless Pendant lifelogs.

…or write your own adapter for any polling wearable by implementing the four-method `WearableAdapter` interface above.

✅ **Done when:** a device adapter function is deployed and writing thoughts (see its README).

---

## Expected Outcome

With the core in place and one or more adapters deployed, each wearable's new records become `thoughts` rows — embedded, deduplicated on the device's own id, and tagged with `metadata.source` / `metadata.wearable_source` for retrieval and provenance. The same engine serves every device, so adding the next wearable is a small adapter, not a new pipeline.

---

## Troubleshooting

**`SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required`** — these are injected automatically inside a deployed edge function; if you see this you're running outside the Supabase runtime. Provide them via env, or pass a pre-built `client` in `SyncOptions` (handy for tests).

**Thoughts insert but `embedding` is null** — `OPENROUTER_API_KEY` isn't set, so the engine inserts without an embedding (by design — a later embedding backfill can fill it). Set the key to embed at capture time.

**Duplicate rows for the same recording** — confirm your adapter's `recordId()` returns the device's *stable* id (not a content hash). Dedup matches `metadata.provider_event_id`; if that value changes per run, dedup can't catch it.

---

## Tool Surface Area

This integration **registers no new MCP tools**. It is a capture-only path: a shared engine that per-device adapter edge functions call to write rows into the existing `thoughts` table.

| Component | Type | What it does |
|---|---|---|
| `wearable-sync.ts` | Shared Deno module (`_shared/`) | Pulls via an adapter, dedups, embeds (OpenRouter), inserts into `thoughts`. |
| `thoughts` table | Existing Open Brain primitive | No schema changes — additive rows only. |

**External services called:** `openrouter.ai/api/v1` (embeddings). Device APIs are called by the adapters, not the core.

---

## Related

- [Omi Wearable Capture](../wearable-omi-capture/) — adapter for the Omi pendant.
- [Limitless Wearable Capture](../wearable-limitless-capture/) — adapter for the Limitless Pendant.
- [Smart Ingest](../smart-ingest/) — LLM extraction + dedup for raw documents (heavier path).
- [Contributing guide](../../CONTRIBUTING.md) — required reading before submitting changes.
