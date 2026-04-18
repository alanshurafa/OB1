// Provenance Chains — MCP tool handlers for open-brain-mcp (Supabase Edge Function).
//
// Drop these two tool registrations into your existing open-brain-mcp
// index.ts after the other registerTool() calls. Both tools assume the
// schemas/provenance-chains SQL migration has been applied to your
// Supabase project (adds the derived_from / derivation_* columns and the
// trace_provenance / find_derivatives helper functions).
//
// The snippets below match the canonical Open Brain setup where
// public.thoughts.id is a UUID. If your project has migrated thoughts to a
// BIGINT primary key, swap z.string().uuid() for z.number().int().positive()
// and update the id casts accordingly.
//
// Expected surrounding context (already present in index.ts):
//   - `server`    instance of McpServer
//   - `supabase`  createClient<...>(…, service_role_key)
//   - `z`         imported from "npm:zod@3"
//
// Return envelopes are inlined as the literal
//   { content: [{ type: "text", text: JSON.stringify(...) }] }
// shape that the canonical server/index.ts uses — no toolSuccess /
// toolFailure helper is required. Errors set `isError: true` on the
// envelope and put a plain-text explanation in the content block so
// Claude Desktop can render the failure inline.
//
// ---------------------------------------------------------------------------
// Tool 1: trace_provenance
//   Walks derived_from upward and returns the ancestor tree. Answers
//   "show me the atomic thoughts that produced this derived one."
// ---------------------------------------------------------------------------

