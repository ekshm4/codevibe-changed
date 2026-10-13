/**
 * AssignmentReportGenerator
 *
 * Builds the exportable AssignmentReport for a single assignment and seals it
 * with an integrity hash. The hash is sha256 over a canonical (key-sorted)
 * JSON serialization of every report field except `integrity` itself.
 *
 * A separate CLI (scripts/verify-assignment-report.js) re-implements the same
 * canonicalization independently and re-computes the hash, so a teacher can
 * detect any post-export tampering of authorship/ownership numbers.
 *
 * This module is intentionally free of vscode imports so it stays unit-testable
 * and reusable from commands, scripts, and tests.
 */

import { createHash } from "crypto";
import {
  Assignment,
  AssignmentMetrics,
  AssignmentReport,
  ExclusionAuditEntry,
} from "../types";
import { RecommendationEngine } from "./RecommendationEngine";

export interface GenerateReportOptions {
  studentIdentifier?: string;
  repoUrl?: string;
  repoHeadCommit?: string;
  /** Injectable clock for deterministic tests. Defaults to Date.now(). */
  generatedAt?: number;
  /** Exclusion audit entries inside the assignment window (tamper-evidence). */
  exclusionAudit?: ExclusionAuditEntry[];
}

export class AssignmentReportGenerator {
  /**
   * Canonical JSON serialization: object keys sorted recursively, array order
   * preserved, undefined/function values dropped like JSON.stringify does.
   * The CLI verifier implements this exact same algorithm independently.
   */
  static canonicalize(value: unknown): string | undefined {
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
        const serialized = AssignmentReportGenerator.canonicalize(item);
        return serialized === undefined ? "null" : serialized;
      });
      return "[" + items.join(",") + "]";
    }
    if (typeof value === "object") {
      const parts: string[] = [];
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        const serialized = AssignmentReportGenerator.canonicalize(
          (value as Record<string, unknown>)[key],
        );
        if (serialized !== undefined) {
          parts.push(JSON.stringify(key) + ":" + serialized);
        }
      }
      return "{" + parts.join(",") + "}";
    }
    return undefined; // undefined, functions, symbols
  }

  /**
   * sha256 hex over the canonical serialization of the SIGNED payload:
   * every report field except `integrity` and `generatedAt`.
   * `generatedAt` is export metadata - excluding it keeps the hash stable
   * across re-exports of unchanged metrics (same data, same report).
   */
  static computeIntegrityHash(
    report: Omit<AssignmentReport, "integrity"> | AssignmentReport,
  ): string {
    const signed: Record<string, unknown> = {
      ...(report as Record<string, unknown>),
    };
    delete signed.integrity;
    delete signed.generatedAt;
    const canonical = AssignmentReportGenerator.canonicalize(signed);
    return createHash("sha256")
      .update(canonical ?? "", "utf8")
      .digest("hex");
  }

  /**
   * Build a sealed AssignmentReport for one assignment from computed metrics.
   */
  generate(
    assignment: Assignment,
    metrics: AssignmentMetrics,
    options: GenerateReportOptions = {},
  ): AssignmentReport {
    const payload: Omit<AssignmentReport, "integrity"> = {
      reportVersion: "1.0",
      assignmentId: assignment.id,
      assignmentName: assignment.name,
      generatedAt: options.generatedAt ?? Date.now(),
      metrics,
      policy: assignment.policy,
      exclusionAudit: options.exclusionAudit ?? [],
      recommendations: RecommendationEngine.generate(metrics, assignment.policy),
      ...(options.studentIdentifier !== undefined
        ? { studentIdentifier: options.studentIdentifier }
        : {}),
      ...(options.repoUrl !== undefined ? { repoUrl: options.repoUrl } : {}),
      ...(options.repoHeadCommit !== undefined
        ? { repoHeadCommit: options.repoHeadCommit }
        : {}),
    };

    return {
      ...payload,
      integrity: {
        algorithm: "sha256",
        hash: AssignmentReportGenerator.computeIntegrityHash(payload),
      },
    };
  }

  /**
   * Recompute the integrity hash of a report and compare it to the stored one.
   * Returns true only if the report is well-formed and untampered.
   */
  verify(report: AssignmentReport): boolean {
    if (!report || typeof report !== "object" || !report.integrity) {
      return false;
    }
    const { integrity } = report;
    if (
      integrity.algorithm !== "sha256" ||
      typeof integrity.hash !== "string"
    ) {
      return false;
    }
    const expected = AssignmentReportGenerator.computeIntegrityHash(report);
    return expected === integrity.hash;
  }
}
