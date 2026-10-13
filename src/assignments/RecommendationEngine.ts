/**
 * RecommendationEngine
 *
 * Turns computed assignment metrics into actionable guidance: what the numbers
 * show, and what the student should do about it. The output is embedded in the
 * exported AssignmentReport and sealed by its integrity hash, so the advice a
 * student received is part of the tamper-evident record.
 *
 * MUST stay deterministic - no Date.now(), no randomness, no reordering. Two
 * runs over the same metrics have to produce byte-identical output or the
 * report's integrity hash changes between re-exports of unchanged data
 * (see AssignmentReportGenerator.computeIntegrityHash).
 *
 * Free of vscode imports so it stays unit-testable, matching PolicyEngine and
 * AssignmentReportGenerator.
 */

import {
  AssignmentMetrics,
  AssignmentPolicy,
  PolicyViolation,
  PolicyViolationType,
  Recommendation,
} from "../types";

/**
 * How close to the authorship ceiling counts as "nearly there".
 *
 * ponytail: fixed 5-point margin, make it a policy field if instructors want
 * to tune when the warning starts.
 */
const NEAR_LIMIT_MARGIN = 5;

export class RecommendationEngine {
  /**
   * Build the recommendation list for one assignment.
   *
   * Rules are evaluated in a fixed order and each contributes at most one
   * entry, so the array order is stable for a given set of metrics. When
   * PolicyEngine already produced a violation for the same condition, its
   * message is reused verbatim rather than reformatted - one source of truth
   * for the numbers a student sees.
   */
  static generate(
    metrics: AssignmentMetrics,
    policy: AssignmentPolicy,
  ): Recommendation[] {
    const recommendations: Recommendation[] = [];
    const { authorship, ownership } = metrics;

    const violationOf = (type: PolicyViolationType): PolicyViolation | undefined =>
      metrics.violations.find((violation) => violation.type === type);

    // Prohibited AI is the most serious finding: it is not a threshold miss,
    // it is use of a method the assignment forbids outright.
    if (authorship.prohibitedAILines > 0) {
      const violation = violationOf(PolicyViolationType.AgenticUse);
      recommendations.push({
        id: "prohibited-ai-used",
        severity: "high",
        message:
          violation?.message ??
          `${authorship.prohibitedAILines} line(s) came from AI methods this assignment prohibits (${authorship.prohibitedPercentage.toFixed(1)}% of your code).`,
        action:
          "Rewrite those sections yourself. Prohibited methods are disallowed regardless of how much you review them.",
      });
    }

    if (authorship.authorshipPercentage > policy.maxAuthorshipPercentage) {
      const violation = violationOf(PolicyViolationType.AuthorshipExceeded);
      recommendations.push({
        id: "authorship-over-limit",
        severity: "high",
        message:
          violation?.message ??
          `AI authorship ${authorship.authorshipPercentage.toFixed(1)}% exceeds limit of ${policy.maxAuthorshipPercentage}%`,
        action:
          "Write more manual code to practice fundamentals and maintain skills. Replacing AI-written sections with your own lowers this percentage.",
      });
    } else if (
      authorship.authorshipPercentage >=
      policy.maxAuthorshipPercentage - NEAR_LIMIT_MARGIN
    ) {
      recommendations.push({
        id: "authorship-near-limit",
        severity: "medium",
        message: `AI authorship is ${authorship.authorshipPercentage.toFixed(1)}%, close to the ${policy.maxAuthorshipPercentage}% limit.`,
        action:
          "Write the remaining work by hand to stay under the limit before the deadline.",
      });
    }

    // An ownership score with no files behind it is not a failure - it means
    // there was no AI code to review. Same guard as checkCompliance in the CLI.
    const filesConsidered = ownership.filesReviewed + ownership.filesUnreviewed;
    if (filesConsidered > 0 && ownership.score < policy.minOwnershipScore) {
      const violation = violationOf(PolicyViolationType.OwnershipBelowMinimum);
      recommendations.push({
        id: "ownership-below-minimum",
        severity: "high",
        message:
          violation?.message ??
          `Ownership score ${ownership.score.toFixed(1)} is below minimum ${policy.minOwnershipScore}`,
        action:
          "Read through the AI-generated code and revise it in your own words. Ownership rises as you spend real time reviewing what you accepted.",
      });
    }

    if (ownership.filesUnreviewed > 0) {
      recommendations.push({
        id: "unreviewed-files",
        severity: "medium",
        message: `${ownership.filesUnreviewed} file(s) containing ${ownership.unreviewedLines} AI-written line(s) were never reviewed.`,
        action:
          "Open each one and read it before submitting. Unreviewed AI code is the clearest sign of work you cannot explain.",
      });
    }

    if (metrics.trackingGaps.length > 0) {
      recommendations.push({
        id: "tracking-gaps",
        severity: "low",
        message: `${metrics.trackingGaps.length} period(s) of coding activity went untracked.`,
        action:
          "Keep VS Code open with CodeVibe enabled while you work, so your manual coding is credited to you.",
      });
    }

    if (recommendations.length === 0) {
      recommendations.push({
        id: "healthy",
        severity: "low",
        message:
          "Your AI usage and review habits are within this assignment's policy.",
        action:
          "Keep writing code manually first and reviewing anything AI produces before accepting it.",
      });
    }

    return recommendations;
  }
}
