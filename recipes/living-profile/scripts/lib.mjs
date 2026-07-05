/**
 * lib.mjs — shared contract for the Living Profile recipe.
 *
 * Vendored, self-contained copy of the fact shape, category taxonomy, page
 * slugs, and tier mapping used by seed-profile.mjs and synthesize-profile.mjs
 * in this recipe folder. No imports outside this file, so the recipe can be
 * copied into any Open Brain project without dragging in the source
 * ExoCortex tree.
 *
 * Generalized from the ExoCortex implementation
 * (scripts/profile/profile-lib.mjs): no hardcoded self-entity id, no
 * hardcoded canonical-profile-thought id — both are config the caller
 * supplies (env vars / CLI flags), documented in ../.env.example.
 *
 * No I/O in this module — pure constants and builders.
 */
import { createHash } from 'node:crypto';

export const PROFILE_SOURCE_TYPE = 'profile_fact';
export const PROFILE_GENERATOR = 'profile-synthesis';
export const PROFILE_PAGE_SLUG = 'profile';
export const PROFILE_RESTRICTED_PAGE_SLUG = 'profile-restricted';
export const PROFILE_PAGE_KIND = 'profile';

/**
 * Default category taxonomy (metadata.profile_category values). Overridable
 * via the PROFILE_CATEGORIES env var (comma-separated keys); when overridden,
 * each key gets a generic section_key/heading/order derived from the key
 * itself so custom taxonomies still render sensibly.
 */
const BUILTIN_CATEGORIES = {
  'identity-family': { section_key: 'facts-identity-family', heading: 'Identity & family', order: 110 },
  'relationships': { section_key: 'facts-relationships', heading: 'Relationships & people', order: 120 },
  'work-projects': { section_key: 'facts-work-projects', heading: 'Work & projects', order: 130 },
  'health-routines': { section_key: 'facts-health-routines', heading: 'Health & routines', order: 140 },
  'preferences-workflow': { section_key: 'facts-preferences-workflow', heading: 'Preferences & workflow', order: 150 },
  'values-beliefs': { section_key: 'facts-values-beliefs', heading: 'Values & beliefs', order: 160 },
  'skills-tools': { section_key: 'facts-skills-tools', heading: 'Skills & tools', order: 170 },
  'context-places': { section_key: 'facts-context-places', heading: 'Context & places', order: 180 },
};

/** Title-case a hyphenated category key for a fallback heading (e.g. "side-projects" -> "Side projects"). */
function titleCaseFromKey(key) {
  const words = String(key).split(/[-_]+/).filter(Boolean);
  if (words.length === 0) return String(key);
  return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ');
}

/**
 * Build the category taxonomy from an optional comma-separated override
 * (PROFILE_CATEGORIES env var). Falls back to the built-in eight. Custom
 * categories get section_key=`facts-${key}`, a title-cased heading, and an
 * order assigned by position (110, 120, 130, ...) so section display order
 * stays deterministic regardless of how many categories are configured.
 */
export function buildCategories(overrideCsv) {
  const keys = String(overrideCsv ?? '').trim()
    ? String(overrideCsv).split(',').map((s) => s.trim()).filter(Boolean)
    : Object.keys(BUILTIN_CATEGORIES);
  const categories = {};
  keys.forEach((key, i) => {
    categories[key] = BUILTIN_CATEGORIES[key] ?? {
      section_key: `facts-${key}`,
      heading: titleCaseFromKey(key),
      order: 110 + i * 10,
    };
  });
  return categories;
}

export const PROFILE_CATEGORIES = buildCategories(process.env.PROFILE_CATEGORIES);
export const CATEGORY_KEYS = Object.keys(PROFILE_CATEGORIES);
export const SUMMARY_SECTION = { section_key: 'summary', heading: 'Summary', order: 100 };

export const FACT_STATUSES = ['active', 'superseded', 'retired'];
export const ORIGIN_STREAMS = ['distilled', 'omi_memory', 'seed-canonical-profile', 'manual'];

