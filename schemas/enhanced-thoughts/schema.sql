-- ============================================================================
-- Enhanced Thoughts: columns, indexes, and utility RPCs
-- ============================================================================
-- Adds classification columns to the core thoughts table, a GIN index for
-- full-text search, and three RPC functions for text search, aggregate
-- statistics, and thought-connection discovery.
--
-- Safe to run on an existing Open Brain database — uses ADD COLUMN IF NOT
-- EXISTS, CREATE INDEX IF NOT EXISTS, and CREATE OR REPLACE FUNCTION.
-- ============================================================================

-- ── 1. New columns ─────────────────────────────────────────────────────────

ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS type           TEXT DEFAULT 'idea';
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS sensitivity_tier TEXT DEFAULT 'standard';
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS importance     SMALLINT DEFAULT 3;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS quality_score  NUMERIC(5,2) DEFAULT 50;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS source_type    TEXT DEFAULT '';
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS enriched       BOOLEAN DEFAULT false;

-- ── 2. Indexes ─────────────────────────────────────────────────────────────

-- GIN index for full-text search over thought content
CREATE INDEX IF NOT EXISTS thoughts_search_gin_idx
  ON thoughts USING gin (to_tsvector('simple', coalesce(content, '')));

-- B-tree indexes for common filter/sort patterns
CREATE INDEX IF NOT EXISTS thoughts_type_idx             ON thoughts (type);
CREATE INDEX IF NOT EXISTS thoughts_source_type_idx      ON thoughts (source_type);
CREATE INDEX IF NOT EXISTS thoughts_sensitivity_tier_idx ON thoughts (sensitivity_tier);
CREATE INDEX IF NOT EXISTS thoughts_importance_idx       ON thoughts (importance);
CREATE INDEX IF NOT EXISTS thoughts_enriched_idx         ON thoughts (enriched);

-- ── 3. RPC: search_thoughts_text ───────────────────────────────────────────
-- Full-text search with boolean operators (AND, OR, -NOT, "quoted phrases").
-- Uses the GIN index first, then falls back to ILIKE only when needed.

CREATE OR REPLACE FUNCTION search_thoughts_text(
  p_query  TEXT,
  p_limit  INTEGER DEFAULT 10,
  p_filter JSONB   DEFAULT '{}'::jsonb,
  p_offset INTEGER DEFAULT 0
)
RETURNS TABLE (
  id               UUID,
  content          TEXT,
  type             TEXT,
  source_type      TEXT,
  importance       SMALLINT,
  quality_score    NUMERIC(5,2),
  sensitivity_tier TEXT,
  metadata         JSONB,
  created_at       TIMESTAMPTZ,
  rank             REAL
)
LANGUAGE plpgsql
VOLATILE
SET statement_timeout = '25s'
AS $$
BEGIN
  RETURN QUERY
  WITH query_input AS (
    SELECT
      trim(coalesce(p_query, ''))                                          AS raw_query,
      websearch_to_tsquery('simple', trim(coalesce(p_query, '')))          AS ts_query
  ),
  -- Phase 1: GIN-indexed tsvector search (fast, uses index)
  tsvector_hits AS (
    SELECT t.id AS hit_id
    FROM thoughts t
    CROSS JOIN query_input q
    WHERE q.raw_query <> ''
      AND to_tsvector('simple', coalesce(t.content, '')) @@ q.ts_query
      AND t.metadata @> coalesce(p_filter, '{}'::jsonb)
    LIMIT 500
  ),
  -- Phase 2: ILIKE fallback only when tsvector returned fewer than p_limit rows
  ilike_hits AS (
    SELECT t.id AS hit_id
    FROM thoughts t
    CROSS JOIN query_input q
    WHERE q.raw_query <> ''
      AND (SELECT count(*) FROM tsvector_hits) < p_limit
      AND t.content ILIKE '%' || q.raw_query || '%'
      AND t.metadata @> coalesce(p_filter, '{}'::jsonb)
      AND t.id NOT IN (SELECT th.hit_id FROM tsvector_hits th)
    LIMIT 100
  ),
  all_hits AS (
    SELECT hit_id FROM tsvector_hits
    UNION
    SELECT hit_id FROM ilike_hits
  )
  SELECT
    t.id,
    t.content,
    t.type,
    t.source_type,
    t.importance,
    t.quality_score,
    t.sensitivity_tier,
    t.metadata,
    t.created_at,
    (
      greatest(
        ts_rank_cd(
          to_tsvector('simple', coalesce(t.content, '')),
          q.ts_query
        ),
        CASE
          WHEN q.raw_query <> '' AND t.content ILIKE '%' || q.raw_query || '%'
            THEN 0.35
          ELSE 0
        END
      )
      + (coalesce(t.importance, 3) / 20.0)::REAL
      + (coalesce(t.quality_score, 50) / 500.0)::REAL
    )::REAL AS rank
  FROM thoughts t
  CROSS JOIN query_input q
  WHERE t.id IN (SELECT ah.hit_id FROM all_hits ah)
  ORDER BY rank DESC, t.created_at DESC
  LIMIT  greatest(1, least(coalesce(p_limit, 10), 100))
  OFFSET greatest(0, coalesce(p_offset, 0));
END;
$$;

-- ── 4. RPC: brain_stats_aggregate ──────────────────────────────────────────
-- Returns total thought count, top types, and top topics.
-- p_since_days = 0 means all-time (no time filter).

