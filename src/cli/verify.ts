#!/usr/bin/env node
/* eslint-env node */
/**
 * codevibe-verify - Independent integrity + compliance checker for CodeVibe assignment reports.
 *
 * Usage:
 *   codevibe-verify <report.json>...
 *   codevibe-verify reports/*.json --strict --json
 *   cat report.json | codevibe-verify -
 *   npx --package code-pause codevibe-verify file.json
 *   npx codevibe-verify file.json          # when published as `codevibe-verify` package
 *
 * Exit codes:
 *   0 - all files integrity OK (and if --strict, also compliant)
 *   1 - any file integrity FAIL / malformed / compliance FAIL (with --strict)
 *   2 - usage / IO error (no files, cannot read)
 *
 * This file intentionally does NOT import from src/ to keep verifier independent.
 * It must stay byte-identical to AssignmentReportGenerator.canonicalize.
 */

import * as fs from "fs";
import * as crypto from "crypto";

// ---------------------------------------------------------------------------
// Canonical JSON serialization - must match AssignmentReportGenerator.canonicalize
// ---------------------------------------------------------------------------
function canonicalize(value: unknown): string | undefined {
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
    const parts: string[] = [];
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const serialized = canonicalize((value as Record<string, unknown>)[key]);
      if (serialized !== undefined) {
        parts.push(JSON.stringify(key) + ":" + serialized);
      }
    }
    return "{" + parts.join(",") + "}";
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Types (local, no import)
// ---------------------------------------------------------------------------
interface Integrity {
  algorithm: string;
  hash: string;
}
interface Report {
  reportVersion: string;
  assignmentId: string;
  assignmentName: string;
  generatedAt: number;
  studentIdentifier?: string;
  repoUrl?: string;
  repoHeadCommit?: string;
  metrics: {
    authorship: {
      totalLines: number;
      manualLines: number;
      permittedAILines: number;
      prohibitedAILines: number;
      flaggedAILines: number;
      authorshipPercentage: number;
      prohibitedPercentage: number;
    };
    ownership: {
      score: number;
      filesReviewed: number;
      filesUnreviewed: number;
      unreviewedLines: number;
      averageReviewTimeMs: number;
    };
    violations: Array<{
      type: string;
      severity: "low" | "medium" | "high";
      message: string;
      count: number;
    }>;
    trackingGaps?: unknown[];
    rawEvents?: unknown[];
    fileReviews?: unknown[];
  };
  policy: {
    maxAuthorshipPercentage: number;
    minOwnershipScore: number;
    exemptFileGlobs?: string[];
    prohibitedMethods?: string[];
    permittedMethods?: string[];
    flaggedMethods?: string[];
  };
  exclusionAudit?: Array<{
    timestamp: number;
    globs: string[];
    source: string;
  }>;
  /** Guidance sealed at export time. Absent in pre-recommendations reports. */
  recommendations?: Array<{
    id: string;
    severity: "low" | "medium" | "high";
    message: string;
    action: string;
  }>;
  integrity: Integrity;
  [key: string]: unknown;
}

