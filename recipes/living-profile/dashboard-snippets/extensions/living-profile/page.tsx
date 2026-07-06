import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getWikiPage, ApiError } from "@/lib/api";
import { getSession, requireSessionOrRedirect } from "@/lib/auth";
import type { ExtensionPageProps } from "@/lib/extensions/types";
import type { WikiPageDetail, WikiSection } from "@/lib/types";

/**
 * Living Profile dashboard extension — an Omi-Memories-style view over the
 * `profile_fact` thought stream and the `profile` / `profile-restricted`
 * wiki pages written by `../scripts/synthesize-profile.mjs`.
 *
 * This snippet targets a dashboard that follows the extension-slot pattern
 * documented in `recipes/wiki-synthesis/` and the open-brain-dashboard
 * project: an `Extension` object (manifest + Page component) registered
 * under a URL slug, reading through the dashboard's existing wiki REST
 * client (`getWikiPage`). Adjust the `@/lib/*` import paths to match your
 * dashboard's actual module aliases if they differ.
 *
 * Requires the wiki_pages schema tier (see the recipe README's "Schema
 * tiers" section). On baseline OB1 without wiki_pages, the synthesis loop
 * writes a single canonical profile thought instead — query that directly
 * (see the README's PostgREST example) rather than using this page, or adapt
 * this component to render a plain thought instead of a WikiPageDetail.
 *
 * Slugs and section-key/heading pairs mirrored from `../../scripts/lib.mjs`
 * (source of truth — this file is dashboard code and cannot import a
 * `scripts/*.mjs` module across the recipe boundary). Keep in sync by hand;
 * lib.mjs is the single place that actually generates these values. If you
 * changed PROFILE_CATEGORIES via env, update CATEGORY_SECTION_HEADINGS below
 * to match, or leave it — unrecognized section keys fall back to the
 * section's own `heading` from the API response.
 */
const PROFILE_PAGE_SLUG = "profile";
const PROFILE_RESTRICTED_PAGE_SLUG = "profile-restricted";
const SUMMARY_SECTION_KEY = "summary";

/** section_key -> heading, in display order. Mirrors the built-in taxonomy in lib.mjs. */
const CATEGORY_SECTION_HEADINGS: Record<string, string> = {
  "facts-identity-family": "Identity & family",
  "facts-relationships": "Relationships & people",
  "facts-work-projects": "Work & projects",
  "facts-health-routines": "Health & routines",
  "facts-preferences-workflow": "Preferences & workflow",
  "facts-values-beliefs": "Values & beliefs",
  "facts-skills-tools": "Skills & tools",
  "facts-context-places": "Context & places",
};

function isFactsSection(section: WikiSection): boolean {
  return section.section_key.startsWith("facts-");
}

