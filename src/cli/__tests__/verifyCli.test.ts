/**
 * codevibe-verify CLI tests.
 *
 * WHY THIS MATTERS: exit codes are the security contract of this verifier.
 * 0 = authentic (and compliant under --strict), 1 = tampered or non-compliant,
 * 2 = usage/IO error. If a refactor silently turns a tampered report into
 * exit 0, a student's forged report passes. These tests pin that behavior,
 * plus compliance evaluation and rendering.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash } from "crypto";
import {
  canonicalize,
  verifyIntegrity,
  checkCompliance,
  validateStructure,
  parseArgs,
  renderHuman,
  renderJson,
  main,
} from "../verify";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseReport(overrides: Record<string, unknown> = {}) {
  return {
    reportVersion: "1.0",
    assignmentId: "a1",
    assignmentName: "HW1",
    generatedAt: 1_700_000_000_000,
    studentIdentifier: "s123",
    repoUrl: "https://github.com/x/y",
    repoHeadCommit: "abcdef1234567890",
    metrics: {
      authorship: {
        totalLines: 100,
        manualLines: 60,
        permittedAILines: 30,
        prohibitedAILines: 0,
        flaggedAILines: 10,
        authorshipPercentage: 40,
        prohibitedPercentage: 0,
      },
      ownership: {
        score: 70,
        filesReviewed: 3,
        filesUnreviewed: 1,
        unreviewedLines: 10,
        averageReviewTimeMs: 4200,
      },
      violations: [] as any[],
    },
    policy: {
      maxAuthorshipPercentage: 30,
      minOwnershipScore: 40,
      exemptFileGlobs: ["**/node_modules/**"],
    },
    ...overrides,
  } as any;
}

/** Seal a report the same way AssignmentReportGenerator does. */
function seal(report: any) {
  const payload = { ...report };
  delete payload.integrity;
  delete payload.generatedAt;
  const hash = createHash("sha256")
    .update(canonicalize(payload) ?? "", "utf8")
    .digest("hex");
  return { ...report, integrity: { algorithm: "sha256", hash } };
}

