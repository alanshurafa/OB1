// smart-ingest
//
// Supabase Edge Function for review-first ingestion. It accepts extracted
// records from offline import recipes, creates ingestion_jobs/items rows, and
// executes approved items through the core upsert_thought RPC.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SMART_INGEST_KEY = Deno.env.get("SMART_INGEST_KEY") ?? Deno.env.get("MCP_ACCESS_KEY") ?? "";
const MAX_RECORDS = Number(Deno.env.get("SMART_INGEST_MAX_RECORDS") ?? "500");
const MAX_CONTENT_CHARS = Number(Deno.env.get("SMART_INGEST_MAX_CONTENT_CHARS") ?? "20000");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-brain-key",
  "Content-Type": "application/json",
};

type IngestAction = "add" | "skip" | "append_evidence" | "create_revision";

interface InputRecord {
  content?: string;
  text?: string;
  source?: string;
  source_type?: string;
  source_label?: string;
  source_path?: string;
  source_locator?: string;
  created_at?: string;
  type?: string;
  topics?: string[];
  people?: string[];
  action_items?: string[];
  confidence?: string;
  metadata?: Record<string, unknown>;
}

interface IngestJob {
  id: string;
  source_type: string;
  source_label: string;
  input_hash: string;
  status: string;
}

interface IngestItem {
  id: string;
  job_id: string;
  sequence: number;
  extracted_content: string;
  content_fingerprint: string | null;
  action: IngestAction;
  status: string;
  review_status: string;
  matched_thought_id: string | null;
  metadata: Record<string, unknown>;
}

interface SupabaseError {
  message?: string;
  details?: string;
  hint?: string;
  code?: string;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: CORS_HEADERS });
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function isAuthorized(req: Request): boolean {
  const token =
    req.headers.get("x-brain-key")?.trim() ||
    (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  return Boolean(token && SMART_INGEST_KEY && constantTimeEqual(token, SMART_INGEST_KEY));
}

function requireConfig(): Response | null {
  const missing = [];
  if (!SUPABASE_URL) missing.push("SUPABASE_URL");
  if (!SUPABASE_SERVICE_ROLE_KEY) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!SMART_INGEST_KEY) missing.push("SMART_INGEST_KEY or MCP_ACCESS_KEY");
  return missing.length ? json({ error: "missing_config", missing }, 500) : null;
}

function contentOf(record: InputRecord): string {
  if (typeof record.content === "string") return record.content.trim();
  if (typeof record.text === "string") return record.text.trim();
  return "";
}

function sourceTypeOf(record: InputRecord, fallback: string): string {
  return record.source_type?.trim() || record.source?.trim() || fallback;
}

function sourceLabelOf(record: InputRecord, fallback: string): string {
  return record.source_label?.trim() || fallback;
}

