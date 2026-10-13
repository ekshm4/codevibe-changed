/**
 * AssignmentManager tests.
 *
 * Covers the assignment lifecycle and policy construction that PolicyEngine
 * tests do not touch: create/activate/deactivate/update, buildPolicy defaults
 * merging, and isExemptFile glob semantics (the mechanism that decides which
 * files are excluded from graded authorship numbers).
 */

import { AssignmentManager } from "../AssignmentManager";
import { AIDetectionMethod, Assignment, AssignmentPolicy } from "../../types";

function makeRepo() {
  const assignments = new Map<string, Assignment>();
  let activeId: string | null = null;
  const auditCalls: Array<{ globs: string[]; source: string }> = [];

  return {
    auditCalls,
    assignments,
    get activeId() {
      return activeId;
    },
    saveAssignment: jest.fn(async (a: Assignment) => {
      assignments.set(a.id, a);
    }),
    getAssignment: jest.fn(async (id: string) => assignments.get(id) ?? null),
    getAssignments: jest.fn(async () => Array.from(assignments.values())),
    getActiveAssignment: jest.fn(async () =>
      activeId ? (assignments.get(activeId) ?? null) : null,
    ),
    setActiveAssignment: jest.fn(async (id: string | null) => {
      activeId = id;
    }),
    recordExclusionAudit: jest.fn(
      async (_ts: number, globs: string[], source: string) => {
        auditCalls.push({ globs, source });
      },
    ),
  };
}

type Repo = ReturnType<typeof makeRepo>;