CREATE OR REPLACE FUNCTION brain_stats_aggregate(
  p_since_days INTEGER DEFAULT 30
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total  BIGINT;
  v_types  JSONB;
  v_topics JSONB;
  v_since  TIMESTAMPTZ;
BEGIN
  -- p_since_days = 0 means all-time
  IF p_since_days > 0 THEN
    v_since := now() - (p_since_days || ' days')::interval;
  ELSE
    v_since := '-infinity'::TIMESTAMPTZ;
  END IF;

  -- Total thoughts (all-time)
  SELECT count(*) INTO v_total FROM thoughts;

  -- Top types within the time window
  SELECT coalesce(
    jsonb_agg(jsonb_build_object('type', t.type, 'count', t.cnt)),
    '[]'::jsonb
  )
  INTO v_types
  FROM (
    SELECT type, count(*) AS cnt
    FROM thoughts
    WHERE created_at >= v_since
    GROUP BY type
    ORDER BY cnt DESC
    LIMIT 20
  ) t;

  -- Top topics within the time window
  SELECT coalesce(
    jsonb_agg(jsonb_build_object('topic', t.topic, 'count', t.cnt)),
    '[]'::jsonb
  )
  INTO v_topics
  FROM (
    SELECT topic.value AS topic, count(*) AS cnt
    FROM thoughts,
         jsonb_array_elements_text(
           coalesce(metadata->'topics', '[]'::jsonb)
         ) AS topic(value)
    WHERE created_at >= v_since
    GROUP BY topic.value
    ORDER BY cnt DESC
    LIMIT 20
  ) t;

  RETURN jsonb_build_object(
    'total',      v_total,
    'top_types',  v_types,
    'top_topics', v_topics
  );
END;
$$;

-- ── 5. RPC: get_thought_connections ────────────────────────────────────────
-- Finds thoughts that share metadata topics or people with a given thought.
-- Uses EXISTS subqueries to avoid edge cases with the ?| operator on empty
-- arrays or NULL metadata.

CREATE OR REPLACE FUNCTION get_thought_connections(
  p_thought_id         UUID,
  p_limit              INTEGER DEFAULT 20,
  p_exclude_restricted BOOLEAN DEFAULT true
)
RETURNS TABLE (
  id             UUID,
  type           TEXT,
  importance     SMALLINT,
  preview        TEXT,
  created_at     TIMESTAMPTZ,
  shared_topics  TEXT[],
  shared_people  TEXT[],
  overlap_count  INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  source_topics TEXT[];
  source_people TEXT[];
BEGIN
  -- Retrieve the source thought's topics and people arrays
  SELECT
    coalesce(
      (SELECT array_agg(val)
       FROM jsonb_array_elements_text(t.metadata->'topics') val),
      '{}'::TEXT[]
    ),
    coalesce(
      (SELECT array_agg(val)
       FROM jsonb_array_elements_text(t.metadata->'people') val),
      '{}'::TEXT[]
    )
  INTO source_topics, source_people
  FROM thoughts t
  WHERE t.id = p_thought_id;

  -- Nothing to match if the source has no topics or people
  IF source_topics = '{}'::TEXT[] AND source_people = '{}'::TEXT[] THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT
      bt.id,
      bt.type,
      bt.importance,
      left(bt.content, 200)            AS preview,
      bt.created_at,
      coalesce(
        (SELECT array_agg(val)
         FROM jsonb_array_elements_text(bt.metadata->'topics') val
         WHERE val = ANY(source_topics)),
        '{}'::TEXT[]
      ) AS shared_topics,
      coalesce(
        (SELECT array_agg(val)
         FROM jsonb_array_elements_text(bt.metadata->'people') val
         WHERE val = ANY(source_people)),
        '{}'::TEXT[]
      ) AS shared_people
    FROM thoughts bt
    WHERE bt.id != p_thought_id
      AND (NOT p_exclude_restricted OR bt.sensitivity_tier != 'restricted')
      AND (
        EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(bt.metadata->'topics') val
          WHERE val = ANY(source_topics)
        )
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(bt.metadata->'people') val
          WHERE val = ANY(source_people)
        )
      )
  )
  SELECT
    c.id, c.type, c.importance, c.preview, c.created_at,
    c.shared_topics, c.shared_people,
    (coalesce(array_length(c.shared_topics, 1), 0)
     + coalesce(array_length(c.shared_people, 1), 0))::INTEGER AS overlap_count
  FROM candidates c
  ORDER BY overlap_count DESC, c.created_at DESC
  LIMIT p_limit;
END;
$$;

-- ── 6. Grants ──────────────────────────────────────────────────────────────

GRANT EXECUTE ON FUNCTION search_thoughts_text(TEXT, INTEGER, JSONB, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION brain_stats_aggregate(INTEGER)                      TO service_role;
GRANT EXECUTE ON FUNCTION get_thought_connections(UUID, INTEGER, BOOLEAN)     TO service_role;

-- ── 7. Backfill defaults for existing rows ─────────────────────────────────
-- Sets sensible defaults on rows that predate the new columns.
-- Runs once; subsequent inserts will use the column defaults.

UPDATE thoughts SET type            = 'idea'     WHERE type            IS NULL;
UPDATE thoughts SET sensitivity_tier = 'standard' WHERE sensitivity_tier IS NULL;
UPDATE thoughts SET importance      = 3          WHERE importance      IS NULL;
UPDATE thoughts SET quality_score   = 50         WHERE quality_score   IS NULL;
UPDATE thoughts SET source_type     = ''         WHERE source_type     IS NULL;
UPDATE thoughts SET enriched        = false      WHERE enriched        IS NULL;

-- Reload PostgREST schema cache so RPCs are immediately callable
NOTIFY pgrst, 'reload schema';