function normalizeTopics(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function stableRecordPayload(record: InputRecord): Record<string, unknown> {
  return {
    source: record.source ?? record.source_type ?? null,
    source_label: record.source_label ?? null,
    source_path: record.source_path ?? null,
    source_locator: record.source_locator ?? null,
    original_created_at: record.created_at ?? null,
    type: record.type ?? "reference",
    topics: normalizeTopics(record.topics),
    people: normalizeTopics(record.people),
    action_items: normalizeTopics(record.action_items),
    confidence: record.confidence ?? "extracted",
    upstream_metadata: record.metadata ?? {},
  };
}

function validateRecords(records: InputRecord[]): string[] {
  const errors: string[] = [];
  if (records.length === 0) errors.push("records must contain at least one item");
  if (records.length > MAX_RECORDS) errors.push(`records exceeds SMART_INGEST_MAX_RECORDS (${MAX_RECORDS})`);

  records.forEach((record, index) => {
    const content = contentOf(record);
    if (!content) errors.push(`records[${index}]: missing content or text`);
    if (content.length > MAX_CONTENT_CHARS) {
      errors.push(`records[${index}]: content exceeds SMART_INGEST_MAX_CONTENT_CHARS (${MAX_CONTENT_CHARS})`);
    }
    if (record.created_at && Number.isNaN(Date.parse(record.created_at))) {
      errors.push(`records[${index}]: created_at is not a valid date`);
    }
  });

  return errors;
}

async function supabaseFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(`${SUPABASE_URL.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function readJsonOrError<T>(response: Response): Promise<T> {
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = parsed as SupabaseError | null;
    throw new Error(error?.message || error?.details || text || `Supabase request failed: ${response.status}`);
  }
  return parsed as T;
}

async function createJob(records: InputRecord[], sourceType: string, sourceLabel: string): Promise<IngestJob> {
  const inputHash = await sha256(JSON.stringify(records));
  const inputBytes = new TextEncoder().encode(JSON.stringify(records)).byteLength;
  const response = await supabaseFetch("/rest/v1/ingestion_jobs?on_conflict=source_type,input_hash", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({
      source_type: sourceType,
      source_label: sourceLabel,
      input_hash: inputHash,
      input_bytes: inputBytes,
      dry_run: true,
      status: "dry_run_complete",
      metadata: {
        importer_name: "smart-ingest",
        importer_version: "1.0.0",
        record_count: records.length,
      },
    }),
  });
  const rows = await readJsonOrError<IngestJob[]>(response);
  return rows[0];
}

async function upsertItems(job: IngestJob, records: InputRecord[]): Promise<IngestItem[]> {
  const rows = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const content = contentOf(record);
    const sourceType = sourceTypeOf(record, job.source_type);
    const sourceLabel = sourceLabelOf(record, job.source_label);
    rows.push({
      job_id: job.id,
      sequence: index + 1,
      extracted_content: content,
      content_fingerprint: await sha256(content.toLowerCase().replace(/\s+/g, " ").trim()),
      action: "add",
      status: "ready",
      review_status: "unreviewed",
      reason: "dry_run_record",
      metadata: {
        ...stableRecordPayload(record),
        source: sourceType,
        source_type: sourceType,
        source_label: sourceLabel,
        source_path: record.source_path ?? null,
        source_locator: record.source_locator ?? `record-${index + 1}`,
        imported_at: new Date().toISOString(),
        importer_name: "smart-ingest",
        importer_version: "1.0.0",
        sensitivity_tier: "standard",
        provenance: {
          method: "direct_record",
          source_record: record.source_locator ?? record.source_path ?? `record-${index + 1}`,
          source_locator: record.source_locator ?? null,
          review_status: "unreviewed",
        },
      },
    });
  }

  const response = await supabaseFetch("/rest/v1/ingestion_items?on_conflict=job_id,sequence", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(rows),
  });
  return await readJsonOrError<IngestItem[]>(response);
}

async function recountJob(jobId: string): Promise<void> {
  const response = await supabaseFetch("/rest/v1/rpc/recount_ingestion_job", {
    method: "POST",
    body: JSON.stringify({ p_job_id: jobId }),
  });
  await readJsonOrError<unknown>(response);
}

async function handleCreate(req: Request): Promise<Response> {
  const body = await req.json();
  const records: InputRecord[] = Array.isArray(body.records)
    ? body.records
    : body.record
      ? [body.record]
      : body.text
        ? [{ content: body.text, source: body.source_type ?? body.source, source_label: body.source_label }]
        : [];
  const errors = validateRecords(records);
  if (errors.length) return json({ error: "invalid_records", errors }, 400);

  const sourceType = String(body.source_type || body.source || sourceTypeOf(records[0], "smart_ingest"));
  const sourceLabel = String(body.source_label || sourceLabelOf(records[0], "Smart ingest"));
  const job = await createJob(records, sourceType, sourceLabel);
  const items = await upsertItems(job, records);
  await recountJob(job.id);

  return json({
    status: "dry_run_complete",
    job_id: job.id,
    extracted_count: items.length,
    message: `Dry run complete: ${items.length} reviewable item(s) ready.`,
    items: items.map((item) => ({
      id: item.id,
      sequence: item.sequence,
      action: item.action,
      status: item.status,
      review_status: item.review_status,
      preview: item.extracted_content.slice(0, 160),
    })),
  }, 201);
}

async function fetchExecutableItems(jobId: string, executeUnreviewed: boolean): Promise<IngestItem[]> {
  const reviewFilter = executeUnreviewed ? "" : "&review_status=eq.approved";
  const response = await supabaseFetch(
    `/rest/v1/ingestion_items?job_id=eq.${encodeURIComponent(jobId)}&status=eq.ready${reviewFilter}&order=sequence.asc`,
  );
  return await readJsonOrError<IngestItem[]>(response);
}

async function updateItem(id: string, patch: Record<string, unknown>): Promise<void> {
  const response = await supabaseFetch(`/rest/v1/ingestion_items?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(patch),
  });
  await readJsonOrError<unknown>(response);
}