describe("canonicalize", () => {
  it("sorts object keys recursively", () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{"a":{"c":3,"d":2},"b":1}',
    );
  });

  it("preserves array order", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
  });

  it("renders primitives", () => {
    expect(canonicalize(null)).toBe("null");
    expect(canonicalize(1)).toBe("1");
    expect(canonicalize("s")).toBe('"s"');
    expect(canonicalize(true)).toBe("true");
  });

  it("drops undefined like JSON.stringify", () => {
    expect(canonicalize({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it("returns undefined for unsupported values", () => {
    expect(canonicalize(undefined)).toBeUndefined();
    expect(canonicalize(() => {})).toBeUndefined();
  });

  it("is stable regardless of key insertion order", () => {
    const a = canonicalize({ x: 1, y: { p: 1, q: 2 } });
    const b = canonicalize({ y: { q: 2, p: 1 }, x: 1 });
    expect(a).toBe(b);
  });
});

describe("validateStructure", () => {
  it("accepts a well-formed report", () => {
    expect(validateStructure(seal(baseReport())).ok).toBe(true);
  });

  it.each([
    ["not an object", "nope", /not a JSON object/],
    ["an array", [], /not a JSON object/],
  ])("rejects %s", (_label, input, pattern) => {
    const res = validateStructure(input);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(pattern);
  });

  it("rejects an unsupported reportVersion", () => {
    const res = validateStructure({ reportVersion: "9.9" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/reportVersion/);
  });

  it.each(["assignmentId", "assignmentName", "generatedAt", "metrics", "policy", "integrity"])(
    "rejects a report missing %s",
    (field) => {
      const r: any = seal(baseReport());
      delete r[field];
      const res = validateStructure(r);
      expect(res.ok).toBe(false);
      expect(res.error).toContain(field);
    },
  );

  it("rejects an unsupported integrity algorithm", () => {
    const r: any = seal(baseReport());
    r.integrity.algorithm = "md5";
    expect(validateStructure(r).error).toMatch(/algorithm/);
  });

  it("rejects a malformed hash", () => {
    const r: any = seal(baseReport());
    r.integrity.hash = "short";
    expect(validateStructure(r).error).toMatch(/64-char/);
  });

  it("rejects metrics missing authorship/ownership", () => {
    const r: any = seal(baseReport());
    r.metrics = { somethingElse: true };
    expect(validateStructure(r).error).toMatch(/authorship\/ownership/);
  });
});

describe("verifyIntegrity", () => {
  it("verifies a freshly sealed report", () => {
    expect(verifyIntegrity(seal(baseReport())).ok).toBe(true);
  });

  it("fails when authorship numbers are edited", () => {
    const report = seal(baseReport());
    report.metrics.authorship.authorshipPercentage = 5;
    const res = verifyIntegrity(report);
    expect(res.ok).toBe(false);
    expect(res.expectedHash).not.toBe(res.storedHash);
  });

  it("fails when violations are stripped", () => {
    const withV = seal(
      baseReport({
        metrics: {
          ...baseReport().metrics,
          violations: [
            { type: "agentic-use", severity: "high", message: "x", count: 1 },
          ],
        },
      }),
    );
    withV.metrics.violations = [];
    expect(verifyIntegrity(withV).ok).toBe(false);
  });

  it("fails when the exclusion audit trail is stripped", () => {
    const report = seal(
      baseReport({
        exclusionAudit: [
          { timestamp: 1, globs: ["**/src/**"], source: "settings" },
        ],
      }),
    );
    expect(verifyIntegrity(report).ok).toBe(true);
    expect(verifyIntegrity({ ...report, exclusionAudit: [] }).ok).toBe(false);
  });

  it("ignores generatedAt (re-export of unchanged metrics is stable)", () => {
    const report = seal(baseReport());
    expect(verifyIntegrity({ ...report, generatedAt: 999 }).ok).toBe(true);
  });

  it("fails when the hash is the wrong length", () => {
    const report = seal(baseReport());
    report.integrity.hash = "abc";
    expect(verifyIntegrity(report).ok).toBe(false);
  });
});

describe("checkCompliance", () => {
  it("passes a compliant report", () => {
    const r = baseReport();
    r.metrics.authorship.authorshipPercentage = 10;
    r.policy.maxAuthorshipPercentage = 30;
    r.metrics.ownership.score = 90;
    r.policy.minOwnershipScore = 40;
    r.metrics.violations = [];
    const res = checkCompliance(r);
    expect(res.ok).toBe(true);
    expect(res.reasons).toEqual([]);
  });

  it("fails when authorship exceeds the limit", () => {
    const r = baseReport();
    r.metrics.authorship.authorshipPercentage = 55;
    r.metrics.violations = [];
    const res = checkCompliance(r);
    expect(res.authOk).toBe(false);
    expect(res.ok).toBe(false);
    expect(res.reasons.join()).toMatch(/authorship/);
  });

  it("fails when ownership is below the minimum", () => {
    const r = baseReport();
    r.metrics.ownership.score = 10;
    r.policy.minOwnershipScore = 40;
    r.metrics.violations = [];
    const res = checkCompliance(r);
    expect(res.ownOk).toBe(false);
    expect(res.reasons.join()).toMatch(/ownership/);
  });

  it("ignores ownership when there are no AI files", () => {
    const r = baseReport();
    r.metrics.ownership = {
      score: 0,
      filesReviewed: 0,
      filesUnreviewed: 0,
      unreviewedLines: 0,
      averageReviewTimeMs: 0,
    };
    r.policy.minOwnershipScore = 40;
    r.metrics.violations = [];
    expect(checkCompliance(r).ownOk).toBe(true);
  });

  it("fails on any violation even when thresholds pass", () => {
    const r = baseReport();
    r.metrics.authorship.authorshipPercentage = 1;
    r.metrics.ownership.score = 100;
    r.metrics.violations = [
      { type: "tracking-gap", severity: "low", message: "gap", count: 2 },
    ];
    const res = checkCompliance(r);
    expect(res.hasViolations).toBe(true);
    expect(res.ok).toBe(false);
    expect(res.reasons.join()).toMatch(/violation/);
  });

  it("tolerates a missing violations array", () => {
    const r = baseReport();
    delete r.metrics.violations;
    expect(checkCompliance(r).hasViolations).toBe(false);
  });
});

describe("parseArgs", () => {
  it("collects positional files", () => {
    expect(parseArgs(["a.json", "b.json"]).files).toEqual(["a.json", "b.json"]);
  });

  it("recognizes stdin", () => {
    expect(parseArgs(["-"]).files).toEqual(["-"]);
  });

  it("sets all flags", () => {
    const a = parseArgs([
      "--json",
      "--quiet",
      "--strict",
      "--no-color",
      "--verbose",
      "--help",
      "--version",
    ]);
    expect(a.json).toBe(true);
    expect(a.quiet).toBe(true);
    expect(a.strict).toBe(true);
    expect(a.noColor).toBe(true);
    expect(a.verbose).toBe(true);
    expect(a.help).toBe(true);
    expect(a.version).toBe(true);
  });

  it("supports short flags", () => {
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs(["-q"]).quiet).toBe(true);
  });

  it("exits 2 on an unknown option", () => {
    const exit = jest.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__exit__");
    }) as never);
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    expect(() => parseArgs(["--bogus"])).toThrow("__exit__");
    expect(exit).toHaveBeenCalledWith(2);
    expect(err).toHaveBeenCalledWith("Unknown option: --bogus");
    exit.mockRestore();
    log.mockRestore();
    err.mockRestore();
  });
});

