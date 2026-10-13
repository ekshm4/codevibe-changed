/**
 * FileReviewTracker tests.
 *
 * Covers the query/aggregation surface that the dashboard and the graded
 * ownership metrics read from: filtering, stats, review-priority ordering,
 * grouping, and import/export round-trips.
 */

import { FileReviewTracker } from '../FileReviewTracker';
import {
  AITool,
  FileReviewStatus,
  ReviewQuality,
} from '../../types';

const TODAY = '2026-01-15';

function makeStatus(over: Partial<FileReviewStatus> = {}): FileReviewStatus {
  return {
    filePath: '/proj/src/a.ts',
    date: TODAY,
    tool: AITool.ClaudeCode,
    reviewQuality: ReviewQuality.None,
    reviewScore: 0,
    isReviewed: false,
    linesGenerated: 100,
    linesChanged: 100,
    linesSinceReview: 100,
    charactersCount: 4000,
    isAgentGenerated: true,
    wasFileOpen: false,
    firstGeneratedAt: 1_700_000_000_000,
    totalReviewTime: 0,
    modificationCount: 1,
    totalTimeInFocus: 0,
    scrollEventCount: 0,
    cursorMovementCount: 0,
    editsMade: false,
    reviewSessionsCount: 0,
    reviewedInTerminal: false,
    ...over,
  };
}