type FileResult = {
  file: string;
  okIntegrity: boolean;
  integrityError?: string;
  okCompliance?: boolean;
  complianceError?: string;
  report?: Report;
  expectedHash?: string;
  storedHash?: string;
  authorshipPct?: number;
  ownershipScore?: number;
  violations?: Report["metrics"]["violations"];
  exclusionAudit?: NonNullable<Report["exclusionAudit"]>;
  recommendations?: NonNullable<Report["recommendations"]>;
  skipped?: boolean;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function isTTY(): boolean {
  return Boolean(process.stdout.isTTY && process.env.TERM !== "dumb");
}

function colorize(text: string, color: "green" | "red" | "yellow" | "dim" | "cyan" | "bold", enabled: boolean): string {
  if (!enabled) return text;
  const codes: Record<string, string> = {
    green: "\u001b[32m",
    red: "\u001b[31m",
    yellow: "\u001b[33m",
    dim: "\u001b[2m",
    cyan: "\u001b[36m",
    bold: "\u001b[1m",
  };
  const reset = "\u001b[0m";
  return `${codes[color] || ""}${text}${reset}`;
}

function formatDate(ms: number): string {
  try {
    return new Date(ms).toISOString();
  } catch {
    return String(ms);
  }
}

// ---------------------------------------------------------------------------
// Validation + Integrity + Compliance
// ---------------------------------------------------------------------------
function validateStructure(report: unknown): { ok: boolean; error?: string } {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return { ok: false, error: "report is not a JSON object" };
  }
  const r = report as Record<string, unknown>;
  if (r.reportVersion !== "1.0") {
    return { ok: false, error: `unsupported reportVersion: ${JSON.stringify(r.reportVersion)} (expected "1.0")` };
  }
  for (const field of ["assignmentId", "assignmentName", "generatedAt", "metrics", "policy", "integrity"]) {
    if (!(field in r)) return { ok: false, error: `missing required field: ${field}` };
  }
  const integrity = r.integrity as Record<string, unknown>;
  if (!integrity || integrity.algorithm !== "sha256") {
    return { ok: false, error: `unsupported integrity algorithm: ${JSON.stringify(integrity?.algorithm)}` };
  }
  if (typeof integrity.hash !== "string" || !/^[0-9a-f]{64}$/.test(integrity.hash)) {
    return { ok: false, error: "integrity.hash is not a 64-char lowercase hex sha256 digest" };
  }
  const metrics = r.metrics as Record<string, unknown>;
  if (!metrics || typeof metrics !== "object" || !((metrics as Record<string, unknown>).authorship) || !((metrics as Record<string, unknown>).ownership)) {
    return { ok: false, error: "metrics block is missing authorship/ownership data" };
  }
  return { ok: true };
}

function verifyIntegrity(report: Report): { ok: boolean; expectedHash: string; storedHash: string; canonical?: string } {
  const payload: Record<string, unknown> = { ...(report as unknown as Record<string, unknown>) };
  delete payload.integrity;
  delete payload.generatedAt;
  const canonical = canonicalize(payload) ?? "";
  const expectedHash = crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
  const storedHash = (report.integrity.hash as string).toLowerCase();
  const storedBuf = Buffer.from(storedHash, "utf8");
  const expectedBuf = Buffer.from(expectedHash, "utf8");
  const ok = storedBuf.length === expectedBuf.length && crypto.timingSafeEqual(storedBuf, expectedBuf);
  return { ok, expectedHash, storedHash, canonical };
}

function checkCompliance(report: Report): { ok: boolean; authOk: boolean; ownOk: boolean; hasViolations: boolean; reasons: string[] } {
  const a = report.metrics.authorship;
  const o = report.metrics.ownership;
  const v = Array.isArray(report.metrics.violations) ? report.metrics.violations : [];
  const authOk = typeof a.authorshipPercentage === "number" && typeof report.policy.maxAuthorshipPercentage === "number"
    ? a.authorshipPercentage <= report.policy.maxAuthorshipPercentage
    : true;
  // Ownership only relevant if there are AI files; empty ownership (0 files) is not a failure
  const totalFiles = (o.filesReviewed ?? 0) + (o.filesUnreviewed ?? 0);
  const ownOk = totalFiles === 0
    ? true
    : typeof o.score === "number" && typeof report.policy.minOwnershipScore === "number"
      ? o.score >= report.policy.minOwnershipScore
      : true;
  const hasViolations = v.length > 0;
  const reasons: string[] = [];
  if (!authOk) reasons.push(`authorship ${a.authorshipPercentage.toFixed(1)}% > limit ${report.policy.maxAuthorshipPercentage}%`);
  if (!ownOk) reasons.push(`ownership ${o.score.toFixed(1)} < min ${report.policy.minOwnershipScore}`);
  if (hasViolations) reasons.push(`${v.length} violation(s): ${v.map(x => `${x.type} x${x.count} (${x.severity})`).join(", ")}`);
  const ok = authOk && ownOk && !hasViolations;
  return { ok, authOk, ownOk, hasViolations, reasons };
}