async function updateJob(id: string, patch: Record<string, unknown>): Promise<void> {
  const response = await supabaseFetch(`/rest/v1/ingestion_jobs?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(patch),
  });
  await readJsonOrError<unknown>(response);
}

async function upsertThought(content: string, metadata: Record<string, unknown>): Promise<string | null> {
  const response = await supabaseFetch("/rest/v1/rpc/upsert_thought", {
    method: "POST",
    body: JSON.stringify({ p_content: content, p_payload: { metadata } }),
  });
  const result = await readJsonOrError<{ id?: string; thought_id?: string }>(response);
  return result.id ?? result.thought_id ?? null;
}

async function appendEvidence(thoughtId: string, item: IngestItem): Promise<void> {
  const metadata = item.metadata ?? {};
  const response = await supabaseFetch("/rest/v1/rpc/append_thought_evidence", {
    method: "POST",
    body: JSON.stringify({
      p_thought_id: thoughtId,
      p_evidence: {
        source: metadata.source ?? metadata.source_type ?? "smart_ingest",
        source_label: metadata.source_label ?? "Smart ingest",
        source_locator: metadata.source_locator ?? null,
        extracted_at: new Date().toISOString(),
        excerpt: item.extracted_content.slice(0, 5000),
        review_status: "unreviewed",
      },
    }),
  });
  await readJsonOrError<unknown>(response);
}

async function executeItem(item: IngestItem): Promise<void> {
  if (item.action === "skip") {
    await updateItem(item.id, { status: "executed", executed_at: new Date().toISOString() });
    return;
  }

  if (item.action === "append_evidence") {
    if (!item.matched_thought_id) throw new Error("append_evidence item missing matched_thought_id");
    await appendEvidence(item.matched_thought_id, item);
    await updateItem(item.id, { status: "executed", result_thought_id: item.matched_thought_id, executed_at: new Date().toISOString() });
    return;
  }

  const metadata: Record<string, unknown> = {
    ...(item.metadata ?? {}),
    ingestion_item_id: item.id,
    review_status: "unreviewed",
  };
  if (item.action === "create_revision" && item.matched_thought_id) {
    metadata["revision_of"] = item.matched_thought_id;
  }
  const thoughtId = await upsertThought(item.extracted_content, metadata);
  await updateItem(item.id, { status: "executed", result_thought_id: thoughtId, executed_at: new Date().toISOString() });
}

async function handleExecute(req: Request): Promise<Response> {
  const body = await req.json();
  const jobId = String(body.job_id ?? "");
  if (!jobId) return json({ error: "job_id is required" }, 400);

  const executeUnreviewed = body.execute_unreviewed === true;
  const items = await fetchExecutableItems(jobId, executeUnreviewed);
  await updateJob(jobId, { status: "executing" });

  const failures = [];
  for (const item of items) {
    try {
      await executeItem(item);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ item_id: item.id, error: message });
      await updateItem(item.id, { status: "failed", error_message: message });
    }
  }

  await recountJob(jobId);
  await updateJob(jobId, {
    status: failures.length ? "failed" : "complete",
    completed_at: new Date().toISOString(),
    error_message: failures.length ? `${failures.length} item(s) failed` : null,
  });

  return json({
    status: failures.length ? "failed" : "complete",
    job_id: jobId,
    executed_count: items.length - failures.length,
    failed_count: failures.length,
    failures,
  });
}

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method === "GET") return json({ ok: true, service: "smart-ingest" });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const configError = requireConfig();
  if (configError) return configError;
  if (!isAuthorized(req)) return json({ error: "unauthorized" }, 401);

  try {
    const path = new URL(req.url).pathname;
    return path.endsWith("/execute") ? await handleExecute(req) : await handleCreate(req);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: "smart_ingest_failed", message }, 500);
  }
}

Deno.serve(handleRequest);