describe('FileReviewTracker', () => {
  let tracker: FileReviewTracker;

  beforeEach(() => {
    tracker = new FileReviewTracker();
  });

  describe('trackFile / getFileStatus', () => {
    it('stores and retrieves by (path, date, tool)', () => {
      tracker.trackFile(makeStatus());
      const got = tracker.getFileStatus('/proj/src/a.ts', TODAY, AITool.ClaudeCode);
      expect(got?.filePath).toBe('/proj/src/a.ts');
    });

    it('treats a different tool as a different entry', () => {
      tracker.trackFile(makeStatus({ tool: AITool.ClaudeCode }));
      expect(tracker.getFileStatus('/proj/src/a.ts', TODAY, AITool.Copilot)).toBeNull();
      expect(tracker.getFileStatus('/proj/src/a.ts', TODAY, AITool.ClaudeCode)).not.toBeNull();
    });

    it('treats a different date as a different entry', () => {
      tracker.trackFile(makeStatus({ date: TODAY }));
      expect(tracker.getFileStatus('/proj/src/a.ts', '2026-01-16', AITool.ClaudeCode)).toBeNull();
    });

    it('returns null for an untracked file', () => {
      expect(tracker.getFileStatus('/nope.ts', TODAY, AITool.ClaudeCode)).toBeNull();
    });

    it('overwrites on repeated trackFile for the same key', () => {
      tracker.trackFile(makeStatus({ linesGenerated: 10 }));
      tracker.trackFile(makeStatus({ linesGenerated: 99 }));
      expect(tracker.getFileCount()).toBe(1);
      expect(tracker.getFileStatus('/proj/src/a.ts', TODAY, AITool.ClaudeCode)!.linesGenerated).toBe(99);
    });
  });

  describe('updateFileStatus', () => {
    it('merges partial updates', () => {
      tracker.trackFile(makeStatus({ reviewScore: 20 }));
      tracker.updateFileStatus('/proj/src/a.ts', TODAY, AITool.ClaudeCode, {
        reviewScore: 80,
        isReviewed: true,
      });
      const s = tracker.getFileStatus('/proj/src/a.ts', TODAY, AITool.ClaudeCode)!;
      expect(s.reviewScore).toBe(80);
      expect(s.isReviewed).toBe(true);
      // Untouched fields survive
      expect(s.linesGenerated).toBe(100);
    });

    it('is a no-op for an untracked file', () => {
      tracker.updateFileStatus('/nope.ts', TODAY, AITool.ClaudeCode, { reviewScore: 5 });
      expect(tracker.getFileCount()).toBe(0);
    });
  });

  describe('markAsReviewed', () => {
    it('sets isReviewed, quality, score and a timestamp', () => {
      tracker.trackFile(makeStatus());
      tracker.markAsReviewed('/proj/src/a.ts', TODAY, AITool.ClaudeCode, ReviewQuality.Thorough, 95);

      const s = tracker.getFileStatus('/proj/src/a.ts', TODAY, AITool.ClaudeCode)!;
      expect(s.isReviewed).toBe(true);
      expect(s.reviewQuality).toBe(ReviewQuality.Thorough);
      expect(s.reviewScore).toBe(95);
      expect(s.lastReviewedAt).toBeGreaterThan(0);
    });

    it('is a no-op for an untracked file', () => {
      expect(() =>
        tracker.markAsReviewed('/nope.ts', TODAY, AITool.ClaudeCode, ReviewQuality.Light, 50),
      ).not.toThrow();
    });
  });

  describe('queryFiles filters', () => {
    beforeEach(() => {
      tracker.trackFile(makeStatus({ filePath: '/a.ts', date: TODAY, tool: AITool.ClaudeCode, reviewScore: 90, isReviewed: true, reviewQuality: ReviewQuality.Thorough, linesGenerated: 10 }));
      tracker.trackFile(makeStatus({ filePath: '/b.ts', date: '2026-01-16', tool: AITool.Copilot, reviewScore: 20, isReviewed: false, reviewQuality: ReviewQuality.None, linesGenerated: 200 }));
      tracker.trackFile(makeStatus({ filePath: '/c.ts', date: TODAY, tool: AITool.Cursor, reviewScore: 50, isReviewed: true, reviewQuality: ReviewQuality.Light, linesGenerated: 50 }));
    });

    it('returns everything with no query', () => {
      expect(tracker.queryFiles()).toHaveLength(3);
    });

    it('filters by date', () => {
      const r = tracker.queryFiles({ date: TODAY });
      expect(r.map(f => f.filePath).sort()).toEqual(['/a.ts', '/c.ts']);
    });

    it('filters by tool', () => {
      const r = tracker.queryFiles({ tool: AITool.Copilot });
      expect(r).toHaveLength(1);
      expect(r[0].filePath).toBe('/b.ts');
    });

    it('filters by isReviewed true', () => {
      expect(tracker.getReviewedFiles().map(f => f.filePath).sort()).toEqual(['/a.ts', '/c.ts']);
    });

    it('filters by isReviewed false', () => {
      expect(tracker.getUnreviewedFiles().map(f => f.filePath)).toEqual(['/b.ts']);
    });

    it('filters by minScore', () => {
      expect(tracker.queryFiles({ minScore: 60 }).map(f => f.filePath)).toEqual(['/a.ts']);
    });

    it('filters by maxScore', () => {
      expect(tracker.queryFiles({ maxScore: 40 }).map(f => f.filePath)).toEqual(['/b.ts']);
    });

    it('combines filters', () => {
      const r = tracker.queryFiles({ date: TODAY, isReviewed: true, minScore: 60 });
      expect(r.map(f => f.filePath)).toEqual(['/a.ts']);
    });

    it('accepts a partial query from getUnreviewedFiles', () => {
      const r = tracker.getUnreviewedFiles({ date: '2026-01-16' });
      expect(r).toHaveLength(1);
    });
  });

  describe('getAgentSessionFiles / getFileHistory', () => {
    it('groups by agentSessionId', () => {
      tracker.trackFile(makeStatus({ filePath: '/a.ts', agentSessionId: 's1' }));
      tracker.trackFile(makeStatus({ filePath: '/b.ts', agentSessionId: 's2' }));
      expect(tracker.getAgentSessionFiles('s1').map(f => f.filePath)).toEqual(['/a.ts']);
    });

    it('returns history newest first', () => {
      tracker.trackFile(makeStatus({ filePath: '/a.ts', date: '2026-01-01', firstGeneratedAt: 1000 }));
      tracker.trackFile(makeStatus({ filePath: '/a.ts', date: '2026-01-03', firstGeneratedAt: 3000 }));
      tracker.trackFile(makeStatus({ filePath: '/a.ts', date: '2026-01-02', firstGeneratedAt: 2000 }));
      const h = tracker.getFileHistory('/a.ts');
      expect(h.map(f => f.date)).toEqual(['2026-01-03', '2026-01-02', '2026-01-01']);
    });

    it('returns an empty history for an unknown file', () => {
      expect(tracker.getFileHistory('/nope.ts')).toEqual([]);
    });
  });

  describe('getStats', () => {
    it('returns zeros with no files', () => {
      expect(tracker.getStats()).toEqual({
        totalFiles: 0,
        reviewedFiles: 0,
        unreviewedFiles: 0,
        averageScore: 0,
        thoroughCount: 0,
        lightCount: 0,
        noneCount: 0,
        totalLines: 0,
        reviewedLines: 0,
        unreviewedLines: 0,
      });
    });

    it('aggregates counts, lines, scores and quality bands', () => {
      tracker.trackFile(makeStatus({ filePath: '/a.ts', reviewScore: 100, isReviewed: true, reviewQuality: ReviewQuality.Thorough, linesGenerated: 10 }));
      tracker.trackFile(makeStatus({ filePath: '/b.ts', reviewScore: 40, isReviewed: true, reviewQuality: ReviewQuality.Light, linesGenerated: 20 }));
      tracker.trackFile(makeStatus({ filePath: '/c.ts', reviewScore: 0, isReviewed: false, reviewQuality: ReviewQuality.None, linesGenerated: 70 }));

      const s = tracker.getStats();
      expect(s.totalFiles).toBe(3);
      expect(s.reviewedFiles).toBe(2);
      expect(s.unreviewedFiles).toBe(1);
      expect(s.totalLines).toBe(100);
      expect(s.reviewedLines).toBe(30);
      expect(s.unreviewedLines).toBe(70);
      expect(s.averageScore).toBe(47); // (100+40+0)/3
      expect(s.thoroughCount).toBe(1);
      expect(s.lightCount).toBe(1);
      expect(s.noneCount).toBe(1);
    });

    it('honors a query filter', () => {
      tracker.trackFile(makeStatus({ filePath: '/a.ts', date: TODAY, linesGenerated: 10 }));
      tracker.trackFile(makeStatus({ filePath: '/b.ts', date: '2026-01-16', linesGenerated: 90 }));
      expect(tracker.getStats({ date: TODAY }).totalLines).toBe(10);
    });
  });

  describe('getFilesNeedingReview', () => {
    it('includes unreviewed and light/none-quality files only', () => {
      tracker.trackFile(makeStatus({ filePath: '/thorough.ts', isReviewed: true, reviewQuality: ReviewQuality.Thorough, reviewScore: 90 }));
      tracker.trackFile(makeStatus({ filePath: '/light.ts', isReviewed: true, reviewQuality: ReviewQuality.Light }));
      tracker.trackFile(makeStatus({ filePath: '/unreviewed.ts', isReviewed: false, reviewQuality: ReviewQuality.None }));

      const r = tracker.getFilesNeedingReview();
      expect(r.map(f => f.filePath).sort()).toEqual(['/light.ts', '/unreviewed.ts']);
    });

    it('sorts unreviewed above reviewed-but-light', () => {
      tracker.trackFile(makeStatus({ filePath: '/light.ts', isReviewed: true, reviewQuality: ReviewQuality.Light, linesGenerated: 5 }));
      tracker.trackFile(makeStatus({ filePath: '/unreviewed.ts', isReviewed: false, reviewQuality: ReviewQuality.None, linesGenerated: 5 }));

      const r = tracker.getFilesNeedingReview();
      expect(r[0].filePath).toBe('/unreviewed.ts');
    });

    it('ranks larger and older files higher among equals', () => {
      const now = Date.now();
      tracker.trackFile(makeStatus({ filePath: '/small-new.ts', isReviewed: false, linesGenerated: 1, firstGeneratedAt: now }));
      tracker.trackFile(makeStatus({ filePath: '/big-old.ts', isReviewed: false, linesGenerated: 5000, firstGeneratedAt: now - 5 * 60 * 60 * 1000 }));

      const r = tracker.getFilesNeedingReview();
      expect(r[0].filePath).toBe('/big-old.ts');
    });

    it('filters by date when provided', () => {
      tracker.trackFile(makeStatus({ filePath: '/today.ts', date: TODAY, isReviewed: false }));
      tracker.trackFile(makeStatus({ filePath: '/other.ts', date: '2026-01-16', isReviewed: false }));
      expect(tracker.getFilesNeedingReview(TODAY).map(f => f.filePath)).toEqual(['/today.ts']);
    });

    it('returns empty when nothing needs review', () => {
      tracker.trackFile(makeStatus({ isReviewed: true, reviewQuality: ReviewQuality.Thorough }));
      expect(tracker.getFilesNeedingReview()).toEqual([]);
    });
  });

  describe('grouping helpers', () => {
    beforeEach(() => {
      tracker.trackFile(makeStatus({ filePath: '/t.ts', reviewQuality: ReviewQuality.Thorough }));
      tracker.trackFile(makeStatus({ filePath: '/l.ts', reviewQuality: ReviewQuality.Light }));
      tracker.trackFile(makeStatus({ filePath: '/n.ts', reviewQuality: ReviewQuality.None }));
    });

    it('groups by review quality', () => {
      const g = tracker.getFilesByQuality();
      expect(g.thorough.map(f => f.filePath)).toEqual(['/t.ts']);
      expect(g.light.map(f => f.filePath)).toEqual(['/l.ts']);
      expect(g.none.map(f => f.filePath)).toEqual(['/n.ts']);
    });

    it('groups by tool', () => {
      tracker.trackFile(makeStatus({ filePath: '/copilot.ts', tool: AITool.Copilot }));
      const g = tracker.getFilesByTool();
      expect(g[AITool.Copilot].map(f => f.filePath)).toEqual(['/copilot.ts']);
      expect(g[AITool.ClaudeCode]).toHaveLength(3);
      expect(g[AITool.Cursor]).toEqual([]);
    });

    it('getRecentFiles returns newest first, limited', () => {
      tracker.clear();
      tracker.trackFile(makeStatus({ filePath: '/old.ts', firstGeneratedAt: 1000 }));
      tracker.trackFile(makeStatus({ filePath: '/mid.ts', firstGeneratedAt: 2000 }));
      tracker.trackFile(makeStatus({ filePath: '/new.ts', firstGeneratedAt: 3000 }));

      expect(tracker.getRecentFiles(2).map(f => f.filePath)).toEqual(['/new.ts', '/mid.ts']);
    });

    it('getRecentFiles defaults to 10', () => {
      tracker.clear();
      for (let i = 0; i < 15; i++) {
        tracker.trackFile(makeStatus({ filePath: `/f${i}.ts`, firstGeneratedAt: 1000 + i }));
      }
      expect(tracker.getRecentFiles()).toHaveLength(10);
    });
  });

  describe('membership and removal', () => {
    it('hasFile reflects tracked keys', () => {
      tracker.trackFile(makeStatus());
      expect(tracker.hasFile('/proj/src/a.ts', TODAY, AITool.ClaudeCode)).toBe(true);
      expect(tracker.hasFile('/proj/src/a.ts', TODAY, AITool.Copilot)).toBe(false);
    });

    it('removeFile reports whether it removed something', () => {
      tracker.trackFile(makeStatus());
      expect(tracker.removeFile('/proj/src/a.ts', TODAY, AITool.ClaudeCode)).toBe(true);
      expect(tracker.removeFile('/proj/src/a.ts', TODAY, AITool.ClaudeCode)).toBe(false);
    });

    it('clear removes everything', () => {
      tracker.trackFile(makeStatus({ filePath: '/a.ts' }));
      tracker.trackFile(makeStatus({ filePath: '/b.ts' }));
      tracker.clear();
      expect(tracker.getFileCount()).toBe(0);
    });

    it('clearDate removes only that date', () => {
      tracker.trackFile(makeStatus({ filePath: '/a.ts', date: TODAY }));
      tracker.trackFile(makeStatus({ filePath: '/b.ts', date: '2026-01-16' }));
      tracker.clearDate(TODAY);
      expect(tracker.getFileCount()).toBe(1);
      expect(tracker.hasFile('/b.ts', '2026-01-16', AITool.ClaudeCode)).toBe(true);
    });
  });

  describe('export / import', () => {
    it('round-trips statuses', () => {
      tracker.trackFile(makeStatus({ filePath: '/a.ts' }));
      tracker.trackFile(makeStatus({ filePath: '/b.ts', reviewScore: 55 }));
      const exported = tracker.exportAll();

      const other = new FileReviewTracker();
      other.importAll(exported);

      expect(other.getFileCount()).toBe(2);
      expect(other.getFileStatus('/b.ts', TODAY, AITool.ClaudeCode)!.reviewScore).toBe(55);
    });

    it('importAll on an empty array is a no-op', () => {
      const fresh = new FileReviewTracker();
      fresh.importAll([]);
      expect(fresh.getFileCount()).toBe(0);
    });
  });
});