describe("renderHuman", () => {
  const result = (over: any = {}) => ({
    file: "r.json",
    okIntegrity: true,
    okCompliance: true,
    report: seal(baseReport()),
    authorshipPct: 40,
    ownershipScore: 70,
    violations: [],
    exclusionAudit: [],
    ...over,
  });

  it("renders a passing report without ANSI when color is off", () => {
    const out = renderHuman([result()], { useColor: false, verbose: false });
    expect(out).toContain("INTEGRITY OK");
    expect(out).toContain("COMPLIANCE PASS");
    expect(out).toContain("Summary:");
    expect(out).not.toContain("\u001b[");
  });

  it("renders integrity failure with the stored/recomputed hashes", () => {
    const out = renderHuman(
      [
        result({
          okIntegrity: false,
          integrityError: "hash mismatch",
          storedHash: "aaa",
          expectedHash: "bbb",
        }),
      ],
      { useColor: false, verbose: false },
    );
    expect(out).toContain("INTEGRITY FAIL");
    expect(out).toContain("aaa");
    expect(out).toContain("bbb");
    expect(out).toContain("hash mismatch");
  });

  it("renders COMPLIANCE UNKNOWN when compliance was not evaluated", () => {
    const out = renderHuman(
      [result({ okCompliance: undefined })],
      { useColor: false, verbose: false },
    );
    expect(out).toContain("COMPLIANCE UNKNOWN");
  });

  it("renders skipped files", () => {
    const out = renderHuman(
      [result({ skipped: true, integrityError: "Cannot read file" })],
      { useColor: false, verbose: false },
    );
    expect(out).toContain("SKIPPED");
    expect(out).toContain("Cannot read file");
  });

  it("labels stdin", () => {
    const out = renderHuman(
      [result({ file: "-", report: undefined })],
      { useColor: false, verbose: false },
    );
    expect(out).toContain("<stdin>");
  });

  it("shows violation detail in verbose mode", () => {
    const out = renderHuman(
      [
        result({
          okCompliance: false,
          violations: [
            { type: "agentic-use", severity: "high", message: "agent ran", count: 3 },
          ],
        }),
      ],
      { useColor: true, verbose: true },
    );
    expect(out).toContain("agent ran");
    expect(out).toContain("×3");
  });

  it("reports no exclusion audit entries when the trail is empty", () => {
    const out = renderHuman([result()], { useColor: false, verbose: false });
    expect(out).toContain("no changes during assignment window");
  });

  it("flags student settings changes in the audit trail", () => {
    const out = renderHuman(
      [
        result({
          exclusionAudit: [
            { timestamp: 1, globs: ["**/src/**"], source: "settings" },
            { timestamp: 2, globs: [], source: "assignment-activated" },
          ],
        }),
      ],
      { useColor: false, verbose: true },
    );
    expect(out).toContain("Exclusion audit");
    expect(out).toContain("ignored by lockdown");
    expect(out).toContain("**/src/**");
  });

  it("includes tracking gaps when present", () => {
    const report = seal(baseReport());
    report.metrics.trackingGaps = [{ startTime: 1, endTime: 2, durationSeconds: 3600 }];
    const out = renderHuman([result({ report })], { useColor: false, verbose: false });
    expect(out).toContain("Tracking gaps:");
  });
});

describe("renderJson", () => {
  it("emits parseable JSON with the key fields", () => {
    const out = renderJson([
      {
        file: "r.json",
        okIntegrity: true,
        okCompliance: false,
        report: seal(baseReport()) as any,
        authorshipPct: 40,
        ownershipScore: 70,
        violations: [],
        exclusionAudit: [],
      },
    ]);
    const parsed = JSON.parse(out);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].okIntegrity).toBe(true);
    expect(parsed[0].okCompliance).toBe(false);
    expect(parsed[0].assignmentId).toBe("a1");
    expect(parsed[0].studentIdentifier).toBe("s123");
  });
});

// ---------------------------------------------------------------------------
// main(): exit codes - the security contract
// ---------------------------------------------------------------------------

