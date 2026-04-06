# Enhanced Thoughts Columns and Utility RPCs

> Adds classification columns, full-text search, aggregate statistics, and connection discovery to your thoughts table.

## What It Does

This schema extends the core `thoughts` table with six new columns for classification and enrichment tracking (`type`, `sensitivity_tier`, `importance`, `quality_score`, `source_type`, `enriched`). It also installs three RPC functions: boolean full-text search, brain-wide statistics aggregation, and thought-connection discovery via shared topics and people.

## Prerequisites

- Working Open Brain setup ([guide](../../docs/01-getting-started.md)) with the `thoughts` table, `content_fingerprint` column, and `upsert_thought` function already in place
- Supabase project URL and service-role key in your credential tracker

## Credential Tracker

Copy this block into a text editor and fill it in as you go.

```text
ENHANCED THOUGHTS -- CREDENTIAL TRACKER
--------------------------------------

SUPABASE (from your Open Brain setup)
  Project URL:           ____________
  Secret key:            ____________

--------------------------------------
```

## Steps

1. Open your Supabase dashboard and navigate to **SQL Editor > New query**.

2. Copy the entire contents of [`schema.sql`](schema.sql) and paste it into the editor.

3. Click **Run**. The migration adds columns, creates indexes, installs three RPC functions, and backfills defaults on existing rows.

4. Verify the new columns exist. In the SQL Editor, run:

   ```sql
   SELECT column_name, data_type, column_default
   FROM information_schema.columns
   WHERE table_name = 'thoughts'
     AND column_name IN ('type', 'sensitivity_tier', 'importance',
                         'quality_score', 'source_type', 'enriched')
   ORDER BY column_name;
   ```

   You should see six rows.

5. Verify the RPCs are callable. Run each of these one at a time:

   ```sql
   -- Full-text search (returns thoughts matching the query)
   SELECT * FROM search_thoughts_text('test', 5);

   -- Brain stats (returns JSON with total, top_types, top_topics)
   SELECT brain_stats_aggregate(0);

   -- Thought connections (replace the UUID with a real thought ID)
   SELECT * FROM get_thought_connections('00000000-0000-0000-0000-000000000000'::uuid, 5);
   ```

## Expected Outcome

After running the migration you will have:

- **Six new columns** on the `thoughts` table: `type`, `sensitivity_tier`, `importance`, `quality_score`, `source_type`, and `enriched`.
- **Six new indexes**: a GIN index powering full-text search and five B-tree indexes for common filter patterns.
- **Three RPC functions**:
  - `search_thoughts_text(p_query, p_limit, p_filter, p_offset)` -- boolean full-text search with ILIKE fallback and relevance ranking.
  - `brain_stats_aggregate(p_since_days)` -- returns total thought count, top types, and top topics as JSON. Pass `0` for all-time stats.
  - `get_thought_connections(p_thought_id, p_limit, p_exclude_restricted)` -- finds related thoughts by shared metadata topics and people.
- All existing rows backfilled with sensible defaults.
- The existing `content_fingerprint` column, `upsert_thought` function, and `match_thoughts` function are untouched.

## Troubleshooting

**Issue: "column already exists" warning**
This is expected if you run the migration more than once. `ADD COLUMN IF NOT EXISTS` emits a notice but does not error. Safe to ignore.

**Issue: `search_thoughts_text` returns no results**
Make sure your thoughts have content. The GIN index only covers non-empty `content` values. Try a broad single-word query first (e.g., `SELECT * FROM search_thoughts_text('the', 5);`).

**Issue: `get_thought_connections` returns no rows**
This function looks for shared entries in the `metadata->'topics'` and `metadata->'people'` JSON arrays. If your thoughts do not have these metadata keys populated yet, no connections will be found. Enrich your thoughts with topics and people metadata first.
