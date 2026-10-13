/**
 * AIDetector regression tests for two defects:
 *
 * 1. selectBestResult() returned results[0] when nothing was detected, which
 *    mislabelled the detection method (usually LargePaste) on non-AI events.
 *    PolicyEngine.classifyEvent() keys off `method`, so that produced wrong
 *    policy classifications.
 * 2. The typing-velocity window was a single shared array across all files, so
 *    fast typing in one file inflated another's measured velocity and could
 *    flag an innocent keystroke as AI.
 */

import { AIDetector } from '../AIDetector';
import { AIDetectionMethod, CodeChangeEvent } from '../types';

function makeEvent(overrides: Partial<CodeChangeEvent> = {}): CodeChangeEvent {
  return {
    text: 'a',
    rangeLength: 0,
    timestamp: 1_000_000,
    documentUri: '/proj/a.ts',
    isActiveEditor: true,
    ...overrides,
  };
}

describe('AIDetector.selectBestResult honesty', () => {
  it('reports ChangeVelocity (not LargePaste) when nothing is detected', () => {
    const detector = new AIDetector();
    const result = detector.detect(makeEvent({ text: 'x', rangeLength: 0 }));

    expect(result.isAI).toBe(false);
    expect(result.method).toBe(AIDetectionMethod.ChangeVelocity);
  });

  it('never reports LargePaste for a plain single-char keystroke', () => {
    const detector = new AIDetector();
    for (let i = 0; i < 5; i++) {
      const result = detector.detect(
        makeEvent({ text: 'x', timestamp: 1_000_000 + i * 100 }),
      );
      expect(result.isAI).toBe(false);
      expect(result.method).not.toBe(AIDetectionMethod.LargePaste);
    }
  });

  it('still returns LargePaste when a large paste IS detected', () => {
    const detector = new AIDetector();
    const big = `function foo() { const x = 1; return x; }\n`.repeat(20);
    const result = detector.detect(
      makeEvent({ text: big, timestamp: 2_000_000 }),
    );

    expect(result.isAI).toBe(true);
    expect(result.method).toBe(AIDetectionMethod.LargePaste);
  });
});

describe('AIDetector per-file velocity isolation', () => {
  it('does not inherit velocity from another file', () => {
    const detector = new AIDetector();
    const base = 3_000_000;

    // File A: 600 fast chars in one burst -> high velocity in A
    const aResult = detector.detectFromVelocity(
      makeEvent({
        documentUri: '/proj/a.ts',
        text: 'x'.repeat(600),
        timestamp: base,
      }),
    );
    expect(aResult.isAI).toBe(true);
    expect(aResult.metadata.velocity).toBe(600);

    // File B: a single keystroke in the same millisecond window.
    // With the old shared window this inherited A's 600 chars and flagged.
    const bResult = detector.detectFromVelocity(
      makeEvent({
        documentUri: '/proj/b.ts',
        text: 'x',
        timestamp: base + 10,
      }),
    );
    expect(bResult.isAI).toBe(false);
    expect(bResult.metadata.velocity).toBe(1);
  });

  it('keeps accumulating velocity within the same file', () => {
    const detector = new AIDetector();
    const base = 4_000_000;

    detector.detectFromVelocity(
      makeEvent({ documentUri: '/proj/a.ts', text: 'x'.repeat(200), timestamp: base }),
    );
    const second = detector.detectFromVelocity(
      makeEvent({
        documentUri: '/proj/a.ts',
        text: 'x'.repeat(200),
        timestamp: base + 100,
      }),
    );

    // 400 chars in the 1s window -> 400 chars/sec, still under threshold
    expect(second.metadata.velocity).toBe(400);
    expect(second.isAI).toBe(false);
  });

  it('drops stale entries once the 1s window passes', () => {
    const detector = new AIDetector();
    const base = 5_000_000;

    detector.detectFromVelocity(
      makeEvent({ documentUri: '/proj/a.ts', text: 'x'.repeat(600), timestamp: base }),
    );
    const later = detector.detectFromVelocity(
      makeEvent({
        documentUri: '/proj/a.ts',
        text: 'x',
        timestamp: base + 1500,
      }),
    );

    expect(later.metadata.velocity).toBe(1);
    expect(later.isAI).toBe(false);
  });

  it('reset() clears every file window', () => {
    const detector = new AIDetector();
    const base = 6_000_000;

    detector.detectFromVelocity(
      makeEvent({ documentUri: '/proj/a.ts', text: 'x'.repeat(600), timestamp: base }),
    );
    detector.reset();

    const after = detector.detectFromVelocity(
      makeEvent({ documentUri: '/proj/a.ts', text: 'x', timestamp: base + 10 }),
    );
    expect(after.metadata.velocity).toBe(1);
  });

  it('bounds the number of tracked files', () => {
    const detector = new AIDetector();
    const base = 7_000_000;

    for (let i = 0; i < 150; i++) {
      detector.detectFromVelocity(
        makeEvent({ documentUri: `/proj/file${i}.ts`, text: 'x', timestamp: base + i }),
      );
    }

    const size = (detector as any).recentChangesByFile.size;
    expect(size).toBeLessThanOrEqual(100);
  });
});
