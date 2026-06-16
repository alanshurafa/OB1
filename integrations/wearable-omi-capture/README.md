# Omi Wearable Capture

> **Turn your Omi pendant into a passive feed for your Open Brain.** A Supabase Edge Function polls Omi every few minutes, and each new conversation lands as a `meeting` thought with one `task` thought per Omi action item — embedded, deduplicated, and searchable alongside the rest of your brain.

---

## What It Does

Omi records your spoken conversations and returns them already structured — a title, an overview, a category, and a list of action items. This integration is a thin **adapter** on top of [`wearable-capture-core`](../wearable-capture-core/): it pulls recent Omi conversations on a schedule and maps each one into thoughts using Omi's *own* structure, so there's **no per-item LLM classification cost**. The shared core owns the rest — idempotent dedup on Omi's conversation id, embedding via OpenRouter (`openai/text-embedding-3-small`), and the insert into `thoughts`.

Each non-discarded conversation produces:

- one **`meeting`** thought — `"{title} — {overview}"` (it falls back to a transcript snippet when the overview is thin), tagged with the Omi conversation id, category, and start/finish times;
- one **`task`** thought per entry in Omi's `action_items`.

Because it's a poller, there's no webhook to register and nothing public to secure — the function reaches out to Omi, not the other way around.

---

## Prerequisites

- **[Wearable Capture Core](../wearable-capture-core/) installed first.** This adapter imports the shared engine from `../_shared/wearable-sync.ts`. Follow that integration's README to copy `wearable-sync.ts` into `supabase/functions/_shared/` and set `OPENROUTER_API_KEY`. Without it, this function won't deploy.
- A working Open Brain setup (Supabase project with the `thoughts` table and pgvector).
- An Omi account with a personal developer API key (shaped `omi_dev_...`).
- An [OpenRouter](https://openrouter.ai) API key — already set if you installed the core.
- Supabase CLI installed and logged in.
- `pg_cron` and `pg_net` available in your Supabase project (both ship enabled on Supabase; Step 5 turns them on if needed).

**Cost**: Omi's API is included with the device. The only marginal cost is OpenRouter embeddings (no classification — the adapter reuses Omi's own summaries), roughly **$0.02–0.10/month** for typical personal volume.

---

## Credential Tracker

Fill these in as you go — you'll need them in Steps 2 and 5:

| Credential | Where it comes from | Value |
|---|---|---|
| `OMI_API_KEY` | Omi app/dashboard → Developer (Step 2) | |
| `OPENROUTER_API_KEY` | [openrouter.ai/keys](https://openrouter.ai/keys) | (set by the core) |
| `SUPABASE_URL` | Auto-injected by Supabase | (skip) |
| `SUPABASE_SERVICE_ROLE_KEY` | Auto-injected by Supabase | (skip) |
| `YOUR_PROJECT_REF` | Your Supabase project subdomain (Step 5) | |
| `CRON_SECRET` | Invent one in Step 5 (function key for cron) | |

---

## Steps

### Step 1 — Install the shared engine (prerequisite)

This adapter is built on the **Wearable Capture Core** engine and won't deploy without it.

Follow [`wearable-capture-core`](../wearable-capture-core/) now if you haven't:

1. Copy `wearable-sync.ts` into `supabase/functions/_shared/wearable-sync.ts`.
2. `supabase secrets set OPENROUTER_API_KEY="sk-or-v1-your-openrouter-key"`.

✅ **Done when:** `supabase/functions/_shared/wearable-sync.ts` exists and `OPENROUTER_API_KEY` shows in `supabase secrets list`.

---

### Step 2 — Get your Omi API key

1. Open the Omi app (or developer dashboard) and go to the Developer / API section.
2. Create a personal API key. It's shaped like `omi_dev_abc123...`.
3. Copy it into your tracker as `OMI_API_KEY`.

> [!WARNING]
> The Omi key is a credential. Don't paste it into code, commits, or screenshots — it goes into Supabase secrets only (Step 4).

✅ **Done when:** You have a key beginning `omi_dev_`. You can sanity-check it:

```bash
curl -H "Authorization: Bearer omi_dev_your_key" \
  "https://api.omi.me/v1/dev/user/conversations?include_transcript=true&limit=1&offset=0"
```

A working key returns a JSON **array** (possibly empty `[]`); an invalid key returns a `401`/`403`.

---

### Step 3 — Drop the function into your Supabase project

From the root of your Supabase project:

```bash
mkdir -p supabase/functions/wearable-omi-capture
```

Create `supabase/functions/wearable-omi-capture/index.ts` with the contents of [`index.ts`](./index.ts) from this folder. The only external dependency is the shared core, imported at the deploy path:

```typescript
import {
  runWearableSync,
  type WearableAdapter,
  type WearableThought,
} from "../_shared/wearable-sync.ts";
```

The adapter defines `listSince` (pages Omi newest-first and filters to the time window, since Omi has no `since` parameter), `recordId` (Omi's conversation id), and `recordToThoughts` (one `meeting` + one `task` per action item, skipping `discarded` conversations). `Deno.serve` then calls:

```typescript
const result = await runWearableSync(omiAdapter, { sinceHours: 12 });
```

and returns the `{ source, pulled, imported, skipped, failed, dryRun }` result as JSON.

✅ **Done when:** The file exists at `supabase/functions/wearable-omi-capture/index.ts` and `deno check` is clean (the `_shared/wearable-sync.ts` from Step 1 must be present for the import to resolve).

---

### Step 4 — Set the Omi secret

```bash
supabase secrets set OMI_API_KEY="omi_dev_your_key"
```

`OPENROUTER_API_KEY` is already set from the core (Step 1). `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically by the Supabase runtime, so you don't set those yourself.

✅ **Done when:** `supabase secrets list` shows both `OMI_API_KEY` and `OPENROUTER_API_KEY`.

---

### Step 5 — Deploy and schedule it (every 5 minutes)

**5a. Deploy the function**

```bash
supabase functions deploy wearable-omi-capture
```

Your function URL will look like:

```
https://YOUR_PROJECT_REF.supabase.co/functions/v1/wearable-omi-capture
```

(where `YOUR_PROJECT_REF` is the subdomain of your Supabase project). Keep it handy.

**5b. Schedule it with pg_cron + pg_net**

Run this SQL in the Supabase SQL editor. It runs the function every 5 minutes. Replace `YOUR_PROJECT_REF` with your project ref and `YOUR_CRON_SECRET` with a value you invent (any random string — it just needs to match a function-invocation key your project accepts; use your `SUPABASE_SERVICE_ROLE_KEY` or an anon key if your function requires JWT, or any bearer if deployed `--no-verify-jwt`).

```sql
-- Enable the schedulers (no-ops if already enabled).
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Poll Omi every 5 minutes.
select cron.schedule(
  'wearable-omi-capture-5m',
  '*/5 * * * *',
  $$
  select net.http_post(
    url     := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/wearable-omi-capture',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer YOUR_CRON_SECRET'
    ),
    body    := '{}'::jsonb
  );
  $$
);
```

The function's 12-hour rolling window means a missed run (or a paused schedule) self-heals on the next pass — overlapping windows are safe because the core dedups on Omi's conversation id.

To change or remove the schedule later:

```sql
select cron.unschedule('wearable-omi-capture-5m');
```

> [!IMPORTANT]
> `OPENROUTER_API_KEY` must already be set (from the core) or thoughts insert with a `null` embedding. That's recoverable — a later embedding backfill fills them — but set the key now to embed at capture time.

✅ **Done when:** `select * from cron.job where jobname = 'wearable-omi-capture-5m';` shows the schedule, and within ~5 minutes new Omi conversations start appearing in `thoughts`.

---

### Step 6 — Verify capture

After a cron run (or invoke the function once manually), confirm rows landed:

```sql
select count(*) from thoughts where metadata->>'wearable_source' = 'omi';
```

For a closer look at what was captured:

```sql
select
  metadata->>'type'                as type,
  left(content, 80)                as preview,
  metadata->>'category'            as category,
  created_at
from thoughts
where metadata->>'wearable_source' = 'omi'
order by created_at desc
limit 10;
```

You should see a mix of `meeting` rows (one per conversation) and `task` rows (one per Omi action item).

✅ **Done when:** the count is non-zero and growing across cron runs, with `meeting` and `task` rows tagged `metadata.wearable_source = 'omi'`.

---

## Expected Outcome

Every 5 minutes the function pulls Omi conversations from roughly the last 12 hours, skips ones it has already captured (deduped on Omi's conversation id), and writes the new ones. Each non-discarded conversation becomes one `meeting` thought built from Omi's title and overview, plus one `task` thought per Omi action item. Conversations Omi flagged as `discarded` are silently ignored. Re-runs and overlapping windows are safe and idempotent — there's no local state file, so a missed run self-heals on the next pass.

---

## Troubleshooting

**`OMI_API_KEY is required`**
The secret isn't set on the deployed function. Run `supabase secrets set OMI_API_KEY="omi_dev_your_key"` and redeploy.

**`Omi conversations 401` / `403` in the logs**
The Omi key is wrong, expired, or lacks developer access. Re-check it with the `curl` from Step 2, then reset the secret. Inspect logs with `supabase functions logs wearable-omi-capture`.

**Nothing is captured, but the function returns `200`**
Check the JSON result (`pulled`, `imported`, `skipped`). If `pulled` is `0`, no Omi conversations started inside the 12-hour window — talk to your Omi or widen the window by changing `sinceHours` in the `runWearableSync(...)` call. If `pulled` is non-zero but `imported` is `0`, those conversations were already captured (expected on every run after the first) or were all `discarded`.

**Thoughts insert but `embedding` is null**
`OPENROUTER_API_KEY` isn't set. The core inserts without an embedding by design (backfill-friendly); set the key from the core's Step 2 to embed at capture time.

**Duplicate rows for the same conversation**
The core dedups on `metadata.provider_event_id` (Omi's conversation id). If you see duplicates, confirm the cron isn't pointed at an older copy of the function and that `recordId` returns `c.id` (not a content hash).

**Cron never fires**
Confirm `pg_cron` is enabled (`select * from cron.job;`) and that `net.http_post` rows are being created (`select * from net._http_response order by created desc limit 5;` shows responses). A `401` in the response body means your `Authorization` bearer in the cron SQL doesn't match what the function expects.

---

## Tool Surface Area

This integration **registers no new MCP tools**. It is a capture-only ingestion path: a scheduled Supabase Edge Function that polls Omi and writes rows into the existing `thoughts` table via the shared `wearable-sync` engine.

| Component | Type | What it does |
|---|---|---|
| `wearable-omi-capture` Edge Function | Supabase poller (not an MCP server) | On a cron, lists recent Omi conversations, maps each to a `meeting` thought + `task` thoughts using Omi's own structure, and hands them to the core for embed + dedup + insert. |
| `wearable-sync.ts` | Shared Deno module (`_shared/`) | The engine this adapter is built on — dedup, embedding (OpenRouter), insert. See [wearable-capture-core](../wearable-capture-core/). |
| `thoughts` table | Existing Open Brain primitive | No schema changes — additive rows only. |

**External services called:** `api.omi.me/v1/dev` (list conversations) and `openrouter.ai/api/v1` (embeddings, via the core). Both are outbound HTTPS; the function exposes no inbound webhook beyond its own Supabase URL, which the cron calls.

**Auditing:** Because this integration adds no MCP tools, there's no MCP tool surface to audit for it directly. If you install it alongside MCP servers that read from `thoughts`, audit those per the [MCP Tool Audit & Optimization Guide](../../docs/05-tool-audit.md).

---

## Related

- [Wearable Capture Core](../wearable-capture-core/) — the shared engine this adapter is built on (**install first**).
- [Limitless Wearable Capture](../wearable-limitless-capture/) — sibling adapter for the Limitless Pendant.
- [Telegram Capture](../telegram-capture/) — webhook-based quick capture (push, not poll).
- [MCP Tool Audit & Optimization Guide](../../docs/05-tool-audit.md) — recommended reading for any integration contributor.
- [Contributing guide](../../CONTRIBUTING.md) — required reading before submitting changes.
