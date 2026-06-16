/**
 * wearable-limitless-capture — Limitless Pendant adapter for wearable-capture-core.
 *
 * Polls the Limitless lifelog API for recent recordings and maps each one to a
 * single `meeting` thought, using the device's OWN structure (title + section
 * headings) — no LLM call. The shared engine (`_shared/wearable-sync.ts`) owns
 * dedup, embedding, and the insert into `thoughts`.
 *
 * Deploy to `supabase/functions/wearable-limitless-capture/index.ts`.
 * Requires the wearable-capture-core engine at `_shared/wearable-sync.ts`.
 */
import { runWearableSync, type WearableAdapter, type WearableThought } from "../_shared/wearable-sync.ts";

const LIMITLESS_BASE = "https://api.limitless.ai/v1";

/** Shape of a single lifelog as returned by the Limitless API (only the fields we read). */
interface Lifelog {
  id: string;
  title?: string;
  markdown?: string;
  startTime?: string;
  endTime?: string;
}

/** Safety caps so a wide window or a runaway cursor can't fetch unbounded pages. */
const MAX_RECORDS = 500;
const MAX_PAGES = 30;

/**
 * Pull lifelogs created at/after `sinceISO`, paging forward (ascending) by
 * following `meta.lifelogs.nextCursor` until it's empty, a page is empty, or a
 * cap is hit.
 */
async function listSince(sinceISO: string): Promise<Lifelog[]> {
  const apiKey = Deno.env.get("LIMITLESS_API_KEY");
  if (!apiKey) throw new Error("LIMITLESS_API_KEY is required");

  const out: Lifelog[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      start: sinceISO,
      timezone: "UTC",
      limit: "50",
      direction: "asc",
      includeMarkdown: "true",
      includeHeadings: "true",
    });
    if (cursor) params.set("cursor", cursor);

    const r = await fetch(`${LIMITLESS_BASE}/lifelogs?${params.toString()}`, {
      headers: { "X-API-Key": apiKey },
    });
    if (!r.ok) {
      throw new Error(`Limitless lifelogs ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }

    const body = await r.json();
    const lifelogs: Lifelog[] = body?.data?.lifelogs ?? [];
    if (lifelogs.length === 0) break;

    out.push(...lifelogs);
    if (out.length >= MAX_RECORDS) return out.slice(0, MAX_RECORDS);

    cursor = body?.meta?.lifelogs?.nextCursor ?? undefined;
    if (!cursor) break;
  }

  return out;
}

/** Pull section headings from the lifelog markdown: lines like `## Heading` or `### Heading`. */
function extractHeadings(markdown: string): string[] {
  const headings: string[] = [];
  for (const line of markdown.split("\n")) {
    const m = line.match(/^##{1,2}\s+(.*)$/);
    if (m) {
      const text = m[1].trim();
      if (text) headings.push(text);
    }
  }
  return headings;
}

/** Fallback body: stitch transcript bullet lines, stripping `- ` and any `(timestamp):` prefix. */
function transcriptSnippet(markdown: string): string {
  const parts: string[] = [];
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("- ")) continue;
    const text = trimmed
      .slice(2)
      .replace(/^\([^)]*\):\s*/, "")
      .trim();
    if (text) parts.push(text);
  }
  return parts.join(" ").slice(0, 400);
}

/** Map one lifelog to a single `meeting` thought from the device's own structure (no LLM). */
function recordToThoughts(ll: Lifelog): WearableThought[] {
  const title = (ll.title ?? "Lifelog").trim();
  const markdown = ll.markdown ?? "";

  const headings = extractHeadings(markdown);
  const body = headings.length > 0 ? headings.join("; ") : transcriptSnippet(markdown);

  const content = body ? `${title} — ${body}` : title;

  return [{
    content,
    type: "meeting",
    metadata: {
      limitless_lifelog_id: ll.id,
      title,
      started_at: ll.startTime,
      finished_at: ll.endTime,
    },
    createdAt: ll.startTime,
  }];
}

const limitlessAdapter: WearableAdapter<Lifelog> = {
  sourceId: "limitless",
  sourceType: "limitless_lifelog",
  listSince,
  recordId: (ll) => ll.id,
  recordToThoughts,
};

Deno.serve(async (): Promise<Response> => {
  try {
    const result = await runWearableSync(limitlessAdapter, { sinceHours: 12 });
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[wearable-limitless-capture]", (err as Error).message);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
