# Living Profile — dashboard snippets

Optional. Copy `extensions/living-profile/` into your Open Brain dashboard if
it uses the extension-slot pattern: a directory per feature under
`extensions/<slug>/`, each exporting an `Extension` object (`manifest` +
`Page` component) from `index.ts`, discovered by a build-time codegen script
that scans the directory and registers it in the sidebar. This is the same
pattern `recipes/wiki-synthesis/` and the `open-brain-dashboard` project
document.

If your dashboard doesn't have an extension-slot system, treat this folder
as a worked example instead: `page.tsx` shows how to render a wiki page (or,
if you're on baseline OB1 without `wiki_pages`, how you'd adapt it to render
a plain canonical thought) into category cards with evidence links, and you
can lift the rendering logic into whatever page-composition approach your
dashboard uses.

## Files

- `extensions/living-profile/manifest.ts` — the extension's slug, label, and
  sidebar icon.
- `extensions/living-profile/page.tsx` — the actual view: header, prose
  summary, category cards with confidence + evidence links, and a restricted
  block gated on `session.restrictedUnlocked`.
- `extensions/living-profile/index.ts` — wires `manifest` + `Page` into the
  `Extension` shape your dashboard's registry expects.
- `extensions/living-profile/icon.tsx` — a small inline SVG sidebar icon.

## Adapting these files

1. **Import paths.** `page.tsx` imports `getWikiPage`/`ApiError` from
   `@/lib/api`, `getSession`/`requireSessionOrRedirect` from `@/lib/auth`,
   and shared types from `@/lib/types` and `@/lib/extensions/types`. Point
   these at wherever your dashboard keeps its wiki REST client, session
   helper, and shared types — the module names are illustrative, not a
   contract.
2. **Styling.** The snippet assumes Tailwind CSS with theme tokens like
   `bg-bg-surface`, `text-text-primary`, `border-violet/40`. Swap these for
   whatever your dashboard's design system uses, or strip the classes
   entirely and restyle from scratch.
3. **Auth.** `requireSessionOrRedirect()` and `session.restrictedUnlocked`
   are placeholders for however your dashboard gates personal content. Wire
   in your own auth check before surfacing anything here — this snippet
   assumes an authenticated session already exists.
4. **Schema tier.** This page reads two **wiki pages** (`profile` and
   `profile-restricted`) via `getWikiPage`. That only works if you're on the
   `wiki_pages` schema tier (see the main recipe README's "Schema tiers"
   section). On baseline OB1, `synthesize-profile.mjs` writes a single
   canonical profile thought instead — this component won't find anything to
   render. Either install the `wiki_pages` schema, or adapt `page.tsx` to
   fetch and render that one thought directly (a single `GET
   /rest/v1/thoughts?source_type=eq.profile_fact_canonical` call, no wiki
   client needed).
5. **Slug.** The manifest registers this extension at slug `living-profile`
   (URL `/extensions/living-profile`). Rename it if that collides with
   something else in your dashboard.

## What this does NOT do

No writes, no new API routes. Every read goes through the wiki client your
dashboard already has (`getWikiPage`). Editing a section or resolving a
pending machine-generated draft happens on the wiki page itself
(`/wiki/profile`), which this extension links out to rather than duplicating.
A "synthesize now" button that triggers `synthesize-profile.mjs` from the UI
is a reasonable follow-up, but isn't included here — it needs a server
action wired to a subprocess call plus the concurrency lock the script
already ships (see `PROFILE_STATE_FILE` / the lockfile notes in
`synthesize-profile.mjs`), and should be built against your own dashboard's
server-action conventions rather than guessed at generically.
