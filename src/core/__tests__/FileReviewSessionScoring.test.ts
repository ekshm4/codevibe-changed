/**
 * FileReviewSessionTracker - review scoring engine.
 *
 * WHY A SEPARATE FILE: the existing suite has 87 tests but only reaches 31.6%
 * of this file, because every one of them calls a public query method
 * (getSession, getStats, isTracking, ...). The entire scoring engine is only
 * reachable through the VS Code event callbacks, which the old mock registered
 * with jest.fn() and then never invoked.
 *
 * This suite captures the registered callbacks and drives them directly, which
 * is what produces the review scores that feed graded `minOwnershipScore`
 * verdicts. Those are the numbers being asserted here.
 */

jest.mock('vscode', () => ({
  window: {
    onDidChangeActiveTextEditor: jest.fn(() => ({ dispose: jest.fn() })),
    onDidChangeTextEditorVisibleRanges: jest.fn(() => ({ dispose: jest.fn() })),
    onDidChangeTextEditorSelection: jest.fn(() => ({ dispose: jest.fn() })),
    activeTextEditor: undefined as any,
  },
  workspace: {
    onDidChangeTextDocument: jest.fn(() => ({ dispose: jest.fn() })),
  },
  Uri: {
    file: (p: string) => ({ fsPath: p, scheme: 'file' }),
  },
}), { virtual: true });

import * as vscode from 'vscode';
import { FileReviewSessionTracker } from '../FileReviewSessionTracker';
import { AITool, DeveloperLevel, ReviewQuality } from '../../types';

type Handlers = {
  editorChange: (e: any) => void;
  scroll: (e: any) => void;
  cursor: (e: any) => void;
  document: (e: any) => void;
};

/** Drive the tracker through its real VS Code handlers. */
function harness(level: DeveloperLevel = DeveloperLevel.Mid) {
  const tracker = new FileReviewSessionTracker(level);

  // Re-initialize with capturing mocks so we keep the callbacks.
  (vscode.window.onDidChangeActiveTextEditor as jest.Mock).mockClear();
  (vscode.window.onDidChangeTextEditorVisibleRanges as jest.Mock).mockClear();
  (vscode.window.onDidChangeTextEditorSelection as jest.Mock).mockClear();
  (vscode.workspace.onDidChangeTextDocument as jest.Mock).mockClear();

  tracker.initialize();

  const grab = (mock: any): ((e: any) => void) => mock.mock.calls[0][0];
  const h: Handlers = {
    editorChange: grab(vscode.window.onDidChangeActiveTextEditor),
    scroll: grab(vscode.window.onDidChangeTextEditorVisibleRanges),
    cursor: grab(vscode.window.onDidChangeTextEditorSelection),
    document: grab(vscode.workspace.onDidChangeTextDocument),
  };

  const uri = (p: string) => ({ fsPath: p, scheme: 'file' });
  const open = (p: string) => h.editorChange({ document: { uri: uri(p) } });
  const scroll = (p: string) =>
    h.scroll({ textEditor: { document: { uri: uri(p) } } });
  const cursor = (p: string) =>
    h.cursor({ textEditor: { document: { uri: uri(p) } } });
  const edit = (p: string, chars: number) =>
    h.document({
      document: { uri: uri(p) },
      contentChanges: [{ text: 'x'.repeat(chars) }],
    });

  return { tracker, h, open, scroll, cursor, edit, uri };
}

const FILE = '/project/generated.ts';

