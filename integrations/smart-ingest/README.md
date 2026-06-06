# Smart Ingest

> Supabase Edge Function for review-first ingestion of extracted records.

## What It Does

Smart Ingest accepts already-extracted records from offline import recipes, creates an ingestion dry run, and stores reviewable items in `public.ingestion_items`. It can later execute approved items through the core `upsert_thought` RPC.

This integration does not parse source exports, call an LLM, generate embeddings, or ship dashboard screens. It is the backend lifecycle layer between offline import preparation and reviewed writes into Open Brain.

## Prerequisites

- Working Open Brain setup ([guide](../../docs/01-getting-started.md))
- `schemas/ingestion-jobs` applied
- Supabase CLI
- Service-role key for the Edge Function
- A private `SMART_INGEST_KEY` for request authentication

## Credential Tracker

```text
SMART INGEST -- CREDENTIAL TRACKER
--------------------------------------

FROM YOUR OPEN BRAIN SETUP
  Supabase Project URL:       ____________
  Supabase Service Role Key:  ____________

GENERATED DURING SETUP
  Smart Ingest Key:           ____________
  Edge Function URL:          ____________

--------------------------------------
```

## Steps

1. Copy this folder into your Supabase functions directory:

   ```bash
   mkdir -p supabase/functions/smart-ingest
   cp integrations/smart-ingest/* supabase/functions/smart-ingest/
   ```

2. Deploy the function:

   ```bash
   supabase functions deploy smart-ingest --no-verify-jwt
   ```

3. Set secrets:

   ```bash
   supabase secrets set \
     SUPABASE_URL="https://YOUR_PROJECT_REF.supabase.co" \
     SUPABASE_SERVICE_ROLE_KEY="your-service-role-key" \
     SMART_INGEST_KEY="choose-a-long-random-value"
   ```

4. Create a dry-run job:

   ```bash
   curl -X POST "https://YOUR_PROJECT_REF.supabase.co/functions/v1/smart-ingest" \
     -H "Content-Type: application/json" \
     -H "x-brain-key: choose-a-long-random-value" \
     -d '{
       "source_type": "manual",
       "source_label": "Manual smoke test",
       "records": [
         {
           "content": "Use dry-run import review before writing migrated records.",
           "source_path": "manual-smoke-test",
           "source_locator": "record-1",
           "type": "reference",
           "topics": ["import", "review"]
         }
       ]
     }'
   ```

5. Review generated items in SQL:

   ```sql
   select id, sequence, action, status, review_status, extracted_content
   from public.ingestion_items
   order by created_at desc
   limit 10;
   ```

6. Approve an item:

   ```sql
   update public.ingestion_items
   set review_status = 'approved'
   where id = '<item-id>';
   ```

7. Execute the approved item:

   ```bash
   curl -X POST "https://YOUR_PROJECT_REF.supabase.co/functions/v1/smart-ingest/execute" \
     -H "Content-Type: application/json" \
     -H "x-brain-key: choose-a-long-random-value" \
     -d '{ "job_id": "<job-id>" }'
   ```

## Expected Outcome

The create request returns a response like:

```json
{
  "status": "dry_run_complete",
  "job_id": "00000000-0000-4000-8000-000000000001",
  "extracted_count": 1,
  "message": "Dry run complete: 1 reviewable item(s) ready."
}
```

After execution, approved `add` items are written through `upsert_thought`, and the job status becomes `complete` unless an item fails.

## API

| Route | Method | Purpose |
| ----- | ------ | ------- |
| `/smart-ingest` | `GET` | Health check. |
| `/smart-ingest` | `POST` | Create a dry-run job from `records`, `record`, or `text`. |
| `/smart-ingest/execute` | `POST` | Execute ready, approved items for a job. |

`POST /smart-ingest` accepts:

| Field | Required | Description |
| ----- | -------- | ----------- |
| `records` | no | Array of extracted records from the import kit or file converter. |
| `record` | no | Single extracted record. |
| `text` | no | Convenience single-record text input. |
| `source_type` | no | Fallback source slug. |
| `source_label` | no | Human-readable source label. |

One of `records`, `record`, or `text` is required.

`POST /smart-ingest/execute` accepts:

| Field | Required | Description |
| ----- | -------- | ----------- |
| `job_id` | yes | Ingestion job UUID. |
| `execute_unreviewed` | no | Defaults to `false`. Keep this false for normal workflows. |

## Safety Notes

- Requests require `x-brain-key` or `Authorization: Bearer`.
- New items default to `review_status = 'unreviewed'`.
- Execution only processes approved items unless `execute_unreviewed` is explicitly true.
- Content length and record count are capped by environment variables.
- This function stores extracted records, not whole raw transcripts.

## Tool Audit

This integration exposes an authenticated write surface. Review it with the [MCP Tool Audit & Optimization Guide](../../docs/05-tool-audit.md) before exposing it to agent clients.

## Troubleshooting

**Issue: `missing_config`**
Solution: Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `SMART_INGEST_KEY`.

**Issue: `unauthorized`**
Solution: Send the configured key in the `x-brain-key` header or as a bearer token.

**Issue: `Could not find the table public.ingestion_jobs`**
Solution: Apply `schemas/ingestion-jobs` first.

**Issue: execution finds zero items**
Solution: Confirm the items are `status = 'ready'` and `review_status = 'approved'`.

## Related

This integration fits the Open Brain workflow from Nate B. Jones. Nate shares practical systems at [Nate's Newsletter](https://substack.com/@natesnewsletter) and [natebjones.com](https://natebjones.com).
