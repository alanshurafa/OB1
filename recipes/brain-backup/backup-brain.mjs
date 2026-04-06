#!/usr/bin/env node
/**
 * backup-brain.mjs — Export all Open Brain Supabase tables to local JSON files.
 *
 * Paginates through PostgREST (1000 rows per request) and writes each table
 * to backup/<table>-YYYY-MM-DD.json. Shows progress and prints a summary.
 *
 * Usage:
 *   export SUPABASE_URL=https://<your-project-ref>.supabase.co
 *   export SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>
 *   node backup-brain.mjs
 *
 * Or let the script read .env.local directly:
 *   node backup-brain.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PAGE_SIZE = 1000;

const TABLES = [
  { name: "thoughts",        orderBy: "id" },
  { name: "entities",        orderBy: "id" },
  { name: "edges",           orderBy: "id" },
  { name: "thought_entities", orderBy: "thought_id,entity_id" },
  { name: "reflections",     orderBy: "id" },
  { name: "ingestion_jobs",  orderBy: "id" },
  { name: "ingestion_items", orderBy: "id" },
];

// ---------------------------------------------------------------------------
// Env loading
// ---------------------------------------------------------------------------

function loadEnvFile() {
  // Look for .env.local next to the script first, then one directory up.
  const candidates = [
    path.join(__dirname, ".env.local"),
    path.join(PROJECT_ROOT, ".env.local"),
  ];
  const vars = {};
  for (const envPath of candidates) {
    if (fs.existsSync(envPath)) {
      for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx);
          if (!(key in vars)) {
            vars[key] = trimmed.slice(eqIdx + 1).replace(/^['"]|['"]$/g, "");
          }
        }
      }
      break; // use the first file found
    }
  }
  return vars;
}

const envVars = loadEnvFile();

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  envVars.SUPABASE_URL ||
  "";

if (!SUPABASE_URL) {
  console.error(
    "ERROR: SUPABASE_URL not found.\n" +
    "Either export it or ensure it exists in .env.local."
  );
  process.exit(1);
}

const REST_BASE = `${SUPABASE_URL}/rest/v1`;

const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  envVars.SUPABASE_SERVICE_ROLE_KEY ||
  "";

if (!SERVICE_KEY) {
  console.error(
    "ERROR: SUPABASE_SERVICE_ROLE_KEY not found.\n" +
    "Either export it or ensure it exists in .env.local."
  );
  process.exit(1);
}

const HEADERS = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
  Prefer: "count=exact",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function today() {
  const d = new Date();
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Fetch a single page of rows from a table using Range header. */
async function fetchPage(table, orderBy, offset, limit) {
  const url = `${REST_BASE}/${table}?order=${orderBy}&limit=${limit}&offset=${offset}`;
  const rangeEnd = offset + limit - 1;
  const res = await fetch(url, {
    headers: {
      ...HEADERS,
      Range: `${offset}-${rangeEnd}`,
    },
  });

  if (!res.ok && res.status !== 206) {
    const body = await res.text();
    throw new Error(`PostgREST error ${res.status} on ${table}: ${body}`);
  }

  // Parse total from content-range header: "0-999/75000"
  let total = null;
  const cr = res.headers.get("content-range");
  if (cr) {
    const match = cr.match(/\/(\d+|\*)/);
    if (match && match[1] !== "*") total = parseInt(match[1], 10);
  }

  const rows = await res.json();
  return { rows, total };
}

/** Export one table, streaming rows to disk to avoid V8 string length limits. */
async function exportTable(tableName, orderBy, backupDir, dateStr) {
  const filePath = path.join(backupDir, `${tableName}-${dateStr}.json`);
  let offset = 0;
  let total = null;
  let rowCount = 0;

  // First page to get total count
  const first = await fetchPage(tableName, orderBy, 0, PAGE_SIZE);
  total = first.total;

  const label = `  ${tableName}`;
  if (first.rows.length === 0) {
    process.stdout.write(`${label}: 0 rows (empty table)\n`);
    fs.writeFileSync(filePath, "[]");
    return { rowCount: 0, filePath, fileSize: 2 };
  }

  // Stream JSON array to file — write each row individually to avoid huge string
  const fd = fs.openSync(filePath, "w");
  fs.writeSync(fd, "[\n");
  let firstRow = true;

  function writeRows(rows) {
    for (const row of rows) {
      if (!firstRow) fs.writeSync(fd, ",\n");
      fs.writeSync(fd, JSON.stringify(row));
      firstRow = false;
      rowCount++;
    }
  }

  writeRows(first.rows);
  process.stdout.write(
    `${label}: ${rowCount}${total != null ? "/" + total : ""} rows\r`
  );

  // Remaining pages
  offset = PAGE_SIZE;
  while (first.rows.length === PAGE_SIZE && (total == null || offset < total)) {
    const page = await fetchPage(tableName, orderBy, offset, PAGE_SIZE);
    if (page.rows.length === 0) break;
    writeRows(page.rows);
    offset += page.rows.length;

    process.stdout.write(
      `${label}: ${rowCount}${total != null ? "/" + total : ""} rows\r`
    );
  }

  fs.writeSync(fd, "\n]");
  fs.closeSync(fd);

  const fileSize = fs.statSync(filePath).size;

  process.stdout.write(
    `${label}: ${rowCount} rows (${humanSize(fileSize)})               \n`
  );

  return { rowCount, filePath, fileSize };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const dateStr = today();
  const backupDir = path.join(__dirname, "backup");

  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
    console.log(`Created ${backupDir}`);
  }

  console.log(`\nOpen Brain Backup — ${dateStr}`);
  console.log(`Target: ${backupDir}\n`);

  const results = [];
  for (const table of TABLES) {
    try {
      const result = await exportTable(table.name, table.orderBy, backupDir, dateStr);
      results.push({ table: table.name, ...result });
    } catch (err) {
      console.error(`\n  ERROR exporting ${table.name}: ${err.message}`);
      results.push({ table: table.name, rowCount: 0, filePath: null, fileSize: 0, error: err.message });
    }
  }

  // Summary
  const totalRows = results.reduce((s, r) => s + r.rowCount, 0);
  const totalSize = results.reduce((s, r) => s + r.fileSize, 0);

  console.log("\n--- Backup Summary ---");
  console.log(`Date:  ${dateStr}`);
  console.log(`Dir:   ${backupDir}\n`);

  const colTable = "Table".padEnd(20);
  const colRows  = "Rows".padStart(8);
  const colSize  = "Size".padStart(10);
  console.log(`${colTable}${colRows}${colSize}`);
  console.log("-".repeat(38));

  for (const r of results) {
    const name = r.table.padEnd(20);
    const rows = String(r.rowCount).padStart(8);
    const size = (r.error ? "ERROR" : humanSize(r.fileSize)).padStart(10);
    console.log(`${name}${rows}${size}`);
  }

  console.log("-".repeat(38));
  console.log(`${"TOTAL".padEnd(20)}${String(totalRows).padStart(8)}${humanSize(totalSize).padStart(10)}`);
  console.log(`\nDone. ${results.filter(r => !r.error).length}/${results.length} tables exported successfully.`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
