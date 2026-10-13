/**
 * Excluded-path purge + exclusion audit tests (real database).
 *
 * Covers: DatabaseManager delete/scan helpers and
 * MetricsRepository.purgeExcludedEvents end-to-end (delete + metrics recalc).
 */

import * as fs from "fs";
import * as path from "path";
import { DatabaseManager } from "../DatabaseManager";
import { MetricsRepository } from "../MetricsRepository";
import {
  TrackingEvent,
  FileReviewStatus,
  AITool,
  EventType,
  CodeSource,
  ReviewQuality,
} from "../../types";

describe("Excluded-path purge", () => {
  let dbManager: DatabaseManager;
  let metricsRepo: MetricsRepository;
  let tempDir: string;

  const today = new Date().toISOString().split("T")[0];

  function makeEvent(filePath: string, lines: number): TrackingEvent {
    return {
      timestamp: Date.now(),
      tool: AITool.ClaudeCode,
      source: CodeSource.AI,
      eventType: EventType.CodeGenerated,
      linesOfCode: lines,
      linesChanged: lines,
      charactersCount: lines * 40,
      filePath,
      language: "typescript",
      detectionMethod: "external-file-change",
      confidence: "high",
    };
  }

  function makeReview(filePath: string, lines: number): FileReviewStatus {
    return {
      filePath,
      date: today,
      tool: AITool.ClaudeCode,
      reviewQuality: ReviewQuality.None,
      reviewScore: 0,
      isReviewed: false,
      linesGenerated: lines,
      linesChanged: lines,
      linesSinceReview: lines,
      charactersCount: lines * 40,
      isAgentGenerated: true,
      wasFileOpen: false,
      firstGeneratedAt: Date.now(),
      totalReviewTime: 0,
      modificationCount: 1,
      totalTimeInFocus: 0,
      scrollEventCount: 0,
      cursorMovementCount: 0,
      editsMade: false,
      reviewSessionsCount: 0,
      reviewedInTerminal: false,
    };
  }

  beforeEach(async () => {
    tempDir = path.join(
      __dirname,
      "..",
      "..",
      "..",
      "test-data",
      `purge-test-${Date.now()}`,
    );
    fs.mkdirSync(tempDir, { recursive: true });
    dbManager = new DatabaseManager(tempDir);
    await dbManager.initialize();
    metricsRepo = new MetricsRepository(dbManager);
  });

  afterEach(() => {
    dbManager.close();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("deletes node_modules/venv events and reviews, keeps source files", async () => {
    await dbManager.insertEvent(
      makeEvent("/proj/node_modules/lodash/lodash.js", 1000),
    );
    await dbManager.insertEvent(
      makeEvent("/proj/.venv/lib/site-packages/numpy/core.py", 500),
    );
    await dbManager.insertEvent(makeEvent("/proj/package-lock.json", 800));
    await dbManager.insertEvent(makeEvent("/proj/src/app.ts", 10));
    await dbManager.insertOrUpdateFileReviewStatus(
      makeReview("/proj/node_modules/lodash/lodash.js", 1000),
    );
    await dbManager.insertOrUpdateFileReviewStatus(
      makeReview("/proj/src/app.ts", 10),
    );

    const result = await metricsRepo.purgeExcludedEvents();

    expect(result.eventsDeleted).toBe(3);
    expect(result.fileReviewsDeleted).toBe(1);
    expect(result.datesRecalculated).toContain(today);

    const remaining = await dbManager.getRecentEvents(100);
    expect(remaining.map((e) => e.filePath)).toEqual(["/proj/src/app.ts"]);

    const reviews = await dbManager.getFileReviewsForDate(today);
    expect(reviews.map((r) => r.filePath)).toEqual(["/proj/src/app.ts"]);
  });

  it("does not touch lookalike paths", async () => {
    await dbManager.insertEvent(
      makeEvent("/proj/my-node_modules-backup/app.ts", 7),
    );

    const result = await metricsRepo.purgeExcludedEvents();

    expect(result.eventsDeleted).toBe(0);
    expect(result.fileReviewsDeleted).toBe(0);
  });

  it("is idempotent (second run deletes nothing)", async () => {
    await dbManager.insertEvent(
      makeEvent("/proj/node_modules/pkg/index.js", 100),
    );

    const first = await metricsRepo.purgeExcludedEvents();
    expect(first.eventsDeleted).toBe(1);

    const second = await metricsRepo.purgeExcludedEvents();
    expect(second.eventsDeleted).toBe(0);
    expect(second.fileReviewsDeleted).toBe(0);
  });

  it("honours extra user globs", async () => {
    await dbManager.insertEvent(makeEvent("/proj/generated/types.ts", 50));
    await dbManager.insertEvent(makeEvent("/proj/src/app.ts", 10));

    const result = await metricsRepo.purgeExcludedEvents(["**/generated/**"]);

    expect(result.eventsDeleted).toBe(1);
    const remaining = await dbManager.getRecentEvents(100);
    expect(remaining.map((e) => e.filePath)).toEqual(["/proj/src/app.ts"]);
  });

  it("records and retrieves the exclusion audit trail", async () => {
    const now = Date.now();
    await dbManager.recordExclusionAudit(now, ["**/src/**"], "settings");
    await dbManager.recordExclusionAudit(now + 1, [], "assignment-activated");

    const entries = await dbManager.getExclusionAudit(now - 1000, now + 1000);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      globs: ["**/src/**"],
      source: "settings",
    });
    expect(entries[1].source).toBe("assignment-activated");
  });
});
