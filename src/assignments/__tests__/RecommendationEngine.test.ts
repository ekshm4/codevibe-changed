/**
 * RecommendationEngine tests.
 *
 * The output is sealed inside the report's integrity hash, so determinism
 * matters as much as the rules themselves: identical metrics must produce an
 * identical array, or re-exporting unchanged data would change the hash.
 */

import { RecommendationEngine } from '../RecommendationEngine';
import {
  AssignmentMetrics,
  AssignmentPolicy,
  PolicyViolation,
  PolicyViolationType,
} from '../../types';

function makePolicy(overrides: Partial<AssignmentPolicy> = {}): AssignmentPolicy {
  return {
    maxAuthorshipPercentage: 30,
    minOwnershipScore: 40,
    exemptFileGlobs: [],
    prohibitedMethods: [],
    permittedMethods: [],
    flaggedMethods: [],
    minLargePasteReviewTimeMs: 5000,
    maxTrackingGapSeconds: 1800,
    ...overrides,
  };
}

/** Clean, fully-compliant metrics. Each test perturbs only what it needs. */
function makeMetrics(overrides: {
  authorship?: Partial<AssignmentMetrics['authorship']>;
  ownership?: Partial<AssignmentMetrics['ownership']>;
  violations?: PolicyViolation[];
  trackingGaps?: AssignmentMetrics['trackingGaps'];
} = {}): AssignmentMetrics {
  return {
    assignmentId: 'a1',
    authorship: {
      totalLines: 100,
      manualLines: 100,
      permittedAILines: 0,
      prohibitedAILines: 0,
      flaggedAILines: 0,
      authorshipPercentage: 0,
      prohibitedPercentage: 0,
      ...overrides.authorship,
    },
    ownership: {
      score: 100,
      filesReviewed: 0,
      filesUnreviewed: 0,
      unreviewedLines: 0,
      averageReviewTimeMs: 0,
      ...overrides.ownership,
    },
    violations: overrides.violations ?? [],
    rawEvents: [],
    fileReviews: [],
    trackingGaps: overrides.trackingGaps ?? [],
  };
}

const ids = (metrics: AssignmentMetrics, policy = makePolicy()): string[] =>
  RecommendationEngine.generate(metrics, policy).map((r) => r.id);