/** Thought sensitivity tiers, ranked; and the wiki-page vocabulary mapping. */
const TIER_RANK = { standard: 0, personal: 1, restricted: 2 };
export function maxTier(tiers) {
  let best = 'standard';
  for (const t of tiers) {
    // FAIL CLOSED: any tier value we don't recognize is treated as 'restricted'.
    // The thoughts.sensitivity_tier column has (on baseline OB1 and most
    // schema variants) no CHECK constraint, so non-canonical values (typos,
    // legacy imports, a different vocabulary entirely) can exist. This
    // function guards a privacy containment boundary — a fact's computed
    // tier decides whether it may render on the open profile page — so
    // over-restriction is the acceptable failure mode. This is deliberately
    // stricter than a display-default normalizer would be: this decides what
    // may leak onto a lower-tier page, not just how to label an unknown tier.
    const tier = Object.prototype.hasOwnProperty.call(TIER_RANK, t) ? t : 'restricted';
    if (TIER_RANK[tier] > TIER_RANK[best]) best = tier;
  }
  return best;
}
/** thoughts vocabulary (standard/personal/restricted) → wiki_pages vocabulary (standard/sensitive/restricted). */
export function pageTierForThoughtTier(tier) {
  if (tier === 'restricted') return 'restricted';
  if (tier === 'personal') return 'sensitive';
  return 'standard';
}

/** Identity of a fact = its normalized statement (salted so it can't collide with a raw thought). */
export function factFingerprint(statement) {
  const normalized = String(statement ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized) throw new Error('factFingerprint: empty statement');
  return createHash('sha256').update(`${PROFILE_SOURCE_TYPE}|${normalized}`).digest('hex');
}

/**
 * Build the metadata block for a profile_fact thought. Validates at the
 * boundary: category must be known, evidence required for machine-distilled
 * facts, confidence clamped to [0,1].
 *
 * Baseline-OB1 note: `thoughts` has no dedicated `superseded_by` column, so
 * supersession is tracked ENTIRELY in this metadata block
 * (fact_status + superseded_by_id + superseded_at). If your schema does add
 * a `superseded_by` column later, this metadata still doubles as an audit
 * trail — nothing here needs to change.
 */
export function factMetadata({ category, slot = null, confidence, evidenceThoughtIds, originStream, extra = {} }) {
  if (!PROFILE_CATEGORIES[category]) {
    throw new Error(`factMetadata: unknown profile_category "${category}" (expected one of ${CATEGORY_KEYS.join(', ')})`);
  }
  if (!ORIGIN_STREAMS.includes(originStream)) {
    throw new Error(`factMetadata: unknown origin_stream "${originStream}"`);
  }
  const evidence = Array.isArray(evidenceThoughtIds) ? evidenceThoughtIds.filter((n) => Number.isInteger(n) && n > 0) : [];
  if (evidence.length === 0 && originStream !== 'manual') {
    throw new Error('factMetadata: evidence_thought_ids required for machine-generated facts');
  }
  const conf = Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5;
  return {
    generated_by: PROFILE_GENERATOR,
    profile_category: category,
    ...(slot ? { slot: String(slot).toLowerCase() } : {}),
    confidence: conf,
    evidence_thought_ids: evidence,
    fact_status: 'active',
    human_edited: false,
    origin_stream: originStream,
    ...extra,
  };
}

/**
 * Assemble the full `thoughts` INSERT row for one profile fact. The ONE
 * place the row shape lives — both writers (seed-profile.mjs and
 * synthesize-profile.mjs) call this, so importance/quality_score/tier rules
 * cannot drift between them.
 *
 * Rules:
 *   importance     — 5 for identity-core facts (first configured category,
 *                    "identity-family" by default), else 4
 *   quality_score  — round(confidence x 100), so search ranking tracks how
 *                    directly the evidence supports the statement
 *   sensitivity_tier / created_at — passthrough, only set when provided
 *                    (omit -> DB defaults apply)
 */
export function factRow({
  statement, category, slot = null, confidence, evidenceThoughtIds, originStream,
  sensitivityTier = null, createdAt = null, extra = {},
}) {
  const metadata = factMetadata({ category, slot, confidence, evidenceThoughtIds, originStream, extra });
  const identityCoreCategory = CATEGORY_KEYS[0] ?? 'identity-family';
  const row = {
    content: String(statement ?? '').trim(),
    content_fingerprint: factFingerprint(statement),
    type: 'person_note',
    source_type: PROFILE_SOURCE_TYPE,
    importance: category === identityCoreCategory ? 5 : 4,
    quality_score: Math.round((metadata.confidence ?? 0.5) * 100),
    metadata,
  };
  if (sensitivityTier) row.sensitivity_tier = sensitivityTier;
  if (createdAt) row.created_at = createdAt;
  return row;
}

/** Slot dedup is scoped to the fact's own category (a health 'diet' fact
 *  must never retire a work 'diet' fact in a different category). */
export function slotKeyFor(category, slot) {
  return `${category}|${String(slot).toLowerCase()}`;
}
