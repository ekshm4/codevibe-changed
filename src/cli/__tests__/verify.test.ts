/**
 * codevibe-verify exclusion-audit tests.
 *
 * The audit trail is part of the sealed payload: old reports without it
 * still verify, and new reports with it are tamper-evident.
 */

import {
  canonicalize,
  validateStructure,
  verifyIntegrity,
} from '../verify';

function makeReport(overrides: Record<string, unknown> = {}) {
  return {
    reportVersion: '1.0',
    assignmentId: 'a1',
    assignmentName: 'HW1',
    generatedAt: 9999,
    metrics: {
      authorship: {
        totalLines: 10,
        manualLines: 10,
        permittedAILines: 0,
        prohibitedAILines: 0,
        flaggedAILines: 0,
        authorshipPercentage: 0,
        prohibitedPercentage: 0,
      },
      ownership: {
        score: 100,
        filesReviewed: 0,
        filesUnreviewed: 0,
        unreviewedLines: 0,
        averageReviewTimeMs: 0,
      },
      violations: [],
    },
    policy: {
      maxAuthorshipPercentage: 30,
      minOwnershipScore: 40,
    },
    integrity: {
      algorithm: 'sha256',
      hash: '0'.repeat(64),
    },
    ...overrides,
  } as any;
}

function seal(report: any) {
  const payload: Record<string, unknown> = { ...report };
  delete payload.integrity;
  delete payload.generatedAt;
  const canonical = canonicalize(payload) ?? '';
  const { createHash } = require('crypto');
  const hash = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return { ...report, integrity: { algorithm: 'sha256', hash } };
}

describe('verify exclusion audit', () => {
  it('accepts reports with an audit trail and verifies integrity', () => {
    const report = seal(
      makeReport({
        exclusionAudit: [
          { timestamp: 1000, globs: ['**/src/**'], source: 'settings' },
          { timestamp: 2000, globs: [], source: 'assignment-activated' },
        ],
      }),
    );

    expect(validateStructure(report).ok).toBe(true);
    expect(verifyIntegrity(report).ok).toBe(true);
  });

  it('accepts legacy reports without an audit trail', () => {
    const report = seal(makeReport());

    expect(validateStructure(report).ok).toBe(true);
    expect(verifyIntegrity(report).ok).toBe(true);
  });

  it('fails integrity when the audit trail is stripped post-export', () => {
    const report = seal(
      makeReport({
        exclusionAudit: [
          { timestamp: 1000, globs: ['**/src/**'], source: 'settings' },
        ],
      }),
    );
    expect(verifyIntegrity(report).ok).toBe(true);

    const stripped = { ...report, exclusionAudit: [] };
    expect(verifyIntegrity(stripped).ok).toBe(false);
  });
});
