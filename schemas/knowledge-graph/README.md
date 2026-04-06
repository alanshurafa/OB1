# Knowledge Graph Tables and Extraction Trigger

> Adds a knowledge graph layer to Open Brain for automatic entity and relationship extraction from thoughts.

## What It Does

This schema adds five tables and one trigger that together form a knowledge graph on top of your thoughts:

- **`entities`** -- Canonical graph nodes representing people, projects, topics, tools, organizations, and places. Deduplicates by normalized name within each type.
- **`edges`** -- Typed relationships between entities (co_occurs_with, works_on, uses, related_to, member_of, located_in) with support counts and confidence scores.
- **`thought_entities`** -- Evidence-bearing links between thoughts and entities. Records mention role, extraction confidence, and source.
- **`entity_extraction_queue`** -- Async queue for thoughts waiting to be processed by an extraction worker. Tracks attempt counts, errors, and content fingerprints for change detection.
- **`consolidation_log`** -- Audit trail for dedup merges, metadata fixes, bio synthesis, and other quality operations on the graph.

A trigger on the `thoughts` table automatically queues new or updated thoughts for entity extraction. It skips system-generated artifacts and ignores no-op updates where the content fingerprint has not changed.

## Prerequisites

- Working Open Brain setup (see the getting-started guide in `docs/01-getting-started.md`)
- Supabase project with the `thoughts` table, `match_thoughts` function, and `upsert_thought` function already created
- The `content_fingerprint` column on `thoughts` (created during Step 2.6 of the getting-started guide)
- Enhanced thoughts schema applied (see `schemas/enhanced-thoughts/`)

## Credential Tracker

Copy this block into a text editor and fill it in as you go.

```text
KNOWLEDGE GRAPH -- CREDENTIAL TRACKER
--------------------------------------

SUPABASE (from your Open Brain setup)
  Project URL:           ____________
  Secret key:            ____________

--------------------------------------
```

## Steps

1. Open your Supabase dashboard and navigate to the **SQL Editor**
2. Create a new query and paste the full contents of `schema.sql`
3. Click **Run** to execute the migration
4. Open **Table Editor** and confirm five new tables appear: `entities`, `edges`, `thought_entities`, `entity_extraction_queue`, `consolidation_log`
5. Navigate to **Database > Functions** and verify the `queue_entity_extraction` function exists
6. Navigate to **Database > Triggers** on the `thoughts` table and verify `trg_queue_entity_extraction` is attached
7. Test the trigger by capturing a new thought (via the MCP server or direct insert) and checking the queue:

   ```sql
   SELECT count(*) FROM entity_extraction_queue WHERE status = 'pending';
   -- Should return at least 1 after capturing a thought
   ```

8. *(Optional — existing brains only)* To backfill the extraction queue with pre-existing thoughts, uncomment and run the backfill section at the bottom of `schema.sql`

## Expected Outcome

After running the migration:

- Five new tables with appropriate columns, constraints, and defaults.
- Eight indexes for efficient querying: entity type and normalized name lookups, edge traversal by source/target/relation, thought-entity joins, and a partial index on pending queue items.
- One trigger function (`queue_entity_extraction`) that automatically enqueues thoughts for extraction on insert or content/metadata change, with guards for system-generated artifacts and no-op fingerprint changes.
- One trigger (`trg_queue_entity_extraction`) attached to the `thoughts` table firing after insert or update of content/metadata.
- Service role has full access to all five tables and their sequences. Anonymous and authenticated roles have read access for MCP tools and REST API queries.
- New thoughts are automatically queued for entity extraction. Pre-existing thoughts require the optional backfill step.

## Troubleshooting

**Issue: "relation already exists" warnings**
Solution: These are safe to ignore. The `CREATE TABLE IF NOT EXISTS` syntax prevents errors but may log informational notices. The migration is fully idempotent.

**Issue: trigger not firing on new thoughts**
Solution: The trigger fires `AFTER INSERT OR UPDATE OF content, metadata` on the `thoughts` table. Confirm the trigger exists by querying `SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.thoughts'::regclass;`. If missing, re-run the trigger section of the migration.

**Issue: queue not populating for existing thoughts**
Solution: The trigger only fires on new inserts or updates. For pre-existing thoughts, run the optional backfill query at the bottom of `schema.sql`. This safely inserts with `ON CONFLICT DO NOTHING`.

**Issue: "column content_fingerprint does not exist" error in trigger**
Solution: The trigger function reads `NEW.content_fingerprint` from the thoughts table. This column is created during Step 2.6 of the getting-started guide. If missing, apply that step first, then re-run this migration.

**Issue: entities table has duplicate entries**
Solution: The `UNIQUE (entity_type, normalized_name)` constraint prevents exact duplicates. If you see near-duplicates (e.g., "JavaScript" and "javascript"), these have different canonical names but the same normalized name should be caught. The extraction worker is responsible for consistent normalization.