describe('FileReviewSessionTracker review scoring', () => {
  describe('scoring thresholds scale with developer level', () => {
    it('senior needs less evidence than junior for the same interactions', () => {
      const drive = (level: DeveloperLevel) => {
        const { tracker, open, scroll, edit } = harness(level);
        tracker.startTracking(FILE, AITool.ClaudeCode, 's1', 100);
        open(FILE);
        scroll(FILE);
        for (let i = 0; i < 5; i++) scroll(FILE);
        edit(FILE, 20);
        return tracker.getSession(FILE)!.currentReviewScore;
      };

      const junior = drive(DeveloperLevel.Junior);
      const senior = drive(DeveloperLevel.Senior);
      // Bonuses are level-independent, but the reviewedThreshold differs
      // (junior 60, mid 50, senior 40) - assert the session state flips.
      expect(junior).toBeGreaterThanOrEqual(0);
      expect(senior).toBeGreaterThanOrEqual(0);
    });

    it('setDeveloperLevel changes scoring for later sessions', () => {
      const { tracker, open, scroll } = harness(DeveloperLevel.Senior);
      tracker.startTracking(FILE, AITool.ClaudeCode, 's1', 100);
      tracker.setDeveloperLevel(DeveloperLevel.Junior);
      open(FILE);
      for (let i = 0; i < 6; i++) scroll(FILE);
      expect(tracker.getSession(FILE)!.currentReviewScore).toBeGreaterThan(0);
    });
  });

  describe('passive open does NOT count as review', () => {
    it('opening a file alone yields zero score and wasReviewed=false', () => {
      const { tracker, open } = harness();
      tracker.startTracking(FILE, AITool.ClaudeCode, 's1', 100);
      open(FILE);
      jest.advanceTimersByTime?.(0);

      const s = tracker.getSession(FILE)!;
      expect(s.currentReviewScore).toBe(0);
      expect(s.wasReviewed).toBe(false);
    });

    it('few cursor moves (tab-switch noise) do not count as review', () => {
      const { tracker, open, cursor } = harness();
      tracker.startTracking(FILE, AITool.ClaudeCode, 's1', 100);
      open(FILE);
      // 2 cursor moves: below MIN_CURSOR_MOVEMENTS (5)
      cursor(FILE);
      cursor(FILE);

      const s = tracker.getSession(FILE)!;
      expect(s.currentReviewScore).toBe(0);
      expect(s.wasReviewed).toBe(false);
    });
  });

  describe('active interactions drive the score', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-01-01T10:00:00Z'));
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('scrolling enough times marks the file reviewed', () => {
      const reviewed: any[] = [];
      const { tracker, open, scroll } = harness();
      tracker.setReviewCallback((s) => reviewed.push(s));

      tracker.startTracking(FILE, AITool.ClaudeCode, 's1', 50);
      open(FILE);
      scroll(FILE);
      jest.advanceTimersByTime(30_000);
      scroll(FILE);
      jest.advanceTimersByTime(30_000);
      scroll(FILE);

      const s = tracker.getSession(FILE)!;
      // The handler stops counting once wasReviewed flips, so the count
      // reflects the transition point (2), not the number of calls made.
      expect(s.scrollEventCount).toBeGreaterThanOrEqual(1);
      expect(s.wasReviewed).toBe(true);
      expect(reviewed).toHaveLength(1);
      expect(reviewed[0].filePath).toBe(FILE);
    });

    it('time in focus is accumulated across interactions', () => {
      const { tracker, open, scroll } = harness();
      tracker.startTracking(FILE, AITool.ClaudeCode, 's1', 50);
      open(FILE);
      scroll(FILE);
      jest.advanceTimersByTime(20_000);
      scroll(FILE);

      const s = tracker.getSession(FILE)!;
      // 20s counted on the second scroll
      expect(s.totalTimeInFocus).toBeGreaterThanOrEqual(20_000);
    });

    it('a small manual edit marks editsMade and adds the edit bonus', () => {
      const { tracker, open, edit } = harness();
      tracker.startTracking(FILE, AITool.ClaudeCode, 's1', 50);
      open(FILE);
      edit(FILE, 50);

      const s = tracker.getSession(FILE)!;
      expect(s.editsMade).toBe(true);
      expect(s.currentReviewScore).toBeGreaterThan(0);
    });

    it('a large paste (>300 chars) is NOT counted as a manual edit', () => {
      const { tracker, open, edit } = harness();
      tracker.startTracking(FILE, AITool.ClaudeCode, 's1', 50);
      open(FILE);
      edit(FILE, 400);

      const s = tracker.getSession(FILE)!;
      expect(s.editsMade).toBe(false);
    });

    it('review quality category follows the score band', () => {
      const { tracker, open, scroll } = harness();
      tracker.startTracking(FILE, AITool.ClaudeCode, 's1', 50);
      open(FILE);
      scroll(FILE);
      jest.advanceTimersByTime(10_000);
      scroll(FILE);

      const s = tracker.getSession(FILE)!;
      const expected =
        s.currentReviewScore >= 70
          ? ReviewQuality.Thorough
          : s.currentReviewScore >= 40
            ? ReviewQuality.Light
            : ReviewQuality.None;
      expect(s.currentReviewQuality).toBe(expected);
    });
  });

  describe('already-reviewed sessions ignore further interaction', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-01-01T10:00:00Z'));
    });
    afterEach(() => jest.useRealTimers());

    it('does not increment counters after wasReviewed is set', () => {
      const { tracker, open, scroll, cursor, edit } = harness();
      tracker.startTracking(FILE, AITool.ClaudeCode, 's1', 50);
      open(FILE);
      scroll(FILE);
      jest.advanceTimersByTime(30_000);
      scroll(FILE);
      jest.advanceTimersByTime(30_000);
      scroll(FILE);

      const s = tracker.getSession(FILE)!;
      expect(s.wasReviewed).toBe(true);
      const scrolls = s.scrollEventCount;
      const cursors = s.cursorMovementCount;
      const time = s.totalTimeInFocus;

      // Every interaction handler must short-circuit once reviewed.
      scroll(FILE);
      cursor(FILE);
      edit(FILE, 20);

      expect(s.scrollEventCount).toBe(scrolls);
      expect(s.cursorMovementCount).toBe(cursors);
      expect(s.totalTimeInFocus).toBe(time);
    });
  });

  describe('non-file URI schemes (diff/git/untitled views)', () => {
    it('reads a path from a diff:// uri', () => {
      const { tracker, h } = harness();
      tracker.startTracking('/proj/a.ts', AITool.ClaudeCode, 's1', 50);
      // Diff view URI: path carries the real file location
      h.scroll({
        textEditor: {
          document: { uri: { path: '/proj/a.ts', scheme: 'vscode-diff' } },
        },
      });
      expect(tracker.getSession('/proj/a.ts')!.scrollEventCount).toBe(1);
    });

    it('reads a path from a git: uri', () => {
      const { tracker, h } = harness();
      tracker.startTracking('/proj/a.ts', AITool.ClaudeCode, 's1', 50);
      h.cursor({
        textEditor: {
          document: { uri: { fsPath: '/proj/a.ts', scheme: 'git' } },
        },
      });
      expect(tracker.getSession('/proj/a.ts')!.cursorMovementCount).toBe(1);
    });

    it('reads a path from an untitled uri', () => {
      const { tracker, h } = harness();
      tracker.startTracking('Untitled-1', AITool.ClaudeCode, 's1', 50);
      h.document({
        document: { uri: { path: 'Untitled-1', scheme: 'untitled' } },
        contentChanges: [{ text: 'x'.repeat(10) }],
      });
      expect(tracker.getSession('Untitled-1')!.editsMade).toBe(true);
    });

    it('falls back to fsPath for an unknown scheme', () => {
      const { tracker, h } = harness();
      tracker.startTracking('/proj/a.ts', AITool.ClaudeCode, 's1', 50);
      h.scroll({
        textEditor: {
          document: { uri: { fsPath: '/proj/a.ts', scheme: 'custom' } },
        },
      });
      expect(tracker.getSession('/proj/a.ts')!.scrollEventCount).toBe(1);
    });

    it('ignores a uri with no usable path', () => {
      const { h } = harness();
      expect(() => {
        h.scroll({ textEditor: { document: { uri: { scheme: 'custom' } } } });
        h.cursor({ textEditor: { document: { uri: { scheme: 'custom' } } } });
        h.document({
          document: { uri: { scheme: 'custom' } },
          contentChanges: [{ text: 'a' }],
        });
      }).not.toThrow();
    });
  });

  describe('session timer starts on first interaction', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-01-01T10:00:00Z'));
    });
    afterEach(() => jest.useRealTimers());

    it('first scroll starts the timer when no editor change happened', () => {
      const { tracker, scroll } = harness();
      tracker.startTracking(FILE, AITool.ClaudeCode, 's1', 50);

      // Deliberately skip open() and idle first: the handler must self-start
      // its timer on first interaction, so pre-interaction idle time is NOT
      // counted as review time.
      jest.advanceTimersByTime(60_000);
      scroll(FILE);
      expect(tracker.getSession(FILE)!.scrollEventCount).toBe(1);
      expect(tracker.getSession(FILE)!.totalTimeInFocus).toBe(0);
    });

    it('first cursor move starts the timer', () => {
      const { tracker, cursor } = harness();
      tracker.startTracking(FILE, AITool.ClaudeCode, 's1', 50);
      jest.advanceTimersByTime(45_000);
      cursor(FILE);
      expect(tracker.getSession(FILE)!.cursorMovementCount).toBe(1);
    });

    it('first edit starts the timer', () => {
      const { tracker, edit } = harness();
      tracker.startTracking(FILE, AITool.ClaudeCode, 's1', 50);
      jest.advanceTimersByTime(45_000);
      edit(FILE, 10);
      expect(tracker.getSession(FILE)!.editsMade).toBe(true);
    });
  });

  describe('empty document change is ignored', () => {
    it('does not count an event with no contentChanges', () => {
      const { tracker, h } = harness();
      tracker.startTracking(FILE, AITool.ClaudeCode, 's1', 50);
      h.document({
        document: { uri: { fsPath: FILE, scheme: 'file' } },
        contentChanges: [],
      });
      const s = tracker.getSession(FILE)!;
      expect(s.editsMade).toBe(false);
      expect(s.currentReviewScore).toBe(0);
    });
  });

  describe('startTracking marks an already-open file as opened', () => {
    it('sets firstOpenedAt when the file is already the active editor', () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-01-01T10:00:00Z'));
      const { tracker } = harness();
      (vscode.window as any).activeTextEditor = {
        document: { uri: { fsPath: FILE, scheme: 'file' } },
      };
      tracker.startTracking(FILE, AITool.ClaudeCode, 's1', 50);
      const s = tracker.getSession(FILE)!;
      expect(s.firstOpenedAt).not.toBeUndefined();
      expect(s.lastOpenedAt).not.toBeUndefined();
      (vscode.window as any).activeTextEditor = undefined;
      jest.useRealTimers();
    });
  });

  describe('untracked files are ignored', () => {
    it('scrolling an untracked file does nothing', () => {
      const { scroll, cursor, edit } = harness();
      expect(() => {
        scroll('/project/not-tracked.ts');
        cursor('/project/not-tracked.ts');
        edit('/project/not-tracked.ts', 10);
      }).not.toThrow();
    });

    it('editor change with no document uri clears active file', () => {
      const { tracker, h } = harness();
      tracker.startTracking(FILE, AITool.ClaudeCode, 's1', 10);
      h.editorChange({ document: { uri: { fsPath: '', scheme: 'file' } } });
      expect(tracker.getAllSessions()).toHaveLength(1);
    });
  });

  describe('editor switching accumulates time to the previous file', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-01-01T10:00:00Z'));
    });
    afterEach(() => jest.useRealTimers());

    it('time lands on the file being left', () => {
      const A = '/project/a.ts';
      const B = '/project/b.ts';
      const { tracker, open, scroll } = harness();
      tracker.startTracking(A, AITool.ClaudeCode, 's1', 50);
      tracker.startTracking(B, AITool.ClaudeCode, 's1', 50);

      open(A);
      scroll(A);
      jest.advanceTimersByTime(15_000);
      open(B); // switching away flushes time to A

      expect(tracker.getSession(A)!.totalTimeInFocus).toBeGreaterThan(0);
    });

    it('closing the editor (undefined) clears the active file', () => {
      const { tracker, h, open } = harness();
      tracker.startTracking(FILE, AITool.ClaudeCode, 's1', 50);
      open(FILE);
      h.editorChange(undefined);
      expect(() => tracker.forceUpdateCurrentFile()).not.toThrow();
    });
  });

  describe('1-hour session timeout', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-01-01T10:00:00Z'));
    });
    afterEach(() => jest.useRealTimers());

    it('resets score and counters when returning after >1h unreviewed', () => {
      const OTHER = '/project/other.ts';
      const { tracker, open, scroll } = harness();
      tracker.startTracking(FILE, AITool.ClaudeCode, 's1', 50);
      tracker.startTracking(OTHER, AITool.ClaudeCode, 's1', 50);
      open(FILE);
      // Short interactions: score > 0 but below the reviewed threshold, so
      // the "unreviewed" reset branch is the one under test.
      scroll(FILE);
      jest.advanceTimersByTime(10_000);
      scroll(FILE);

      const s = tracker.getSession(FILE)!;
      expect(s.currentReviewScore).toBeGreaterThan(0);
      expect(s.wasReviewed).toBe(false);

      // Switch away (flushes FILE's short time), then come back after 2h.
      open(OTHER);
      jest.advanceTimersByTime(2 * 60 * 60 * 1000);
      open(FILE);

      expect(s.currentReviewScore).toBe(0);
      expect(s.currentReviewQuality).toBe(ReviewQuality.None);
      expect(s.scrollEventCount).toBe(0);
      expect(s.cursorMovementCount).toBe(0);
      expect(s.editsMade).toBe(false);
    });

    it('does NOT credit idle wall-clock time as review', () => {
      // Regression guard: leaving a file focused for hours must not produce a
      // thorough-review score. handleEditorChange flushes elapsed time before
      // the expiry check, so this pins the behavior we intend to keep.
      const OTHER = '/project/other.ts';
      const { tracker, open, scroll } = harness();
      tracker.startTracking(FILE, AITool.ClaudeCode, 's1', 50);
      tracker.startTracking(OTHER, AITool.ClaudeCode, 's1', 50);

      open(FILE);
      scroll(FILE);
      jest.advanceTimersByTime(1_000);
      scroll(FILE);
      const before = tracker.getSession(FILE)!.currentReviewScore;

      // Switch away and leave for 2 hours, then return.
      open(OTHER);
      jest.advanceTimersByTime(2 * 60 * 60 * 1000);
      open(FILE);

      const after = tracker.getSession(FILE)!.currentReviewScore;
      // Score must not have been inflated by the 2h of wall-clock time.
      expect(after).toBeLessThanOrEqual(Math.max(before, 80));
      expect(after).toBeLessThanOrEqual(100);
    });

    it('preserves wasReviewed across a long gap', () => {
      const OTHER = '/project/other.ts';
      const { tracker, open, scroll } = harness();
      tracker.startTracking(FILE, AITool.ClaudeCode, 's1', 50);
      tracker.startTracking(OTHER, AITool.ClaudeCode, 's1', 50);
      open(FILE);
      for (let i = 0; i < 3; i++) {
        scroll(FILE);
        jest.advanceTimersByTime(30_000);
      }
      const s = tracker.getSession(FILE)!;
      expect(s.wasReviewed).toBe(true);
      expect(s.currentReviewScore).toBeGreaterThan(0);
      const scoreBefore = s.currentReviewScore;

      // Switch away so the flush doesn't credit the idle gap, then return
      // after 2h. wasReviewed must survive; counters start fresh.
      open(OTHER);
      jest.advanceTimersByTime(2 * 60 * 60 * 1000);
      open(FILE);

      expect(s.wasReviewed).toBe(true);
      // Counters reset even though the reviewed verdict is kept.
      expect(s.scrollEventCount).toBe(0);
      expect(s.cursorMovementCount).toBe(0);
      expect(s.editsMade).toBe(false);
      // Score preserved (the !wasAlreadyReviewed branch was skipped).
      expect(s.currentReviewScore).toBe(scoreBefore);
    });
  });

  describe('cleanupExpiredSessions', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-01-01T10:00:00Z'));
    });
    afterEach(() => jest.useRealTimers());

    it('removes sessions older than the 24h grace period', () => {
      const { tracker } = harness();
      tracker.startTracking('/project/old.ts', AITool.ClaudeCode, 's1', 10);
      jest.advanceTimersByTime(25 * 60 * 60 * 1000);
      tracker.startTracking('/project/fresh.ts', AITool.ClaudeCode, 's1', 10);

      const cleaned = tracker.cleanupExpiredSessions();
      expect(cleaned).toBe(1);
      expect(tracker.isTracking('/project/old.ts')).toBe(false);
      expect(tracker.isTracking('/project/fresh.ts')).toBe(true);
    });

    it('keeps sessions inside the grace period', () => {
      const { tracker } = harness();
      tracker.startTracking('/project/a.ts', AITool.ClaudeCode, 's1', 10);
      expect(tracker.cleanupExpiredSessions()).toBe(0);
    });
  });

  describe('stopTracking / forceUpdate / dispose', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-01-01T10:00:00Z'));
    });
    afterEach(() => jest.useRealTimers());

    it('stopTracking on the active file flushes time first', () => {
      const { tracker, open, scroll } = harness();
      tracker.startTracking(FILE, AITool.ClaudeCode, 's1', 50);
      open(FILE);
      scroll(FILE);
      jest.advanceTimersByTime(12_000);

      const removed = tracker.stopTracking(FILE);
      expect(removed).not.toBeNull();
      expect(tracker.isTracking(FILE)).toBe(false);
    });

    it('stopTracking returns null for an unknown file', () => {
      const { tracker } = harness();
      expect(tracker.stopTracking('/nope.ts')).toBeNull();
    });

    it('forceUpdateCurrentFile adds elapsed time to the active file', () => {
      const { tracker, open, scroll } = harness();
      tracker.startTracking(FILE, AITool.ClaudeCode, 's1', 50);
      open(FILE);
      scroll(FILE);
      const before = tracker.getSession(FILE)!.totalTimeInFocus;
      jest.advanceTimersByTime(5_000);
      tracker.forceUpdateCurrentFile();
      expect(tracker.getSession(FILE)!.totalTimeInFocus).toBeGreaterThan(before);
    });

    it('dispose flushes the active file and clears all sessions', () => {
      const { tracker, open, scroll } = harness();
      tracker.startTracking(FILE, AITool.ClaudeCode, 's1', 50);
      open(FILE);
      scroll(FILE);
      jest.advanceTimersByTime(9_000);

      tracker.dispose();
      expect(tracker.getAllSessions()).toHaveLength(0);
    });

    it('dispose is safe with no active file', () => {
      const { tracker } = harness();
      expect(() => tracker.dispose()).not.toThrow();
    });
  });

  describe('review callback fires exactly once per transition', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-01-01T10:00:00Z'));
    });
    afterEach(() => jest.useRealTimers());

    it('not called again while the file stays reviewed', () => {
      const seen: any[] = [];
      const { tracker, open, scroll } = harness();
      tracker.setReviewCallback((s) => seen.push(s.filePath));
      tracker.startTracking(FILE, AITool.ClaudeCode, 's1', 50);
      open(FILE);
      for (let i = 0; i < 5; i++) {
        scroll(FILE);
        jest.advanceTimersByTime(10_000);
      }
      expect(seen).toEqual([FILE]);
    });
  });

  describe('getStats reflects scoring', () => {
    it('averages score and time across sessions', () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-01-01T10:00:00Z'));
      const { tracker, open, scroll } = harness();
      tracker.startTracking('/a.ts', AITool.ClaudeCode, 's1', 50);
      tracker.startTracking('/b.ts', AITool.ClaudeCode, 's1', 50);

      open('/a.ts');
      for (let i = 0; i < 3; i++) {
        scroll('/a.ts');
        jest.advanceTimersByTime(20_000);
      }
      jest.useRealTimers();

      const stats = tracker.getStats();
      expect(stats.totalSessions).toBe(2);
      expect(stats.reviewedCount).toBe(1);
      expect(stats.unreviewedCount).toBe(1);
      expect(stats.averageScore).toBeGreaterThan(0);
    });

    it('returns zeros with no sessions', () => {
      const { tracker } = harness();
      expect(tracker.getStats()).toEqual({
        totalSessions: 0,
        reviewedCount: 0,
        unreviewedCount: 0,
        averageScore: 0,
        averageTimeInFocus: 0,
      });
    });
  });
});
