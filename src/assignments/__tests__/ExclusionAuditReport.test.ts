/**
 * Exclusion audit report tests (tamper-evidence).
 *
 * The audit trail must be sealed by the integrity hash: any post-export
 * edit of the audit entries invalidates the report.
 */

import { AssignmentReportGenerator } from '../AssignmentReportGenerator';
import { AssignmentManager } from '../AssignmentManager';
import {
  Assignment,
  AssignmentMetrics,
} from '../../types';

function makeAssignment(): Assignment {
  const manager = new AssignmentManager(null as any);
  return {
    id: 'a1',
    name: 'HW1',
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    policy: manager.getDefaultPolicy(),
    createdAt: 1,
    updatedAt: 1,
    isActive: true,
  };
}

function makeMetrics(assignment: Assignment): AssignmentMetrics {
  return {
    assignmentId: assignment.id,
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
    rawEvents: [],
    fileReviews: [],
    trackingGaps: [],
  };
}

describe('ExclusionAuditReport', () => {
  it('embeds the audit trail and seals it with the integrity hash', () => {
    const generator = new AssignmentReportGenerator();
    const assignment = makeAssignment();
    const audit = [
      { timestamp: 1000, globs: ['**/src/**'], source: 'settings' },
      { timestamp: 2000, globs: [], source: 'assignment-activated' },
    ];

    const report = generator.generate(assignment, makeMetrics(assignment), {
      generatedAt: 9999,
      exclusionAudit: audit,
    });

    expect(report.exclusionAudit).toEqual(audit);
    expect(generator.verify(report)).toBe(true);
  });

  it('detects post-export tampering of the audit trail', () => {
    const generator = new AssignmentReportGenerator();
    const assignment = makeAssignment();

    const report = generator.generate(assignment, makeMetrics(assignment), {
      generatedAt: 9999,
      exclusionAudit: [
        { timestamp: 1000, globs: ['**/src/**'], source: 'settings' },
      ],
    });
    expect(generator.verify(report)).toBe(true);

    // Attacker removes the incriminating entry
    const tampered = {
      ...report,
      exclusionAudit: [],
    };
    expect(generator.verify(tampered)).toBe(false);
  });

  it('defaults to an empty audit trail', () => {
    const generator = new AssignmentReportGenerator();
    const assignment = makeAssignment();
    const report = generator.generate(assignment, makeMetrics(assignment), {
      generatedAt: 9999,
    });

    expect(report.exclusionAudit).toEqual([]);
    expect(generator.verify(report)).toBe(true);
  });

  it('records activation/deactivation markers in the audit trail', async () => {
    const recordExclusionAudit = jest.fn().mockResolvedValue(undefined);
    const mockRepo = {
      saveAssignment: jest.fn().mockResolvedValue(undefined),
      setActiveAssignment: jest.fn().mockResolvedValue(undefined),
      getAssignment: jest.fn().mockResolvedValue(makeAssignment()),
      recordExclusionAudit,
    } as any;

    const manager = new AssignmentManager(mockRepo);
    await manager.activateAssignment('a1');
    await manager.deactivateAssignment();

    expect(recordExclusionAudit).toHaveBeenCalledWith(
      expect.any(Number),
      [],
      'assignment-activated',
    );
    expect(recordExclusionAudit).toHaveBeenCalledWith(
      expect.any(Number),
      [],
      'assignment-deactivated',
    );
  });

});
