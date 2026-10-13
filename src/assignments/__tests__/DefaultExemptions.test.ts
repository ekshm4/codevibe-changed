/**
 * Default exemption coverage - generated/dependency dirs must be exempt
 * from assignment authorship even for pre-existing (pre-filter) events.
 */

import { AssignmentManager } from '../AssignmentManager';
import { PolicyEngine } from '../PolicyEngine';
import { CodeSource, EventType, AIClassification, AIDetectionMethod } from '../../types';

describe('default generated-dir exemptions', () => {
  const manager = new AssignmentManager(null as any);
  const engine = new PolicyEngine();

  it('default policy exempts node_modules, venv, and build outputs', () => {
    const policy = manager.getDefaultPolicy();
    for (const glob of [
      '**/node_modules/**',
      '**/venv/**',
      '**/.venv/**',
      '**/__pycache__/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
    ]) {
      expect(policy.exemptFileGlobs).toContain(glob);
    }
  });

  it('computeMetrics skips events in excluded paths', () => {
    const assignment = {
      id: 'a1',
      name: 'HW1',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      policy: manager.getDefaultPolicy(),
      createdAt: 1,
      updatedAt: 1,
      isActive: true,
    };
    const events: any[] = [
      {
        timestamp: 2,
        tool: 'ai',
        source: CodeSource.AI,
        eventType: EventType.CodeGenerated,
        linesOfCode: 1000,
        linesChanged: 1000,
        filePath: '/proj/node_modules/lodash/lodash.js',
        detectionMethod: AIDetectionMethod.ExternalFileChange,
        aiClassification: AIClassification.Prohibited,
      },
      {
        timestamp: 3,
        tool: 'ai',
        source: CodeSource.AI,
        eventType: EventType.CodeGenerated,
        linesOfCode: 10,
        linesChanged: 10,
        filePath: '/proj/src/app.ts',
        detectionMethod: AIDetectionMethod.ExternalFileChange,
        aiClassification: AIClassification.Prohibited,
      },
    ];
    const metrics = engine.computeMetrics(assignment as any, events, []);
    expect(metrics.authorship.totalLines).toBe(10);
    expect(metrics.authorship.prohibitedAILines).toBe(10);
  });
});
