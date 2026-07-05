# Living Profile

> Build a self-updating, per-fact user profile from everything in your Open Brain, with source citations and supersession, in the style of Omi's Memories tab but for your whole brain, not just one device.

## What It Does

Omi's app has a Memories screen: a running list of small, individually-listed facts about you ("prefers async communication," "allergic to shellfish"), each one traceable back to a conversation. It's a good idea, but it only sees what one pendant heard.

This recipe rebuilds that pattern against your whole Open Brain (chats, journals, wearable transcripts, imported documents, whatever you've captured) and adds two things Omi's version doesn't have. **Citations**: every fact points at the thought IDs it was drawn from. **Supersession**: when a new fact contradicts or updates an old one, the old one is marked replaced instead of silently duplicated or left to rot.

Concretely, it gives you:

1. A **facts layer**: one thought per durable fact, each tagged with a category, a confidence score, and links back to its source evidence.
2. A **profile page**: a wiki page whose sections regenerate from the active facts, a short prose summary plus one list per category, every line citing its evidence. (On a schema without `wiki_pages`, this becomes a single canonical thought instead — see "Schema tiers" below.)
3. A **daily loop**: a scheduled script that reads new brain activity, distills candidate facts, reconciles them against what's already there (dedup, supersede, or merge), and re-renders the page. It never overwrites something you edited by hand.

## How It Compares to Other OB1 Wiki Recipes

| Recipe | Scope | Schema prerequisites |
| ------ | ----- | -------------------- |
| `recipes/entity-wiki/` | One page per entity (person/project/topic/org/tool/place), pages about *others* | Requires entity-extraction schema + worker |
| `recipes/wiki-synthesis/` | Narrative prose synthesized per topic slice (e.g., an autobiography by year) or per email thread | Core `thoughts` table only, or `thought_edges` for thread mode |
| `recipes/living-profile/` (this recipe) | Per-fact profile about *you*, the brain's owner: structured facts, not prose, each with its own citation and lifecycle | Core `thoughts` table only; upgrades automatically if you have `wiki_pages` |

Use this recipe when you want a queryable "what does my brain know about me" view instead of a narrative essay, and when you want each individual claim to carry its own confidence and provenance rather than one page-level citation list.

## Prerequisites

- Working Open Brain setup ([guide](../../docs/01-getting-started.md))
- Node.js 18+ (uses built-in `fetch`)
- API key for any OpenAI-compatible Chat Completions endpoint (OpenRouter, OpenAI, Anthropic via OpenRouter, a local Ollama/LM Studio server, etc.)
- An OpenAI API key for embeddings (`text-embedding-3-small`) — used by the daily loop's dedup step, independent of whichever chat-completions provider you pick above
- Your Supabase project URL and service role key

### Schema tiers (this recipe degrades gracefully)

The synthesis logic is the same at every tier. What changes is where facts and pages land:

- **Baseline OB1** (just the core `thoughts` table, no `wiki_pages`): facts are written as thoughts with a distinguishing `source_type`, and supersession is tracked entirely in `metadata` (`fact_status`, `superseded_by_id`, `superseded_at`) — there's no dedicated column to update either way. Rendering falls back to maintaining a single canonical profile thought that the script updates in place, one paragraph per category plus a prose summary, instead of a full wiki.
- **With `wiki_pages` / `wiki_sections`** (see `recipes/entity-wiki/` or the Knowledge Graph schema for how these get installed): the script detects the `wiki_upsert_page` RPC on its first write and, from then on, maintains a real wiki page with one section per category, using the existing generated/manual origin split so your hand edits are respected. Restricted-tier facts land on a second page (`profile-restricted`) instead of the general one.
- **With `thought_edges`**: `derived_from` and `supersedes` edges are written alongside the metadata fields, so a graph-traversal view of provenance and supersession is available too. Without it, everything still works — the edge writes 404 once, log a single warning, and the metadata fields remain the full source of truth.

## Credential Tracker

```text
LIVING-PROFILE -- CREDENTIAL TRACKER
--------------------------------------

FROM YOUR OPEN BRAIN SETUP
  OPEN_BRAIN_URL:           ____________   (https://<ref>.supabase.co)
  OPEN_BRAIN_SERVICE_KEY:   ____________   (Supabase service role key)

LLM PROVIDER (distillation, adjudication, summary prose)
  LLM_BASE_URL:             ____________   (default: https://openrouter.ai/api/v1)
  LLM_API_KEY:              ____________
  LLM_MODEL:                ____________   (default: anthropic/claude-haiku-4-5)

EMBEDDINGS (near-duplicate detection in the daily loop)
  OPENAI_API_KEY:           ____________   (required for synthesize-profile.mjs live runs)

SUBJECT IDENTITY
  SUBJECT_NAME:             ____________   (your name, used in the profile header and LLM prompts)
  SELF_LABELS:              ____________   (comma-separated names/aliases the synthesizer treats as "you" in wearable transcripts, e.g. "Alan,Alan Shurafa")
  SELF_ENTITY_ID:           ____________   (optional: your row id in `entities`, if you run the Knowledge Graph schema; leave blank otherwise)
  CANONICAL_PROFILE_THOUGHT_ID: ________   (optional: an existing bio/profile thought id to seed from via --from-canonical)

OPTIONAL
  PROFILE_CATEGORIES:       ____________   (default: identity-family,relationships,work-projects,health-routines,preferences-workflow,values-beliefs,skills-tools,context-places)
  PROFILE_RUN_CAP:          ____________   (default: 300, max candidate thoughts scanned per run)

--------------------------------------
```

## Steps

### 1. Copy the scripts into your Open Brain project

```bash
mkdir -p scripts/living-profile
cp recipes/living-profile/scripts/*.mjs scripts/living-profile/
```

Keep `lib.mjs` alongside the other two — `seed-profile.mjs` and `synthesize-profile.mjs` both import it for the fact shape, category taxonomy, and fingerprinting.

✅ **Done when:** `scripts/living-profile/lib.mjs`, `seed-profile.mjs`, and `synthesize-profile.mjs` all exist side by side.

### 2. Create a `.env.local` at your project root

The scripts read from `./.env.local` relative to their current working directory, then fall back to `process.env` (`process.env` wins if a key is set in both). Fill in the tracker values from above:

```text
OPEN_BRAIN_URL=https://YOUR_REF.supabase.co
OPEN_BRAIN_SERVICE_KEY=YOUR_SERVICE_ROLE_KEY
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_API_KEY=YOUR_OPENROUTER_KEY
LLM_MODEL=anthropic/claude-haiku-4-5
OPENAI_API_KEY=YOUR_OPENAI_KEY
SUBJECT_NAME=YourFirstName
SELF_LABELS=YourFirstName,Your Full Name
```

✅ **Done when:** `.env.local` exists, is filled in, and is excluded from version control (check your `.gitignore`).

> [!IMPORTANT]
> The service role key has full write access to your database. Keep `.env.local` out of version control and never commit real keys.

### 3. Seed the profile from existing facts (one-time)

Run from wherever you copied the scripts (so `.env.local` and `data/` land next to them):

```bash
node scripts/living-profile/seed-profile.mjs --from-canonical --thought-id=12345
```

Replace `12345` with the id of an existing single-blob bio/profile thought in your brain (or set `CANONICAL_PROFILE_THOUGHT_ID` in `.env.local` instead of passing `--thought-id`). Dry-run is the default — this costs one LLM call and writes nothing.

If you've run a wearable-capture recipe that produces a `source_type='omi_memory'` stream, seed from that instead (or in addition — the two modes are independent, run either or both):

```bash
node scripts/living-profile/seed-profile.mjs --from-omi-memories
```

✅ **Done when:** the dry-run output shows a reasonable first batch of facts (a few dozen, not thousands) grouped by category, with no category showing 0 facts if you have relevant thoughts in your brain.

Run it for real once the dry-run output looks right:

```bash
node scripts/living-profile/seed-profile.mjs --from-canonical --thought-id=12345 --live
```

### 4. Run the daily synthesis loop

```bash
node scripts/living-profile/synthesize-profile.mjs --dry-run
```

Then for real:

```bash
node scripts/living-profile/synthesize-profile.mjs
```

This is the incremental loop: it reads thoughts created since the last run, distills candidate facts, reconciles them against what's active (drop exact duplicates, supersede same-slot facts, merge near-duplicates), writes the new facts, and re-renders the profile page or canonical thought. It's meant to run daily via cron or Task Scheduler, not on every capture — durable facts don't change hour to hour, and each run costs at least one embedding call plus a handful of chat-completions calls.

✅ **Done when:** a second run over the same window makes no changes (idempotent — check the printed summary shows `facts new: 0`), and a run over a window with genuinely new information about you produces new or superseded facts, not duplicates.

Useful flags:

```bash
node scripts/living-profile/synthesize-profile.mjs --max 100          # cap candidates this run (default: 300, or PROFILE_RUN_CAP)
node scripts/living-profile/synthesize-profile.mjs --since 2026-01-01T00:00:00Z   # override the persisted watermark
```

### 5. Schedule it

Add a daily cron entry or Task Scheduler job that runs `node scripts/living-profile/synthesize-profile.mjs` from your project root (so `.env.local` and `data/` resolve correctly). Once a day is plenty — durable facts change slowly, and a day of latency between something happening and it showing up on your profile is fine.

✅ **Done when:** the job has run at least once unattended and the state file (`data/profile-synthesis-state.json`, next to wherever you run the script from) shows an advancing watermark.

### 6. (Optional) Wire it into a dashboard

If you run a Next.js-based Open Brain dashboard with an extension-slot system, [`dashboard-snippets/`](./dashboard-snippets/) carries an extension styled like Omi's Memories tab: a header with your name and fact count, category chips, and a fact list with evidence links. See [`dashboard-snippets/README.md`](./dashboard-snippets/README.md) for what to adapt (import paths, styling tokens, auth).

Until you wire that up, or if you're on the baseline-OB1 canonical-thought fallback, the facts are queryable directly:

```bash
curl -H "apikey: $OPEN_BRAIN_SERVICE_KEY" \
     -H "Authorization: Bearer $OPEN_BRAIN_SERVICE_KEY" \
     "$OPEN_BRAIN_URL/rest/v1/thoughts?source_type=eq.profile_fact&select=id,content,metadata&limit=20"
```

## Expected Outcome

**After a successful seed + first synthesis run:**

- A set of `profile_fact` thoughts, each with `metadata.profile_category`, `metadata.confidence`, and `metadata.evidence_thought_ids` pointing at the source thoughts it was drawn from.
- Either a wiki page (slug `profile`, if you have the `wiki_pages` schema) with one section per category and a short prose summary, or a single canonical profile thought (`source_type='profile_fact_canonical'`) that gets updated in place (baseline schema).
- Facts about you that came from a private or restricted source stay on a separate, access-gated page (wiki-pages tier) or are excluded from the canonical thought (baseline tier) — they don't leak into the general-audience view.

**After the daily loop has run for a week or two:**

- New facts appear as new thoughts. Facts that got updated (say, you moved, or changed jobs) show the old fact marked superseded (`metadata.fact_status='superseded'`) and the new one active, not two contradictory rows.
- Anything you edited by hand in the wiki UI (wiki-pages tier) stays as you left it. The loop parks its own updates as a pending draft instead of overwriting a human edit.

You can query back the facts with a simple PostgREST call:

```bash
curl -H "apikey: $OPEN_BRAIN_SERVICE_KEY" \
     -H "Authorization: Bearer $OPEN_BRAIN_SERVICE_KEY" \
     "$OPEN_BRAIN_URL/rest/v1/thoughts?source_type=eq.profile_fact&metadata->>fact_status=eq.active&select=id,content,metadata&order=id.desc&limit=10"
```

## Troubleshooting

**Issue: "No thoughts found for the requested window" from the synthesis loop**
Solution: Check that you have thoughts with `created_at` values in the scanned window, and that at least some are the high-signal types the distiller looks for (person notes, decisions, lessons, journal entries) or an existing distilled-facts stream (`source_type='omi_memory'`). Run without `--since` first to confirm the eligibility query matches anything at all.

**Issue: Every run produces near-duplicate facts instead of superseding the old one**
Solution: The reconcile step matches on an exact `slot` key first (e.g., `residence`, `employer`), scoped to the fact's category — a health-routines fact can never supersede a work-projects fact even if they share a slot name. Facts without a slot fall back to embedding similarity, which is more forgiving of drift. Check whether the distillation step is populating `slot` for single-valued fact types like residence or job title.

**Issue: `wiki_upsert_page` writes fail or the loop falls back to a canonical thought unexpectedly**
Solution: The loop probes for `wiki_upsert_page` once per run and caches the result — if the probe gets a non-404 error (auth failure, malformed request unrelated to the function existing), it may misclassify availability. Check `.env.local` credentials first; a 404 specifically means the function genuinely isn't installed, which is the expected baseline-OB1 path.

**Issue: `synthesize-profile.mjs` exits immediately with "Missing env var OPENAI_API_KEY"**
Solution: The daily loop's reconcile step needs OpenAI embeddings to detect near-duplicate facts, independent of whichever LLM_* provider you configured for text generation. Set `OPENAI_API_KEY` in `.env.local`, or run with `--dry-run` if you only want to preview candidates without embedding calls.

**Issue: Facts derived from a private conversation show up on the general profile**
Solution: A fact's sensitivity should always be the maximum of its evidence thoughts' sensitivity (escalation only, never downgraded — unrecognized tier values are treated as the most restrictive tier, not the least). If you see a leak, check that the evidence thoughts actually carry the tier you expect; a fact can only be as private as the loop can tell its source was.

**Issue: The distiller extracts opinions or one-off statements instead of durable facts**
Solution: The system prompt asks the model to skip ephemeral states, tasks, and one-time events, but sparse or ambiguous source material can still slip through. Try a stronger `LLM_MODEL`, or narrow the source thought types you're feeding in until the signal-to-noise ratio improves.

**Issue: "another run holds the lock" and the script exits immediately**
Solution: A previous run is still in progress, or crashed without cleaning up its lock file (`data/profile-synthesis.lock`). Locks older than 30 minutes are treated as stale and taken over automatically on the next run — if you need to force it sooner, delete the lock file by hand once you've confirmed no other run is actually active.
