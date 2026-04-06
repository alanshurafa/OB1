/**
 * memory-core.mjs
 *
 * Shared utility helpers for thought enrichment scripts.
 * Trimmed from the full ExoCortex memory-core to include only
 * the functions needed by the enrichment pipeline.
 */

import crypto from "node:crypto";

export function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function canonicalizeText(value) {
  return normalizeWhitespace(value).toLowerCase();
}

export function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

export function buildContentFingerprint(text) {
  return sha256Hex(canonicalizeText(text));
}

export function normalizeStringArray(value, limit = 24) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set();
  const normalized = [];
  for (const item of value) {
    const text = normalizeWhitespace(item);
    if (!text) {
      continue;
    }
    const key = text.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(text);
    if (normalized.length >= limit) {
      break;
    }
  }
  return normalized;
}