describe('RecommendationEngine', () => {
  it('returns the healthy entry when nothing is wrong', () => {
    const recs = RecommendationEngine.generate(makeMetrics(), makePolicy());
    expect(recs).toHaveLength(1);
    expect(recs[0].id).toBe('healthy');
    expect(recs[0].severity).toBe('low');
  });

  it('always gives every entry a non-empty message and action', () => {
    const recs = RecommendationEngine.generate(
      makeMetrics({
        authorship: { prohibitedAILines: 10, prohibitedPercentage: 10, authorshipPercentage: 80 },
        ownership: { score: 5, filesReviewed: 1, filesUnreviewed: 2, unreviewedLines: 40 },
        trackingGaps: [{ startTime: 1, endTime: 2, durationSeconds: 3600 }],
      }),
      makePolicy(),
    );
    expect(recs.length).toBeGreaterThan(1);
    for (const rec of recs) {
      expect(typeof rec.id).toBe('string');
      expect(rec.id.length).toBeGreaterThan(0);
      expect(rec.message.length).toBeGreaterThan(0);
      expect(rec.action.length).toBeGreaterThan(0);
      expect(['low', 'medium', 'high']).toContain(rec.severity);
    }
  });

  it('flags prohibited AI use as high severity', () => {
    const recs = RecommendationEngine.generate(
      makeMetrics({
        authorship: { prohibitedAILines: 12, prohibitedPercentage: 12 },
      }),
      makePolicy(),
    );
    const rec = recs.find((r) => r.id === 'prohibited-ai-used');
    expect(rec).toBeDefined();
    expect(rec!.severity).toBe('high');
    expect(rec!.message).toContain('12');
  });

  it('flags authorship over the limit and not the near-limit warning', () => {
    const got = ids(
      makeMetrics({ authorship: { authorshipPercentage: 45 } }),
      makePolicy({ maxAuthorshipPercentage: 30 }),
    );
    expect(got).toContain('authorship-over-limit');
    expect(got).not.toContain('authorship-near-limit');
  });

  it('warns when authorship is near but under the limit', () => {
    const got = ids(
      makeMetrics({ authorship: { authorshipPercentage: 27 } }),
      makePolicy({ maxAuthorshipPercentage: 30 }),
    );
    expect(got).toContain('authorship-near-limit');
    expect(got).not.toContain('authorship-over-limit');
  });

  it('stays quiet about authorship when well under the limit', () => {
    const got = ids(
      makeMetrics({ authorship: { authorshipPercentage: 10 } }),
      makePolicy({ maxAuthorshipPercentage: 30 }),
    );
    expect(got).not.toContain('authorship-near-limit');
    expect(got).not.toContain('authorship-over-limit');
  });

  it('reuses the PolicyEngine violation message when one exists', () => {
    const violation: PolicyViolation = {
      type: PolicyViolationType.AuthorshipExceeded,
      severity: 'medium',
      message: 'AI authorship 45.0% exceeds limit of 30%',
      details: {},
      firstDetectedAt: 1,
      lastDetectedAt: 2,
      count: 1,
    };
    const recs = RecommendationEngine.generate(
      makeMetrics({
        authorship: { authorshipPercentage: 45 },
        violations: [violation],
      }),
      makePolicy({ maxAuthorshipPercentage: 30 }),
    );
    expect(recs.find((r) => r.id === 'authorship-over-limit')!.message).toBe(
      violation.message,
    );
  });

  it('flags ownership below the minimum when there are files behind the score', () => {
    const got = ids(
      makeMetrics({ ownership: { score: 10, filesReviewed: 1, filesUnreviewed: 1 } }),
      makePolicy({ minOwnershipScore: 40 }),
    );
    expect(got).toContain('ownership-below-minimum');
  });

  // Mirrors the totalFiles === 0 guard in checkCompliance: a zero ownership
  // score with no files means there was no AI code to review, not a failure.
  it('does not flag ownership when no files were considered', () => {
    const got = ids(
      makeMetrics({ ownership: { score: 0, filesReviewed: 0, filesUnreviewed: 0 } }),
      makePolicy({ minOwnershipScore: 40 }),
    );
    expect(got).not.toContain('ownership-below-minimum');
    expect(got).toEqual(['healthy']);
  });

  it('flags unreviewed files with their line count', () => {
    const recs = RecommendationEngine.generate(
      makeMetrics({
        ownership: { score: 100, filesReviewed: 1, filesUnreviewed: 3, unreviewedLines: 42 },
      }),
      makePolicy(),
    );
    const rec = recs.find((r) => r.id === 'unreviewed-files');
    expect(rec).toBeDefined();
    expect(rec!.message).toContain('3');
    expect(rec!.message).toContain('42');
  });

  it('flags tracking gaps at low severity', () => {
    const recs = RecommendationEngine.generate(
      makeMetrics({
        trackingGaps: [
          { startTime: 1, endTime: 2, durationSeconds: 3600 },
          { startTime: 3, endTime: 4, durationSeconds: 7200 },
        ],
      }),
      makePolicy(),
    );
    const rec = recs.find((r) => r.id === 'tracking-gaps');
    expect(rec).toBeDefined();
    expect(rec!.severity).toBe('low');
    expect(rec!.message).toContain('2');
  });

  it('drops the healthy entry once any real issue fires', () => {
    const got = ids(makeMetrics({ ownership: { filesUnreviewed: 1 } }));
    expect(got).not.toContain('healthy');
  });

  // The array is hashed as part of the report, so repeated generation over
  // unchanged metrics must be byte-identical.
  it('is deterministic across repeated calls', () => {
    const metrics = makeMetrics({
      authorship: { authorshipPercentage: 45, prohibitedAILines: 3, prohibitedPercentage: 3 },
      ownership: { score: 10, filesReviewed: 1, filesUnreviewed: 2, unreviewedLines: 20 },
      trackingGaps: [{ startTime: 1, endTime: 2, durationSeconds: 60 }],
    });
    const policy = makePolicy();
    const first = RecommendationEngine.generate(metrics, policy);
    const second = RecommendationEngine.generate(metrics, policy);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('orders entries by descending seriousness of the condition', () => {
    const got = ids(
      makeMetrics({
        authorship: { authorshipPercentage: 45, prohibitedAILines: 3, prohibitedPercentage: 3 },
        ownership: { score: 10, filesReviewed: 1, filesUnreviewed: 2, unreviewedLines: 20 },
        trackingGaps: [{ startTime: 1, endTime: 2, durationSeconds: 60 }],
      }),
    );
    expect(got).toEqual([
      'prohibited-ai-used',
      'authorship-over-limit',
      'ownership-below-minimum',
      'unreviewed-files',
      'tracking-gaps',
    ]);
  });
});
