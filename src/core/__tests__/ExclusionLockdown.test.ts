/**
 * Exclusion lockdown tests (anti-evasion).
 *
 * While an assignment is active, student-supplied custom globs must be
 * ignored entirely; outside assignments they apply (sanitized).
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { MetricsCollector } from '../MetricsCollector';
import { MetricsRepository } from '../../storage/MetricsRepository';
import { ConfigManager } from '../../config/ConfigManager';
import { AssignmentManager } from '../../assignments/AssignmentManager';
import {
  TrackingEvent,
  AITool,
  EventType,
  CodeSource,
  DeveloperLevel,
  AlertFrequency,
} from '../../types';

jest.mock('vscode', () => ({
  window: {
    activeTextEditor: undefined,
    onDidChangeActiveTextEditor: jest.fn(() => ({ dispose: jest.fn() })),
    onDidChangeTextEditorVisibleRanges: jest.fn(() => ({ dispose: jest.fn() })),
    onDidChangeTextEditorSelection: jest.fn(() => ({ dispose: jest.fn() })),
  },
  workspace: {
    onDidChangeTextDocument: jest.fn(() => ({ dispose: jest.fn() })),
    onDidChangeConfiguration: jest.fn(() => ({ dispose: jest.fn() })),
    getConfiguration: jest.fn(() => ({ get: jest.fn(), update: jest.fn() })),
  },
  Uri: {
    file: (path: string) => ({ fsPath: path, scheme: 'file' }),
  },
}), { virtual: true });

describe('ExclusionLockdown', () => {
  let collector: MetricsCollector;
  let mockMetricsRepo: jest.Mocked<MetricsRepository>;
  let mockConfigManager: jest.Mocked<ConfigManager>;

  function makeEvent(filePath: string): TrackingEvent {
    return {
      timestamp: Date.now(),
      tool: AITool.ClaudeCode,
      source: CodeSource.AI,
      eventType: EventType.CodeGenerated,
      linesOfCode: 5,
      linesChanged: 5,
      charactersCount: 200,
      filePath,
      language: 'typescript',
      detectionMethod: 'external-file-change',
      confidence: 'high',
    };
  }

  function bufferLength(): number {
    return (collector as any).eventBuffer.length;
  }

  function emit(filePath: string): void {
    (collector as any).handleEvent(makeEvent(filePath));
  }

  beforeEach(() => {
    mockMetricsRepo = {
      saveFileReviewStatus: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      getActiveAssignment: jest.fn<() => Promise<null>>().mockResolvedValue(null),
    } as unknown as jest.Mocked<MetricsRepository>;

    mockConfigManager = {
      getConfig: jest.fn().mockReturnValue({
        experienceLevel: DeveloperLevel.Mid,
        blindApprovalThreshold: 2000,
        alertFrequency: AlertFrequency.Medium,
        enableGamification: false,
        anonymizePaths: true,
        trackedTools: { copilot: false, cursor: false, claudeCode: false },
        excludedGlobs: ['**/generated/**'],
        onboardingCompleted: false,
      }),
    } as unknown as jest.Mocked<ConfigManager>;

    collector = new MetricsCollector(mockMetricsRepo, mockConfigManager);
  });

  afterEach(async () => {
    await collector.dispose();
  });

  it('applies custom globs when no assignment is active', () => {
    expect(collector.getEffectiveExcludedGlobs()).toEqual(['**/generated/**']);

    emit('/proj/generated/types.ts');
    expect(bufferLength()).toBe(0);

    emit('/proj/src/app.ts');
    expect(bufferLength()).toBe(1);
  });

  it('ignores custom globs while an assignment is active (lockdown)', () => {
    const policy = new AssignmentManager(
      mockMetricsRepo as any,
    ).getDefaultPolicy();
    (collector as any).activeAssignment = {
      id: 'a1',
      name: 'HW1',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      policy,
      createdAt: 1,
      updatedAt: 1,
      isActive: true,
    };

    expect(collector.getEffectiveExcludedGlobs()).toEqual([]);

    // Student custom exclusion no longer hides source-adjacent code
    emit('/proj/generated/types.ts');
    expect(bufferLength()).toBe(1);

    // Built-in ignores still hold during lockdown
    emit('/proj/node_modules/pkg/index.js');
    expect(bufferLength()).toBe(1);
  });

  it('sanitizes universe patterns even outside assignments', () => {
    (mockConfigManager.getConfig as jest.Mock).mockReturnValue({
      experienceLevel: DeveloperLevel.Mid,
      excludedGlobs: ['**', '**/generated/**'],
      trackedTools: { copilot: false, cursor: false, claudeCode: false },
    });

    expect(collector.getEffectiveExcludedGlobs()).toEqual(['**/generated/**']);

    emit('/proj/src/app.ts');
    expect(bufferLength()).toBe(1);
  });
});
