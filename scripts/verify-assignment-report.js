#!/usr/bin/env node
/* eslint-env node */
/**
 * verify-assignment-report.js
 *
 * Independent integrity checker for CodeVibe assignment reports.
 *
 * Given an exported AssignmentReport JSON file, this tool:
 *   1. validates the report structure (version, required fields, integrity block)
 *   2. recomputes the sha256 hash over the canonical (key-sorted) JSON of the
 *      report payload (everything except `integrity`)
 *   3. compares it with the stored hash using a constant-time comparison
 *   4. prints a human-readable summary of the authorship/ownership numbers
 *
 * Exit codes:
 *   0 - report is well-formed and the integrity hash matches
 *   1 - report is malformed or the integrity hash does NOT match (tampered)
 *   2 - usage / IO error
 *
 * Usage:
 *   node scripts/verify-assignment-report.js <report.json>
 *
 * NOTE: This file intentionally does NOT import from the extension source.
 * An integrity check is only meaningful if the verifier is independent of the
 * code that produced the report.
 */

"use strict";

const fs = require("fs");
const crypto = require("crypto");

/**
 * Canonical JSON serialization. Must match the algorithm used by the exporter:
 * object keys sorted recursively, array order preserved, undefined/function
 * values dropped (arrays: replaced with null), numbers via JSON.stringify.
 */
function canonicalize(value) {
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => {
      const serialized = canonicalize(item);
      return serialized === undefined ? "null" : serialized;
    });
    return "[" + items.join(",") + "]";
  }
  if (typeof value === "object") {
    const parts = [];
    for (const key of Object.keys(value).sort()) {
      const serialized = canonicalize(value[key]);
      if (serialized !== undefined) {
        parts.push(JSON.stringify(key) + ":" + serialized);
      }
    }
    return "{" + parts.join(",") + "}";
  }
  return undefined;
}

function fail(message) {
  console.error("INTEGRITY CHECK FAILED: " + message);
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] === "-h" || args[0] === "--help") {
    console.error(
      "Usage: node scripts/verify-assignment-report.js <report.json>",
    );
    process.exit(args.length === 1 ? 0 : 2);
  }

  let raw;
  try {
    raw = fs.readFileSync(args[0], "utf8");
  } catch (err) {
    console.error("Cannot read file: " + err.message);
    process.exit(2);
  }

  let report;
  try {
    report = JSON.parse(raw);
  } catch (err) {
    console.error("File is not valid JSON: " + err.message);
    process.exit(2);
  }

  // ---- Structural validation ----
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    fail("report is not a JSON object");
  }
  if (report.reportVersion !== "1.0") {
    fail(
      `unsupported reportVersion: ${JSON.stringify(report.reportVersion)} (expected "1.0")`,
    );
  }
  for (const field of [
    "assignmentId",
    "assignmentName",
    "generatedAt",
    "metrics",
    "policy",
    "integrity",
  ]) {
    if (!(field in report)) {
      fail(`missing required field: ${field}`);
    }
  }
  const integrity = report.integrity;
  if (integrity.algorithm !== "sha256") {
    fail(
      `unsupported integrity algorithm: ${JSON.stringify(integrity.algorithm)}`,
    );
  }
  if (
    typeof integrity.hash !== "string" ||
    !/^[0-9a-f]{64}$/.test(integrity.hash)
  ) {
    fail("integrity.hash is not a 64-char lowercase hex sha256 digest");
  }

  const metrics = report.metrics;
  if (
    !metrics ||
    typeof metrics !== "object" ||
    !metrics.authorship ||
    !metrics.ownership
  ) {
    fail("metrics block is missing authorship/ownership data");
  }

  // ---- Hash verification ----
  // Signed payload = all fields except `integrity` and `generatedAt`.
  // generatedAt is export metadata; excluding it keeps the hash stable
  // across re-exports of unchanged metrics (same data, same report).
  const payload = { ...report };
  delete payload.integrity;
  delete payload.generatedAt;

  const canonical = canonicalize(payload);
  const expectedHash = crypto
    .createHash("sha256")
    .update(canonical, "utf8")
    .digest("hex");

  const stored = Buffer.from(integrity.hash, "utf8");
  const expected = Buffer.from(expectedHash, "utf8");
  const match =
    stored.length === expected.length &&
    crypto.timingSafeEqual(stored, expected);

  // ---- Summary ----
  const a = metrics.authorship;
  const o = metrics.ownership;
  const violations = Array.isArray(metrics.violations)
    ? metrics.violations
    : [];

  console.log(
    "Assignment report: " +
      report.assignmentName +
      " (" +
      report.assignmentId +
      ")",
  );
  console.log(
    "Generated at:        " + new Date(report.generatedAt).toISOString(),
  );
  console.log(
    "Authorship:          " +
      a.authorshipPercentage.toFixed(1) +
      "% AI " +
      `(${a.permittedAILines} permitted + ${a.prohibitedAILines} prohibited + ${a.flaggedAILines} flagged of ${a.totalLines} total lines; ${a.manualLines} manual)`,
  );
  console.log(
    "Ownership score:     " +
      o.score.toFixed(1) +
      ` (${o.filesReviewed} reviewed files, ${o.filesUnreviewed} unreviewed, ${o.unreviewedLines} unreviewed lines)`,
  );
  console.log(
    "Policy violations:   " +
      violations.length +
      (violations.length > 0
        ? " [" + violations.map((v) => v.type + " x" + v.count).join(", ") + "]"
        : ""),
  );

  // Guidance sealed into the report at export time. Absent in reports
  // exported before the field existed.
  const recommendations = Array.isArray(report.recommendations)
    ? report.recommendations.filter(
        (r) => r && typeof r.id === "string" && typeof r.message === "string",
      )
    : [];
  console.log(
    "Recommendations:     " +
      (recommendations.length > 0
        ? recommendations.length +
          " [" +
          recommendations.map((r) => r.id).join(", ") +
          "]"
        : "none recorded"),
  );
  for (const rec of recommendations) {
    console.log(
      "  - " +
        String(rec.severity || "-").toUpperCase() +
        " " +
        rec.id +
        ": " +
        rec.message,
    );
    if (rec.action) {
      console.log("    -> " + rec.action);
    }
  }

  if (!match) {
    console.error("");
    console.error("Stored hash:     " + integrity.hash);
    console.error("Recomputed hash: " + expectedHash);
    fail("hash mismatch - the report has been modified after export");
  }

  console.log("");
  console.log("INTEGRITY OK - report is authentic and unmodified.");
  process.exit(0);
}

main();