describe("main() exit codes", () => {
  let tmpDir: string;
  let argv: string[];
  let exitCode: number | undefined;
  let logs: string[];
  let errs: string[];
  let originalArgv: string[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-test-"));
    exitCode = undefined;
    logs = [];
    errs = [];
    argv = [];

    // process.argv is a plain data property, not an accessor, so assign it
    // directly and restore the original array in afterEach. Assigned per-run
    // (in run()) because each test sets `argv` after beforeEach.
    originalArgv = process.argv;
    jest.spyOn(console, "log").mockImplementation((...a) => {
      logs.push(a.join(" "));
    });
    jest.spyOn(console, "error").mockImplementation((...a) => {
      errs.push(a.join(" "));
    });
    jest.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCode = code;
      throw new Error("__exit__");
    }) as never);
  });

  afterEach(() => {
    process.argv = originalArgv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  const write = (name: string, obj: any) => {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj));
    return p;
  };

  const run = () => {
    process.argv = ["node", "verify.js", ...argv];
    try {
      main();
    } catch (e) {
      if (!(e as Error).message.includes("__exit__")) throw e;
    }
  };

  it("exits 0 for an authentic, compliant report", () => {
    const r = baseReport();
    r.metrics.authorship.authorshipPercentage = 10;
    r.metrics.ownership.score = 90;
    argv = [write("ok.json", seal(r))];

    run();
    expect(exitCode).toBe(0);
  });

  it("exits 1 for a tampered report (integrity failure)", () => {
    const report = seal(baseReport());
    report.metrics.authorship.authorshipPercentage = 0; // forged downward
    argv = [write("tampered.json", report)];

    run();
    expect(exitCode).toBe(1);
  });

  it("exits 2 when no files are given", () => {
    argv = [];
    run();
    expect(exitCode).toBe(2);
    expect(errs.join()).toMatch(/Usage/);
  });

  it("exits 0 on --help", () => {
    argv = ["--help"];
    run();
    expect(exitCode).toBe(0);
    expect(logs.join()).toMatch(/codevibe-verify/);
  });

  it("exits 0 on --version and prints the report version", () => {
    argv = ["--version"];
    run();
    expect(exitCode).toBe(0);
    expect(logs.join()).toBe("1.0");
  });

  it("exits 1 for an unreadable file (skipped counts as fail)", () => {
    argv = [path.join(tmpDir, "does-not-exist.json")];
    run();
    expect(exitCode).toBe(1);
  });

  it("exits 1 for malformed JSON", () => {
    argv = [write("bad.json", "{not json")];
    run();
    expect(exitCode).toBe(1);
  });

  it("exits 1 for a structurally invalid report", () => {
    argv = [write("invalid.json", { reportVersion: "0.1" })];
    run();
    expect(exitCode).toBe(1);
  });

  it("non-strict: authentic but non-compliant still exits 0", () => {
    const r = baseReport();
    r.metrics.authorship.authorshipPercentage = 99; // over the limit
    r.metrics.violations = [];
    argv = [write("noncompliant.json", seal(r))];

    run();
    expect(exitCode).toBe(0);
  });

  it("strict: authentic but non-compliant exits 1", () => {
    const r = baseReport();
    r.metrics.authorship.authorshipPercentage = 99;
    r.metrics.violations = [];
    argv = ["--strict", write("noncompliant-strict.json", seal(r))];

    run();
    expect(exitCode).toBe(1);
  });

  it("emits JSON with --json", () => {
    const r = baseReport();
    r.metrics.authorship.authorshipPercentage = 10;
    r.metrics.ownership.score = 90;
    argv = ["--json", write("j.json", seal(r))];

    run();
    const parsed = JSON.parse(logs[0]);
    expect(parsed[0].okIntegrity).toBe(true);
  });

  it("prints only a summary with --quiet", () => {
    const r = baseReport();
    r.metrics.authorship.authorshipPercentage = 10;
    r.metrics.ownership.score = 90;
    argv = ["--quiet", write("q.json", seal(r))];

    run();
    expect(logs.join()).toMatch(/^Processed 1 file/);
  });

  it("verifies multiple files and fails if any is tampered", () => {
    const good = baseReport();
    good.metrics.authorship.authorshipPercentage = 10;
    good.metrics.ownership.score = 90;
    const bad = seal(baseReport());
    bad.metrics.ownership.score = 0; // tampered after sealing

    argv = [write("g.json", seal(good)), write("b.json", bad)];
    run();
    expect(exitCode).toBe(1);
  });
});