/**
 * Reports are student-supplied JSON, so the recommendations array may be
 * missing, not an array, or hold junk. Keep only entries we can render.
 */
function normalizeRecommendations(
  value: unknown,
): NonNullable<Report["recommendations"]> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (rec): rec is NonNullable<Report["recommendations"]>[number] =>
      !!rec &&
      typeof rec === "object" &&
      typeof (rec as { id?: unknown }).id === "string" &&
      typeof (rec as { message?: unknown }).message === "string",
  );
}

function readFileOrStdin(filePath: string): string {
  if (filePath === "-") {
    return fs.readFileSync(0, "utf8");
  }
  return fs.readFileSync(filePath, "utf8");
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderHuman(results: FileResult[], opts: { useColor: boolean; verbose: boolean }): string {
  const useColor = opts.useColor;
  const lines: string[] = [];
  for (const r of results) {
    const label = r.file === "-" ? "<stdin>" : r.file;
    if (r.skipped) {
      lines.push(`${colorize("○", "dim", useColor)} ${label} — ${colorize("SKIPPED", "dim", useColor)} — ${r.integrityError}`);
      continue;
    }
    const integrityIcon = r.okIntegrity ? colorize("✔", "green", useColor) : colorize("✘", "red", useColor);
    const integrityText = r.okIntegrity ? colorize("INTEGRITY OK", "green", useColor) : colorize("INTEGRITY FAIL", "red", useColor);
    let complianceText = "";
    if (r.okCompliance === undefined) {
      complianceText = colorize("COMPLIANCE UNKNOWN", "dim", useColor);
    } else if (r.okCompliance) {
      complianceText = colorize("COMPLIANCE PASS", "green", useColor);
    } else {
      complianceText = colorize("COMPLIANCE FAIL", "red", useColor);
    }
    const dash = " — ";
    lines.push(`${integrityIcon} ${label}${dash}${integrityText}${dash}${complianceText}`);

    // Guard: a report that failed structural validation is still attached for
    // diagnostics, but its metrics block may be missing entirely. Without this
    // check a malformed report crashes the verifier with a TypeError instead
    // of reporting the validation failure.
    const hasMetrics =
      r.report &&
      typeof r.report.metrics === "object" &&
      r.report.metrics !== null &&
      !!r.report.metrics.authorship &&
      !!r.report.metrics.ownership &&
      !!r.report.policy;

    if (r.report) {
      const rep = r.report;
      if (!hasMetrics) {
        if (r.integrityError) {
          lines.push(`  ${colorize("Reason:", "dim", useColor)} ${r.integrityError}`);
        }
        lines.push("");
        continue;
      }
      const a = rep.metrics.authorship;
      const o = rep.metrics.ownership;
      const v = r.violations || [];
      const policy = rep.policy;
      lines.push(`  ${colorize("Assignment:", "bold", useColor)} ${rep.assignmentName} (${rep.assignmentId}) | ${colorize("Student:", "dim", useColor)} ${rep.studentIdentifier || "—"} | ${formatDate(rep.generatedAt)}`);
      if (rep.repoUrl) lines.push(`  ${colorize("Repo:", "dim", useColor)} ${rep.repoUrl} ${rep.repoHeadCommit ? `(${rep.repoHeadCommit.slice(0, 12)})` : ""}`);
      const authStatus = r.okCompliance !== undefined && a.authorshipPercentage <= policy.maxAuthorshipPercentage ? colorize("✓ PASS", "green", useColor) : colorize("✗ FAIL", "red", useColor);
      const authLimit = policy.maxAuthorshipPercentage;
      lines.push(`  ${colorize("Authorship:", "bold", useColor)} ${a.authorshipPercentage.toFixed(1)}% AI (limit ${authLimit}%)  ${authStatus} — ${a.permittedAILines} permitted + ${a.prohibitedAILines} prohibited + ${a.flaggedAILines} flagged / ${a.totalLines} total (${a.manualLines} manual)`);
      const totalOwnFiles = (o.filesReviewed ?? 0) + (o.filesUnreviewed ?? 0);
      const ownStatus = totalOwnFiles === 0
        ? colorize("✓ PASS (no AI files)", "green", useColor)
        : o.score >= policy.minOwnershipScore
          ? colorize("✓ PASS", "green", useColor)
          : colorize("✗ FAIL", "red", useColor);
      lines.push(`  ${colorize("Ownership: ", "bold", useColor)}${o.score.toFixed(1)} /100 (min ${policy.minOwnershipScore})  ${ownStatus} — ${o.filesReviewed} reviewed, ${o.filesUnreviewed} unreviewed (${o.unreviewedLines} lines)`);
      const violText = v.length === 0 ? colorize("0 — none", "green", useColor) : colorize(`${v.length} [${v.map(x => `${x.type} x${x.count} (${x.severity})`).join(", ")}]`, v.some(x => x.severity === "high") ? "red" : "yellow", useColor);
      lines.push(`  ${colorize("Violations:", "bold", useColor)} ${violText}`);
      // Tamper-evidence: exclusion-list changes inside the assignment window.
      // Custom globs are ignored while an assignment is active (lockdown),
      // so settings-sourced entries are attempts, not effective exemptions.
      const audit = r.exclusionAudit || [];
      const settingChanges = audit.filter(e => e.source === "settings");
      if (audit.length === 0) {
        lines.push(`  ${colorize("Exclusion audit:", "dim", useColor)} no changes during assignment window`);
      } else {
        const auditColor = settingChanges.length > 0 ? "yellow" : "dim";
        lines.push(`  ${colorize("Exclusion audit:", "bold", useColor)} ${colorize(`${audit.length} entr${audit.length === 1 ? "y" : "ies"} (${settingChanges.length} student settings change${settingChanges.length === 1 ? "" : "s"}, ignored by lockdown)`, auditColor, useColor)}`);
        if (opts.verbose) {
          for (const entry of audit) {
            const when = formatDate(entry.timestamp);
            const globs = entry.globs.length > 0 ? entry.globs.join(", ") : "—";
            lines.push(`    - ${when} [${entry.source}]: ${globs}`);
          }
        }
      }
      if (opts.verbose && v.length > 0) {
        for (const viol of v) {
          lines.push(`    - ${viol.severity.toUpperCase()} ${viol.type}: ${viol.message}${viol.count > 1 ? ` ×${viol.count}` : ""}`);
        }
      }
      if (rep.metrics.trackingGaps && Array.isArray(rep.metrics.trackingGaps)) {
        lines.push(`  ${colorize("Tracking gaps:", "dim", useColor)} ${(rep.metrics.trackingGaps as unknown[]).length}`);
      }
      // Guidance sealed into the report at export time. Printed, never
      // recomputed - the hash already covers it.
      const recs = r.recommendations || [];
      if (recs.length === 0) {
        lines.push(`  ${colorize("Recommendations:", "dim", useColor)} none recorded`);
      } else {
        const worst = recs.some(x => x.severity === "high")
          ? "red"
          : recs.some(x => x.severity === "medium")
            ? "yellow"
            : "dim";
        lines.push(`  ${colorize("Recommendations:", "bold", useColor)} ${colorize(`${recs.length} [${recs.map(x => x.id).join(", ")}]`, worst, useColor)}`);
        if (opts.verbose) {
          for (const rec of recs) {
            const sev = typeof rec.severity === "string" ? rec.severity.toUpperCase() : "—";
            lines.push(`    - ${sev} ${rec.id}: ${rec.message}`);
            if (rec.action) lines.push(`      ${colorize("→", "cyan", useColor)} ${rec.action}`);
          }
        }
      }
      if (!r.okIntegrity) {
        lines.push(`  ${colorize("Stored:    ", "red", useColor)}${r.storedHash}`);
        lines.push(`  ${colorize("Recomputed:", "red", useColor)}${r.expectedHash}`);
        if (r.integrityError) lines.push(`  ${colorize("Reason:", "red", useColor)} ${r.integrityError}`);
      }
    } else {
      if (r.integrityError) lines.push(`  ${colorize("Reason:", "red", useColor)} ${r.integrityError}`);
      if (r.complianceError) lines.push(`  ${colorize("Compliance:", "red", useColor)} ${r.complianceError}`);
    }
    lines.push("");
  }

  // Summary
  const total = results.length;
  const integrityOk = results.filter(r => r.okIntegrity).length;
  const integrityFail = total - integrityOk;
  const compliant = results.filter(r => r.okCompliance === true).length;
  const nonCompliant = results.filter(r => r.okCompliance === false).length;
  const unknown = results.filter(r => r.okCompliance === undefined).length;
  const skipped = results.filter(r => r.skipped).length;
  lines.push(colorize("─".repeat(60), "dim", useColor));
  lines.push(`Summary: ${total} file(s) — ${integrityOk} integrity OK, ${integrityFail} FAIL${skipped ? `, ${skipped} skipped` : ""} — ${compliant} compliant, ${nonCompliant} non-compliant${unknown ? `, ${unknown} unknown` : ""}`);
  if (integrityFail > 0) lines.push(colorize("Result: At least one report is tampered or malformed — requires review.", "red", useColor));
  else if (nonCompliant > 0) lines.push(colorize("Result: All reports authentic, but some are non-compliant with policy.", "yellow", useColor));
  else lines.push(colorize("Result: All reports authentic and compliant.", "green", useColor));
  return lines.join("\n");
}

function renderJson(results: FileResult[]): string {
  return JSON.stringify(
    results.map(r => ({
      file: r.file,
      okIntegrity: r.okIntegrity,
      okCompliance: r.okCompliance,
      integrityError: r.integrityError,
      complianceError: r.complianceError,
      assignmentId: r.report?.assignmentId,
      assignmentName: r.report?.assignmentName,
      generatedAt: r.report?.generatedAt,
      studentIdentifier: r.report?.studentIdentifier,
      repoHeadCommit: r.report?.repoHeadCommit,
      authorshipPercentage: r.authorshipPct,
      ownershipScore: r.ownershipScore,
      policy: r.report?.policy,
      violations: r.violations,
      exclusionAudit: r.exclusionAudit,
      recommendations: r.recommendations,
      storedHash: r.storedHash,
      expectedHash: r.expectedHash,
      skipped: r.skipped,
    })),
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------
function printHelp(): void {
  console.log(`
${colorize("codevibe-verify", "bold", true)} — verify CodeVibe assignment reports (integrity + compliance)

Usage:
  codevibe-verify <report.json>...
  codevibe-verify reports/*.json --strict
  cat report.json | codevibe-verify -
  npx codevibe-verify file.json
  npx --package codevibe-verify codevibe-verify file.json

Options:
  -h, --help       Show this help
  --version        Show version (reportVersion)
  --json           Machine-readable JSON output
  -q, --quiet      Only print summary, suppress per-file details
  --strict         Compliance failures also cause exit 1 (default: integrity only)
  --no-color       Disable ANSI colors
  --verbose        Show violation messages

Exit codes:
  0  All files integrity OK (and if --strict, also compliant)
  1  Any file integrity FAIL / malformed / (with --strict) non-compliant
  2  Usage / IO error

Examples:
  codevibe-verify hw1.report.json
  codevibe-verify reports/*.json --strict --json | jq '.[] | select(.okIntegrity==false)'
`.trim());
}

function parseArgs(argv: string[]): { files: string[]; json: boolean; quiet: boolean; strict: boolean; noColor: boolean; verbose: boolean; help: boolean; version: boolean } {
  const files: string[] = [];
  let json = false;
  let quiet = false;
  let strict = false;
  let noColor = false;
  let verbose = false;
  let help = false;
  let version = false;
  for (const arg of argv) {
    if (arg === "-") {
      files.push(arg);
    } else if (arg === "-h" || arg === "--help") help = true;
    else if (arg === "--version") version = true;
    else if (arg === "--json") json = true;
    else if (arg === "-q" || arg === "--quiet") quiet = true;
    else if (arg === "--strict") strict = true;
    else if (arg === "--no-color") noColor = true;
    else if (arg === "--verbose") verbose = true;
    else if (arg.startsWith("-")) {
      console.error(`Unknown option: ${arg}`);
      printHelp();
      process.exit(2);
    } else {
      files.push(arg);
    }
  }
  return { files, json, quiet, strict, noColor, verbose, help, version };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (args.version) {
    console.log("1.0");
    process.exit(0);
  }
  if (args.files.length === 0) {
    console.error("Usage: codevibe-verify <report.json>...");
    console.error("Try --help for more information.");
    process.exit(2);
  }

  const useColor = !args.noColor && isTTY() && !args.json;
  const results: FileResult[] = [];

  for (const file of args.files) {
    let raw: string;
    try {
      raw = readFileOrStdin(file);
    } catch (err) {
      results.push({
        file,
        okIntegrity: false,
        integrityError: `Cannot read file: ${(err as Error).message}`,
        okCompliance: undefined,
        skipped: true,
      });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      results.push({
        file,
        okIntegrity: false,
        integrityError: `File is not valid JSON: ${(err as Error).message}`,
        okCompliance: undefined,
      });
      continue;
    }

    const struct = validateStructure(parsed);
    if (!struct.ok) {
      results.push({
        file,
        okIntegrity: false,
        integrityError: struct.error,
        okCompliance: undefined,
        report: parsed as Report,
      });
      continue;
    }

    const report = parsed as Report;
    const integrity = verifyIntegrity(report);
    const okIntegrity = integrity.ok;
    let okCompliance: boolean | undefined = undefined;
    let complianceError: string | undefined = undefined;
    let violations: Report["metrics"]["violations"] | undefined = undefined;
    try {
      const comp = checkCompliance(report);
      okCompliance = comp.ok;
      violations = report.metrics.violations;
    } catch (err) {
      complianceError = (err as Error).message;
      okCompliance = undefined;
    }

    results.push({
      file,
      okIntegrity,
      integrityError: okIntegrity ? undefined : `hash mismatch - the report has been modified after export`,
      okCompliance,
      complianceError,
      report,
      expectedHash: integrity.expectedHash,
      storedHash: integrity.storedHash,
      authorshipPct: report.metrics.authorship.authorshipPercentage,
      ownershipScore: report.metrics.ownership.score,
      violations,
      exclusionAudit: Array.isArray(report.exclusionAudit) ? report.exclusionAudit : [],
      recommendations: normalizeRecommendations(report.recommendations),
    });
  }

  // Output
  if (args.json) {
    console.log(renderJson(results));
  } else if (args.quiet) {
    const total = results.length;
    const integrityFail = results.filter(r => !r.okIntegrity).length;
    const nonCompliant = results.filter(r => r.okCompliance === false).length;
    console.log(`Processed ${total} file(s): ${total - integrityFail} integrity OK, ${integrityFail} FAIL; ${nonCompliant} non-compliant`);
    for (const r of results.filter(r => !r.okIntegrity)) {
      console.error(`${r.file}: INTEGRITY FAIL - ${r.integrityError}`);
    }
  } else {
    console.log(renderHuman(results, { useColor, verbose: args.verbose }));
  }

  // Exit code
  const anyIntegrityFail = results.some(r => !r.okIntegrity);
  const anyNonCompliant = results.some(r => r.okCompliance === false);
  const anySkipped = results.some(r => r.skipped);
  if (anySkipped || args.files.length === 0) {
    // Skipped counts as integrity fail for exit
  }
  if (anyIntegrityFail) process.exit(1);
  if (args.strict && anyNonCompliant) process.exit(1);
  process.exit(0);
}

if (require.main === module) {
  main();
}

// `main` is exported so the exit-code and argument-parsing behavior can be
// tested directly - exit codes are the security-relevant contract of this
// verifier (1 = tampered/non-compliant, 2 = usage error), and asserting them
// through a spawned process alone is fragile.
export {
  canonicalize,
  verifyIntegrity,
  checkCompliance,
  validateStructure,
  main,
  parseArgs,
  renderHuman,
  renderJson,
};