describe("AssignmentManager", () => {
  let repo: Repo;
  let manager: AssignmentManager;

  beforeEach(() => {
    repo = makeRepo();
    manager = new AssignmentManager(repo as any);
  });

  describe("createAssignment", () => {
    it("generates an id and defaults the policy", async () => {
      const a = await manager.createAssignment({
        name: "HW1",
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });

      expect(a.id).toMatch(/^assignment-/);
      expect(a.name).toBe("HW1");
      expect(a.isActive).toBe(false);
      expect(a.policy.maxAuthorshipPercentage).toBe(30);
      expect(a.policy.minOwnershipScore).toBe(40);
      expect(repo.saveAssignment).toHaveBeenCalledWith(a);
    });

    it("honours a caller-supplied id", async () => {
      const a = await manager.createAssignment({
        id: "custom-id",
        name: "HW2",
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });
      expect(a.id).toBe("custom-id");
    });

    it("applies policy overrides", async () => {
      const a = await manager.createAssignment({
        name: "HW3",
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        repoUrl: "https://github.com/x/y",
        policy: { maxAuthorshipPercentage: 10, minOwnershipScore: 70 },
      });

      expect(a.policy.maxAuthorshipPercentage).toBe(10);
      expect(a.policy.minOwnershipScore).toBe(70);
      // Unspecified policy fields still get defaults
      expect(a.policy.exemptFileGlobs.length).toBeGreaterThan(0);
    });

    it("records courseId when provided", async () => {
      const a = await manager.createAssignment({
        name: "HW4",
        courseId: "CS101",
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });
      expect(a.courseId).toBe("CS101");
    });
  });

  describe("activate / deactivate", () => {
    it("activates an assignment and audits the marker", async () => {
      const a = await manager.createAssignment({
        name: "HW5",
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });

      const activated = await manager.activateAssignment(a.id);
      expect(repo.setActiveAssignment).toHaveBeenCalledWith(a.id);
      expect(activated?.id).toBe(a.id);
      expect(repo.auditCalls).toContainEqual({
        globs: [],
        source: "assignment-activated",
      });
    });

    it("deactivates and audits the marker", async () => {
      await manager.deactivateAssignment();
      expect(repo.setActiveAssignment).toHaveBeenCalledWith(null);
      expect(repo.auditCalls).toContainEqual({
        globs: [],
        source: "assignment-deactivated",
      });
    });

    it("activation succeeds even if auditing fails", async () => {
      repo.recordExclusionAudit = jest
        .fn()
        .mockRejectedValue(new Error("audit table missing"));
      const a = await manager.createAssignment({
        name: "HW6",
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });
      await expect(manager.activateAssignment(a.id)).resolves.toMatchObject({
        id: a.id,
      });
    });

    it("getActiveAssignment returns null when none is active", async () => {
      await expect(manager.getActiveAssignment()).resolves.toBeNull();
    });

    it("listAssignments returns stored assignments", async () => {
      await manager.createAssignment({
        name: "A",
        startDate: "2026-01-01",
        endDate: "2026-01-02",
      });
      await manager.createAssignment({
        name: "B",
        startDate: "2026-01-01",
        endDate: "2026-01-02",
      });
      expect(await manager.listAssignments()).toHaveLength(2);
    });

    it("getAssignment returns null for an unknown id", async () => {
      expect(await manager.getAssignment("nope")).toBeNull();
    });
  });

  describe("updateAssignment", () => {
    it("returns null for an unknown id", async () => {
      expect(await manager.updateAssignment("nope", { name: "x" })).toBeNull();
    });

    it("updates metadata and keeps the existing policy", async () => {
      const a = await manager.createAssignment({
        name: "HW7",
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });
      const updated = await manager.updateAssignment(a.id, { name: "HW7 v2" });
      expect(updated?.name).toBe("HW7 v2");
      expect(updated?.policy.maxAuthorshipPercentage).toBe(30);
    });

    it("rebuilds the policy when a policy is supplied", async () => {
      const a = await manager.createAssignment({
        name: "HW8",
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });
      const updated = await manager.updateAssignment(a.id, {
        policy: { maxAuthorshipPercentage: 5 },
      });
      expect(updated?.policy.maxAuthorshipPercentage).toBe(5);
      // Partial policy still merges with defaults
      expect(updated?.policy.minOwnershipScore).toBe(40);
    });
  });

  describe("buildPolicy", () => {
    it("returns defaults for an empty override", () => {
      const p = manager.buildPolicy({});
      const d = manager.getDefaultPolicy();
      expect(p.maxAuthorshipPercentage).toBe(d.maxAuthorshipPercentage);
      expect(p.exemptFileGlobs).toEqual(d.exemptFileGlobs);
    });

    it("merges scalar overrides", () => {
      const p = manager.buildPolicy({ maxAuthorshipPercentage: 12 });
      expect(p.maxAuthorshipPercentage).toBe(12);
    });

    it("honours an explicitly empty exemptFileGlobs array", () => {
      const p = manager.buildPolicy({ exemptFileGlobs: [] });
      expect(p.exemptFileGlobs).toEqual([]);
    });

    it("keeps default method lists when not overridden", () => {
      const p = manager.buildPolicy({ maxAuthorshipPercentage: 1 });
      const d = manager.getDefaultPolicy();
      expect(p.prohibitedMethods).toEqual(d.prohibitedMethods);
      expect(p.permittedMethods).toEqual(d.permittedMethods);
      expect(p.flaggedMethods).toEqual(d.flaggedMethods);
    });
  });

  describe("getDefaultPolicy", () => {
    it("prohibits agentic methods, permits inline, flags paste/velocity", () => {
      const p = manager.getDefaultPolicy();
      expect(p.prohibitedMethods).toContain(AIDetectionMethod.ExternalFileChange);
      expect(p.prohibitedMethods).toContain(AIDetectionMethod.GitCommitMarker);
      expect(p.permittedMethods).toEqual([AIDetectionMethod.InlineCompletionAPI]);
      expect(p.flaggedMethods).toContain(AIDetectionMethod.LargePaste);
      expect(p.flaggedMethods).toContain(AIDetectionMethod.ChangeVelocity);
    });

    it("exempts generated dirs and lockfiles by default", () => {
      const g = manager.getDefaultPolicy().exemptFileGlobs;
      for (const glob of [
        "**/node_modules/**",
        "**/venv/**",
        "**/dist/**",
        "**/coverage/**",
        "**/package-lock.json",
      ]) {
        expect(g).toContain(glob);
      }
    });
  });

  describe("isExemptFile", () => {
    // Policy is derived inside beforeEach, so read it per-test.
    it.each([
      "/proj/node_modules/lodash/lodash.js",
      "/proj/venv/lib/python3.12/x.py",
      "/proj/dist/bundle.js",
      "/proj/coverage/lcov-report/index.html",
      "/proj/package-lock.json",
      "/proj/README.md",
      "/proj/package.json",
    ])("exempts %s", (p) => {
      expect(manager.isExemptFile(p, manager.getDefaultPolicy())).toBe(true);
    });

    it.each([
      "/proj/src/app.ts",
      "/proj/src/venv_config.py",
      // Note: a file literally named README_helper.ts DOES match the
      // `**/README*` glob by design - that is the glob doing its job.
      "/proj/src/readme.ts",
      "/proj/src/notes.txt",
    ])("does not exempt %s", (p) => {
      expect(manager.isExemptFile(p, manager.getDefaultPolicy())).toBe(false);
    });

    it("exempts README_helper.ts because the glob is a prefix match", () => {
      expect(
        manager.isExemptFile("/proj/src/README_helper.ts", manager.getDefaultPolicy()),
      ).toBe(true);
    });

    it("returns false when the policy exempts nothing", () => {
      const bare: AssignmentPolicy = {
        ...manager.getDefaultPolicy(),
        exemptFileGlobs: [],
      };
      expect(manager.isExemptFile("/proj/node_modules/x.js", bare)).toBe(false);
    });
  });
});
