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

      // Build an in-memory tree rooted at rootId. Each node has
      // { thought, parents: node[] }, keyed by thought_id for de-dup.
      type Node = {
        thought_id: string;
        depth: number;
        cycle: boolean;
        restricted: boolean;
        type: string | null;
        source_type: string | null;
        derivation_method: string | null;
        derivation_layer: string | null;
        created_at: string;
        content_preview: string | null;
        parents: Node[];
      };

      const nodeById = new Map<string, Node>();
      for (const r of rows) {
        if (!nodeById.has(r.thought_id)) {
          nodeById.set(r.thought_id, {
            thought_id: r.thought_id,
            depth: r.depth,
            cycle: r.cycle,
            restricted: r.restricted,
            type: r.type,
            source_type: r.source_type,
            derivation_method: r.derivation_method,
            derivation_layer: r.derivation_layer,
            created_at: r.created_at,
            // SQL already redacts restricted content to NULL; truncate rest.
            content_preview: r.content ? r.content.slice(0, 200) : null,
            parents: [],
          });
        }
      }
      for (const r of rows) {
        if (!r.parent_id) continue;
        const parent = nodeById.get(r.thought_id);
        const child = nodeById.get(r.parent_id);
        if (parent && child && !child.parents.some((p) => p.thought_id === parent.thought_id)) {
          child.parents.push(parent);
        }
      }

      const root = nodeById.get(rootId);
      if (!root) {
        return {
          content: [{ type: "text", text: `Thought ${rootId} not found` }],
          isError: true,
        };
      }

      const nodeCount = nodeById.size;
      const truncated = nodeCount >= NODE_CAP;
      const summary =
        `Traced provenance of ${rootId} (depth=${maxDepth}, ${nodeCount} nodes visited` +
        (truncated ? `, truncated at node_cap=${NODE_CAP}` : "") +
        `).`;

      // Return the summary line plus the full tree as pretty JSON in the
      // same text block. Claude Desktop renders this cleanly and the
      // caller can re-parse the JSON if needed.
      return {
        content: [{
          type: "text",
          text: `${summary}\n\n${JSON.stringify({
            tree: root,
            node_count: nodeCount,
            depth_limit: maxDepth,
            node_cap: NODE_CAP,
            truncated,
          }, null, 2)}`,
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
