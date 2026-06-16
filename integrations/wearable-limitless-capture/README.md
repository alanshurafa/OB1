# Limitless Wearable Capture

> **Land your Limitless Pendant lifelogs in your Open Brain automatically.** A scheduled poller pulls recent recordings from the Limitless API, maps each one to a `meeting` thought using the device's own title and section headings, embeds it, and stores it — no per-item LLM cost.

---

## What It Does

A Supabase Edge Function runs on a schedule (every 5 minutes) and asks the Limitless lifelog API for recordings in a rolling time window. Each lifelog becomes one `thoughts` row of type `meeting`: the content is the lifelog title plus its section headings (or a transcript snippet if there are no headings), and the metadata carries the Limitless lifelog id and start/finish times. The shared **wearable-capture-core** engine does the heavy lifting — idempotent dedup on the device's own id, embedding via OpenRouter, and the insert. This adapter only knows how to *list* Limitless lifelogs and *map* one to a thought.

Because dedup keys on the device's stable lifelog id (not a content hash), overlapping poll windows and re-runs are safe, and a missed run self-heals on the next pass — no local state file.

---

## Prerequisites

- **The [wearable-capture-core](../wearable-capture-core/) engine installed first.** This adapter imports it from `../_shared/wearable-sync.ts`; without it, the function won't deploy. Follow that README through Step 2 (it also sets `OPENROUTER_API_KEY`, which this adapter relies on for embeddings).
- A working Open Brain setup (Supabase project with the `thoughts` table and pgvector).
- A **Limitless** account with a Pendant and an API key. Get the key from the Limitless app → **Developer settings** (Settings → Developer / API).
- An [OpenRouter](https://openrouter.ai) API key (set when you install the core — used for embeddings).
- Supabase CLI installed and logged in.

**Cost**: Limitless API access is included with your Limitless subscription. The only marginal cost here is OpenRouter embeddings (no per-item LLM classification — the adapter reuses the device's own structure), roughly **$0.02–0.10/month** for typical personal volume.

---

## Credential Tracker

Fill these in as you go — you'll need them in Steps 2 and 5:

| Credential | Where it comes from | Value |
|---|---|---|
| `LIMITLESS_API_KEY` | Limitless app → Developer settings (Step 2) | |
| `OPENROUTER_API_KEY` | Set when installing wearable-capture-core ([openrouter.ai/keys](https://openrouter.ai/keys)) | (from core) |
| `SUPABASE_URL` | Auto-injected by Supabase | (skip) |
| `SUPABASE_SERVICE_ROLE_KEY` | Auto-injected by Supabase | (skip) |

> [!WARNING]
> The Limitless API key is a credential. Set it with `supabase secrets set` — never paste it into code, commits, or screenshots.

---

## Steps

### Step 1 — Install the wearable-capture-core engine

This adapter is built on the shared engine and can't run without it.

Follow the [wearable-capture-core README](../wearable-capture-core/) through **Step 2**. That gives you:

- `supabase/functions/_shared/wearable-sync.ts` (the engine this function imports), and
- `OPENROUTER_API_KEY` set as a Supabase secret (used for embeddings).

✅ **Done when:** `supabase/functions/_shared/wearable-sync.ts` exists and `supabase secrets list` shows `OPENROUTER_API_KEY`.

---

### Step 2 — Get your Limitless API key and set it

1. Open the Limitless app and go to **Settings → Developer settings** (sometimes labelled API).
2. Create / copy your API key.
3. Set it as a Supabase secret (replace the placeholder with your real key, no angle brackets):

```bash
supabase secrets set LIMITLESS_API_KEY="your_limitless_api_key"
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically by the Supabase runtime, so you don't set those yourself.

✅ **Done when:** `supabase secrets list` shows `LIMITLESS_API_KEY` (and `OPENROUTER_API_KEY` from Step 1).

---

### Step 3 — Drop the function into your Supabase project

From the root of your Supabase project:

```bash
mkdir -p supabase/functions/wearable-limitless-capture
```

Copy [`index.ts`](./index.ts) from this folder to `supabase/functions/wearable-limitless-capture/index.ts`. It imports the engine from `../_shared/wearable-sync.ts`, so the relative path lines up once the core is in place from Step 1.

The function defines a Limitless adapter (`sourceId: "limitless"`, `sourceType: "limitless_lifelog"`) and, on each invocation, calls:

```typescript
const result = await runWearableSync(limitlessAdapter, { sinceHours: 12 });
```

It returns the engine's `{ source, pulled, imported, skipped, failed, dryRun }` result as JSON.

✅ **Done when:** The file exists at `supabase/functions/wearable-limitless-capture/index.ts` and `deno check index.ts` is clean.

---

### Step 4 — Deploy the edge function

```bash
supabase functions deploy wearable-limitless-capture
```

Your function URL will look like:

```
https://YOUR_PROJECT_REF.supabase.co/functions/v1/wearable-limitless-capture
```

(where `YOUR_PROJECT_REF` is the subdomain of your actual Supabase project). Keep the full URL handy for Step 5.

You can trigger it once by hand to confirm it runs (the function reads its credentials from secrets, so no auth header is needed for the smoke test if you deployed with `--no-verify-jwt`; otherwise call it from the scheduled job in Step 5):

```bash
curl -X POST "https://YOUR_PROJECT_REF.supabase.co/functions/v1/wearable-limitless-capture"
```

A healthy run returns JSON like `{"source":"limitless","pulled":3,"imported":3,"skipped":0,"failed":0,"dryRun":false}`.

✅ **Done when:** `supabase functions deploy` prints a success URL and a manual invocation returns a JSON result object.

---

### Step 5 — Schedule the poller (every 5 minutes)

Limitless has no webhook, so we poll. Use `pg_cron` + `net.http_post` to hit the function URL on a cron. Run this SQL in the Supabase SQL editor (enable the `pg_cron` and `pg_net` extensions first if they aren't already):

```sql
-- Enable the extensions (no-op if already enabled)
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Poll Limitless every 5 minutes
select cron.schedule(
  'wearable-limitless-capture',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/wearable-limitless-capture',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
    ),
    body := '{}'::jsonb
  );
  $$
);
```

> [!IMPORTANT]
> `OPENROUTER_API_KEY` must already be set (you set it while installing wearable-capture-core in Step 1) — the engine uses it to embed each thought at capture time. If it's missing, rows still insert but with a NULL embedding for a later backfill.

> [!NOTE]
> Replace `YOUR_PROJECT_REF` with your project subdomain. The `sinceHours: 12` lookback in the function means the 5-minute cron has a wide overlap; the engine's id-based dedup makes that overlap free of duplicates and lets a missed run self-heal.

To change or remove the schedule later:

```sql
-- Inspect
select * from cron.job where jobname = 'wearable-limitless-capture';
-- Remove
select cron.unschedule('wearable-limitless-capture');
```

✅ **Done when:** `select * from cron.job where jobname = 'wearable-limitless-capture';` shows the job and, after a few minutes, lifelogs start appearing in `thoughts`.

---

### Step 6 — Verify capture

After a cron tick (or a manual invocation), confirm rows landed:

```sql
select count(*) from thoughts where metadata->>'wearable_source' = 'limitless';
```

For a closer look at a few captured lifelogs:

```sql
select id, content, metadata->>'title' as title, metadata->>'started_at' as started_at
from thoughts
where metadata->>'wearable_source' = 'limitless'
order by created_at desc
limit 5;
```

✅ **Done when:** The count is non-zero and recent rows show your lifelog titles with a populated embedding.

---

## Expected Outcome

Every 5 minutes, new Limitless lifelogs become `meeting` thoughts in your brain — embedded, deduplicated on the device's own lifelog id, and tagged with `metadata.source = 'limitless_lifelog'` and `metadata.wearable_source = 'limitless'` for retrieval and provenance. Content is the lifelog title plus its section headings (or a transcript snippet when there are no headings), built from the device's own structure with no LLM call. Overlapping poll windows and re-runs never produce duplicates, and a skipped run self-heals on the next pass.

---

## Troubleshooting

**Function won't deploy: cannot find `../_shared/wearable-sync.ts`**
The wearable-capture-core engine isn't installed. Complete Step 1 — copy `wearable-sync.ts` into `supabase/functions/_shared/` — then redeploy.

**`LIMITLESS_API_KEY is required` in the logs**
The secret isn't set (or the function was deployed before you set it). Run `supabase secrets set LIMITLESS_API_KEY="..."`, then redeploy. Check with `supabase secrets list`.

**Limitless API returns 401 / 403**
The API key is wrong, revoked, or truncated. Regenerate it in the Limitless app → Developer settings and re-set the secret. Note the adapter authenticates with the `X-API-Key` header (not a bearer token).

**`pulled` is non-zero but `imported` is 0 (all skipped)**
Those lifelogs are already in the brain — dedup matched their `provider_event_id`. This is the steady state once you've caught up. To confirm, lower nothing; just check the count in Step 6 is growing over time as new recordings come in.

**Thoughts insert but `embedding` is null**
`OPENROUTER_API_KEY` isn't set (it comes from the core install). Set it and future captures embed at write time; a later embedding backfill can fill the gaps.

**Cron job runs but nothing happens**
Confirm `pg_cron` and `pg_net` are enabled, that the URL in `cron.schedule` is your real project ref, and that the Authorization header resolves to a valid service-role key. Inspect `select * from cron.job_run_details order by start_time desc limit 5;` for HTTP errors, and check `supabase functions logs wearable-limitless-capture`.

---

## Tool Surface Area

This integration **registers no new MCP tools**. It is a capture-only path: a scheduled edge function that calls the shared wearable engine to write rows into the existing `thoughts` table.

| Component | Type | What it does |
|---|---|---|
| `wearable-limitless-capture` Edge Function | Supabase scheduled poller (not an MCP server) | Pulls recent lifelogs from the Limitless API and maps each to a `meeting` thought via the adapter. |
| `wearable-sync.ts` | Shared Deno module (from [wearable-capture-core](../wearable-capture-core/)) | Dedups, embeds (OpenRouter), and inserts into `thoughts`. |
| `thoughts` table | Existing Open Brain primitive | No schema changes — additive rows only. |

**External services called:** `api.limitless.ai/v1` (lifelog list, by the adapter) and `openrouter.ai/api/v1` (embeddings, by the core). Both are outbound HTTPS.

---

## Related

- [Wearable Capture Core](../wearable-capture-core/) — the engine this adapter is built on (install first).
- [Omi Wearable Capture](../wearable-omi-capture/) — sibling adapter for the Omi pendant.
- [Smart Ingest](../smart-ingest/) — LLM extraction + dedup for raw documents (heavier path).
- [MCP Tool Audit & Optimization Guide](../../docs/05-tool-audit.md) — recommended reading for any integration contributor.
- [Contributing guide](../../CONTRIBUTING.md) — required reading before submitting changes.