function categoryHeading(section: WikiSection): string {
  return CATEGORY_SECTION_HEADINGS[section.section_key] ?? section.heading ?? section.section_key;
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Union of evidence_thought_ids across a set of sections, deduplicated. */
function citedFactCount(sections: WikiSection[]): number {
  const ids = new Set<number>();
  for (const section of sections) {
    for (const id of section.evidence_thought_ids ?? []) ids.add(id);
  }
  return ids.size;
}

function EvidenceLinks({ ids }: { ids: number[] }) {
  if (!ids || ids.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {ids.map((id, idx) => (
        <span key={id}>
          <Link
            href={`/thoughts/${id}`}
            className="text-violet hover:underline"
            title={`Source thought #${id}`}
          >
            #{id}
          </Link>
          {idx < ids.length - 1 ? <span className="text-text-muted">,</span> : null}
        </span>
      ))}
    </span>
  );
}

function PendingDraftNotice({ page, section }: { page: string; section: WikiSection }) {
  if (!section.pending_generated_md) return null;
  return (
    <div className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300">
      A machine update to this section is waiting for review.{" "}
      <Link href={`/wiki/${page}`} className="underline hover:text-amber-200">
        Accept or dismiss it on the wiki page
      </Link>
      {section.pending_generated_at && (
        <span className="text-amber-300/70"> (drafted {section.pending_generated_at.slice(0, 10)})</span>
      )}
      .
    </div>
  );
}

function FactSectionCard({
  section,
  page,
}: {
  section: WikiSection;
  page: string;
}) {
  const heading = categoryHeading(section);
  const factCount = section.evidence_thought_ids?.length ?? 0;
  return (
    <div className="bg-bg-surface border border-border rounded-lg p-4 space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-text-primary">{heading}</h3>
        <span className="text-[10px] text-text-muted shrink-0">
          {factCount} cited fact{factCount === 1 ? "" : "s"}
        </span>
      </div>
      {section.body_md.trim() ? (
        <div className="prose prose-invert prose-sm max-w-none prose-headings:text-text-primary prose-p:text-text-secondary prose-p:leading-relaxed prose-li:text-text-secondary prose-a:text-violet prose-strong:text-text-primary">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{section.body_md}</ReactMarkdown>
        </div>
      ) : (
        <p className="text-xs text-text-muted italic">No facts recorded in this category yet.</p>
      )}
      <PendingDraftNotice page={page} section={section} />
    </div>
  );
}

function SummaryProse({ section }: { section: WikiSection | undefined; page: string }) {
  if (!section || !section.body_md.trim()) return null;
  return (
    <div className="bg-bg-surface border border-border rounded-lg p-4 space-y-2">
      <div className="prose prose-invert prose-sm max-w-none prose-headings:text-text-primary prose-p:text-text-secondary prose-p:leading-relaxed prose-a:text-violet prose-strong:text-text-primary">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{section.body_md}</ReactMarkdown>
      </div>
      <PendingDraftNotice page="profile" section={section} />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="bg-bg-surface border border-border rounded-lg p-6 space-y-3">
      <h2 className="text-sm font-semibold text-text-primary">No profile yet</h2>
      <p className="text-sm text-text-secondary">
        The daily synthesis loop hasn&apos;t run, so there&apos;s no{" "}
        <code className="px-1 py-0.5 text-xs bg-bg-hover rounded">profile</code> wiki page to show.
        Once it runs, this page fills in automatically — nothing to do here.
      </p>
      <p className="text-xs text-text-muted">
        Run <code className="px-1 py-0.5 text-xs bg-bg-hover rounded">node scripts/seed-profile.mjs</code>{" "}
        followed by <code className="px-1 py-0.5 text-xs bg-bg-hover rounded">node scripts/synthesize-profile.mjs</code>{" "}
        (see the recipe README) to populate it.
      </p>
    </div>
  );
}

async function loadProfilePage(slug: string): Promise<WikiPageDetail | null> {
  const { apiKey } = await requireSessionOrRedirect();
  try {
    return await getWikiPage(apiKey, slug);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    // Unexpected error — surface it rather than silently degrading to "no profile"
    throw err;
  }
}

/**
 * /extensions/living-profile — Omi-Memories-style view of the Living Profile.
 *
 * Reads two wiki pages via the existing wiki REST client
 * (`getWikiPage`, `GET /wiki/pages/:slug`): `profile` (standard/sensitive
 * facts) and, only when the session has unlocked restricted content,
 * `profile-restricted`. No new endpoints, no writes — editing happens on
 * `/wiki/profile` (and `/wiki/profile-restricted`), which already has the
 * Accept/Dismiss pending-draft flow this page links out to.
 */
export async function LivingProfilePage(_props: ExtensionPageProps) {
  void _props;

  const [page, session] = await Promise.all([
    loadProfilePage(PROFILE_PAGE_SLUG),
    getSession(),
  ]);

  if (!page) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-text-primary">Profile</h1>
          <p className="mt-1 text-sm text-text-secondary">
            What the brain knows about you, one fact at a time, every claim linked to its source.
          </p>
        </div>
        <EmptyState />
      </div>
    );
  }

  const restrictedUnlocked = session.restrictedUnlocked === true;
  const restrictedPage = restrictedUnlocked ? await loadProfilePage(PROFILE_RESTRICTED_PAGE_SLUG) : null;

  const summarySection = page.sections.find((s) => s.section_key === SUMMARY_SECTION_KEY);
  const factSections = page.sections.filter(isFactsSection).sort((a, b) => a.display_order - b.display_order);
  const restrictedFactSections = (restrictedPage?.sections ?? [])
    .filter(isFactsSection)
    .sort((a, b) => a.display_order - b.display_order);

  const totalCitedFacts = citedFactCount([...page.sections, ...(restrictedPage?.sections ?? [])]);
  const lastSynthesizedAt =
    restrictedPage && restrictedPage.page.updated_at > page.page.updated_at
      ? restrictedPage.page.updated_at
      : page.page.updated_at;

  const hasAnyFacts = factSections.some((s) => s.body_md.trim()) || restrictedFactSections.some((s) => s.body_md.trim());

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-text-primary">{page.page.title}</h1>
          <p className="mt-1 text-sm text-text-secondary">
            {page.sections.length + (restrictedPage?.sections.length ?? 0)} section
            {page.sections.length + (restrictedPage?.sections.length ?? 0) === 1 ? "" : "s"} ·{" "}
            {totalCitedFacts} cited fact{totalCitedFacts === 1 ? "" : "s"} · last synthesized{" "}
            {formatTimestamp(lastSynthesizedAt)}
          </p>
        </div>
        <Link
          href={`/wiki/${PROFILE_PAGE_SLUG}`}
          className="inline-flex w-fit items-center rounded border border-violet/40 bg-violet-surface px-3 py-1.5 text-xs text-violet hover:bg-violet/20 transition-colors"
        >
          Edit on wiki page
        </Link>
      </div>

      {!hasAnyFacts && (
        <p className="text-xs text-text-muted italic">
          The profile page exists but has no facts yet — the synthesis loop seeds this over its first
          few runs.
        </p>
      )}

      {/* Prose header */}
      <SummaryProse section={summarySection} page={PROFILE_PAGE_SLUG} />

      {/* Category chips */}
      {factSections.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {factSections.map((section) => {
            const count = section.evidence_thought_ids?.length ?? 0;
            return (
              <span
                key={section.id}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-bg-hover px-2.5 py-1 text-[11px] text-text-secondary"
              >
                {categoryHeading(section)}
                <span className="text-text-muted">{count}</span>
              </span>
            );
          })}
        </div>
      )}

      {/* Fact cards, one per category */}
      <div className="grid gap-4 md:grid-cols-2">
        {factSections.map((section) => (
          <FactSectionCard key={section.id} section={section} page={PROFILE_PAGE_SLUG} />
        ))}
      </div>

      {/* Evidence index — quick citation lookup */}
      {factSections.some((s) => (s.evidence_thought_ids?.length ?? 0) > 0) && (
        <details className="text-xs">
          <summary className="cursor-pointer text-text-muted hover:text-text-secondary select-none">
            All cited source thoughts
          </summary>
          <div className="mt-2 flex flex-wrap gap-x-1 gap-y-1">
            {factSections.map((section) => (
              <EvidenceLinks key={section.id} ids={section.evidence_thought_ids ?? []} />
            ))}
          </div>
        </details>
      )}

      {/* Restricted block — only rendered when unlocked */}
      {restrictedUnlocked && (
        <div className="space-y-3 border-t border-border pt-6">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-text-primary">Restricted facts</h2>
            <span className="inline-flex items-center rounded border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 text-[10px] text-rose-300">
              restricted — unlocked this session
            </span>
          </div>
          {!restrictedPage ? (
            <p className="text-xs text-text-muted italic">
              No <code className="px-1 py-0.5 bg-bg-hover rounded">{PROFILE_RESTRICTED_PAGE_SLUG}</code> page
              yet — restricted facts appear here once the loop writes some.
            </p>
          ) : restrictedFactSections.length === 0 ? (
            <p className="text-xs text-text-muted italic">No restricted facts recorded yet.</p>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {restrictedFactSections.map((section) => (
                <FactSectionCard key={section.id} section={section} page={PROFILE_RESTRICTED_PAGE_SLUG} />
              ))}
            </div>
          )}
        </div>
      )}
      {!restrictedUnlocked && (
        <p className="text-[11px] text-text-muted italic border-t border-border pt-4">
          Restricted facts are hidden. Unlock restricted content to see them.
        </p>
      )}
    </div>
  );
}