server.registerTool(
  "trace_provenance",
  {
    title: "Trace Provenance",
    description:
      "Walk a thought's derivation chain upward — show the atomic thoughts that fed this derived thought. Returns a tree. Restricted ancestors are redacted.",
    inputSchema: z.object({
      thought_id: z.string().uuid().describe("UUID of the thought to trace"),
      depth: z.number().int().min(1).max(10).optional()
        .describe("Max ancestor levels to walk (default 3, max 10)"),
    }),
  },
  async (params) => {
    try {
      const raw = params as Record<string, unknown>;
      const rootId = String(raw.thought_id ?? "").trim();
      const maxDepth = Math.min(Math.max(1, Number(raw.depth ?? 3) || 3), 10);
      const NODE_CAP = 250;

      if (!rootId) {
        return {
          content: [{ type: "text", text: "thought_id is required" }],
          isError: true,
        };
      }

      // Call the SQL helper. It returns a flat rowset, each row is one
      // visited thought with its depth, parent_id, and cycle flag.
      const { data, error } = await supabase.rpc("trace_provenance", {
        p_thought_id: rootId,
        p_max_depth: maxDepth,
        p_node_cap: NODE_CAP,
      });

      if (error) {
        return {
          content: [{
            type: "text",
            text: `trace_provenance failed: ${error.message}`,
          }],
          isError: true,
        };
      }

      type TraceRow = {
        thought_id: string;
        depth: number;
        parent_id: string | null;
        content: string | null;
        type: string | null;
        source_type: string | null;
        derivation_method: string | null;
        derivation_layer: string | null;
        sensitivity_tier: string | null;
        created_at: string;
        cycle: boolean;
        restricted: boolean;
      };

      const rows = (data ?? []) as TraceRow[];

      // Build an in-memory tree rooted at rootId. Each node is a FRESH
      // object per traversal path (no dedupe). Cycles are detected via an
      // ancestor-path Set — when the path-to-root already contains the
      // current thought id, we emit a stub { thought_id, cycle: true } and
      // stop recursion. This is what breaks the JS object cycle and keeps
      // JSON.stringify safe; it also matches the README's advertised
      // `cycle: true` flag semantics.
      //
      // Why per-path (not global) visited: the same thought can legitimately
      // appear in multiple distinct subtrees of a DAG without it being a
      // cycle. Only an ancestor of itself is a cycle.
      type Node = {
        thought_id: string;
        depth?: number;
        cycle?: boolean;
        restricted?: boolean;
        type?: string | null;
        source_type?: string | null;
        derivation_method?: string | null;
        derivation_layer?: string | null;
        created_at?: string;
        content_preview?: string | null;
        parents?: Node[];
      };

      // Index rows by child -> list of parent rows so we can walk upward.
      // Row shape: one row per visited (child, parent) edge, plus one row
      // for the root itself (parent_id = null).
      const rowsById = new Map<string, TraceRow>();
      const parentIdsByChild = new Map<string, string[]>();
      for (const r of rows) {
        // Keep the first row we see for each thought_id as the canonical
        // metadata carrier (depth, type, etc.). Later rows differ only in
        // the edge's parent_id field.
        if (!rowsById.has(r.thought_id)) rowsById.set(r.thought_id, r);
        if (r.parent_id) {
          const arr = parentIdsByChild.get(r.thought_id) ?? [];
          if (!arr.includes(r.parent_id)) arr.push(r.parent_id);
          parentIdsByChild.set(r.thought_id, arr);
        }
      }

      if (!rowsById.has(rootId)) {
        return {
          content: [{ type: "text", text: `Thought ${rootId} not found` }],
          isError: true,
        };
      }

      function buildNode(id: string, ancestors: Set<string>): Node {
        // Ancestor-path cycle: emit a stub that references the thought but
        // does NOT recurse. This is the only place we produce
        // `{ thought_id, cycle: true }` without other fields — downstream
        // consumers and tests can distinguish stubs from fully-hydrated
        // nodes by the absence of `parents`.
        if (ancestors.has(id)) {
          return { thought_id: id, cycle: true };
        }
        const r = rowsById.get(id);
        if (!r) {
          // Referenced parent id not in the returned rowset (e.g., SQL
          // capped traversal at node_cap before reaching it). Emit a
          // minimal stub so the tree stays a tree.
          return { thought_id: id };
        }
        const nextAncestors = new Set(ancestors);
        nextAncestors.add(id);
        const parentIds = parentIdsByChild.get(id) ?? [];
        const parents = parentIds.map((pid) => buildNode(pid, nextAncestors));
        return {
          thought_id: r.thought_id,
          depth: r.depth,
          // SQL-reported cycle flag is also preserved — it may be true on
          // the row even when the ancestor-path check doesn't fire (e.g.,
          // the SQL helper detected the cycle and stopped recursion before
          // we did).
          cycle: r.cycle,
          restricted: r.restricted,
          type: r.type,
          source_type: r.source_type,
          derivation_method: r.derivation_method,
          derivation_layer: r.derivation_layer,
          created_at: r.created_at,
          // SQL already redacts restricted content to NULL; truncate rest.
          content_preview: r.content ? r.content.slice(0, 200) : null,
          parents,
        };
      }

      const root = buildNode(rootId, new Set<string>());

      const nodeCount = rowsById.size;
      const truncated = nodeCount >= NODE_CAP;
      const summary =
        `Traced provenance of ${rootId} (depth=${maxDepth}, ${nodeCount} nodes visited` +
        (truncated ? `, truncated at node_cap=${NODE_CAP}` : "") +
        `).`;

      // Return the summary line plus the full tree as pretty JSON in the
      // same text block. Claude Desktop renders this cleanly and the
      // caller can re-parse the JSON if needed.
      //
      // Belt-and-suspenders: wrap JSON.stringify in try/catch. The fresh-
      // objects + ancestor-path check above should make cycles impossible,
      // but if some future edit reintroduces a shared reference we'd
      // rather return a structured error than blow up the tool.
      let payloadText: string;
      try {
        payloadText = JSON.stringify({
          tree: root,
          node_count: nodeCount,
          depth_limit: maxDepth,
          node_cap: NODE_CAP,
          truncated,
        }, null, 2);
      } catch (stringifyErr) {
        console.error("trace_provenance: JSON.stringify failed", stringifyErr);
        return {
          content: [{
            type: "text",
            text:
              `trace_provenance: failed to serialize tree for ${rootId} ` +
              `(${String(stringifyErr)}). This usually means the provenance ` +
              `graph contains a cycle that the cycle detector missed. ` +
              `Re-run with a smaller depth or file a bug.`,
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: "text",
          text: `${summary}\n\n${payloadText}`,
        }],
      };
    } catch (error) {
      console.error("trace_provenance failed", error);
      return {
        content: [{ type: "text", text: String(error) }],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 2: find_derivatives
//   Single-level reverse lookup — "what downstream thoughts cite this one?"
// ---------------------------------------------------------------------------

server.registerTool(
  "find_derivatives",
  {
    title: "Find Derivatives",
    description:
      "Find all thoughts that were derived from this one (single-level reverse lookup). Answers 'what uses this thought?'. Restricted-tier derivatives are always hidden — there is no caller-visible override.",
    inputSchema: z.object({
      thought_id: z.string().uuid().describe("UUID of the thought whose derivatives to find"),
      limit: z.number().int().min(1).max(500).optional()
        .describe("Max rows to return (default 100, max 500)"),
    }),
  },
  async (params) => {
    try {
      const raw = params as Record<string, unknown>;
      const id = String(raw.thought_id ?? "").trim();
      const limit = Math.min(Math.max(1, Number(raw.limit ?? 100) || 100), 500);

      if (!id) {
        return {
          content: [{ type: "text", text: "thought_id is required" }],
          isError: true,
        };
      }

      // The RPC hardcodes restricted-row filtering at the SQL layer (see
      // schemas/provenance-chains/schema.sql). There is no parameter to
      // pass through — callers that want restricted rows need a separate
      // service-role-only admin path, which is out of scope here.
      const { data, error } = await supabase.rpc("find_derivatives", {
        p_thought_id: id,
        p_limit: limit,
      });

      if (error) {
        return {
          content: [{
            type: "text",
            text: `find_derivatives failed: ${error.message}`,
          }],
          isError: true,
        };
      }

      type DerivativeRow = {
        id: string;
        content: string | null;
        type: string | null;
        source_type: string | null;
        derivation_method: string | null;
        derivation_layer: string | null;
        sensitivity_tier: string | null;
        created_at: string;
      };

      const rows = (data ?? []) as DerivativeRow[];

      const summary = rows.length === 0
        ? `No derivatives found for ${id}.`
        : `Found ${rows.length} derivative(s) of ${id}:\n` +
          rows.slice(0, 10).map((r) =>
            `  ${r.id} [${r.source_type ?? "?"}] ${String(r.content ?? "").slice(0, 100)}`
          ).join("\n");

      return {
        content: [{
          type: "text",
          text: `${summary}\n\n${JSON.stringify({
            derivatives: rows,
            count: rows.length,
          }, null, 2)}`,
        }],
      };
    } catch (error) {
      console.error("find_derivatives failed", error);
      return {
        content: [{ type: "text", text: String(error) }],
        isError: true,
      };
    }
  },
);
