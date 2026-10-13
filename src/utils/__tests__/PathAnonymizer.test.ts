/**
 * PathAnonymizer tests - reversible path anonymization for data at rest.
 *
 * $HOME is injected so assertions don't depend on the machine running them.
 */

import { PathAnonymizer } from "../PathAnonymizer";

describe("PathAnonymizer", () => {
  const home = "/home/testuser";
  const workspace = `${home}/projects/acme`;

  const makeAnon = (root: string | null = workspace, enabled = true) =>
    new PathAnonymizer(root, enabled, home);

  describe("toStorage", () => {
    it("makes workspace files relative (strips username + layout)", () => {
      expect(makeAnon().toStorage(`${workspace}/src/auth/login.ts`)).toBe(
        "src/auth/login.ts",
      );
    });

    it("makes workspace-root files relative", () => {
      expect(makeAnon().toStorage(`${workspace}/package.json`)).toBe(
        "package.json",
      );
    });

    it("uses ~ for files under $HOME but outside the workspace", () => {
      expect(makeAnon().toStorage(`${home}/notes/scratch.txt`)).toBe(
        "~/notes/scratch.txt",
      );
    });

    it("leaves paths outside workspace and $HOME intact (reversibility)", () => {
      expect(makeAnon().toStorage("/tmp/scratch.txt")).toBe("/tmp/scratch.txt");
    });

    it("does not treat a sibling dir with a shared prefix as inside", () => {
      // /home/testuser/projects/acme-legacy is NOT inside .../acme, so it must
      // not be reduced to a workspace-relative path. It still falls back to
      // ~-relative since it is under $HOME.
      expect(makeAnon().toStorage(`${workspace}-legacy/src/app.ts`)).toBe(
        "~/projects/acme-legacy/src/app.ts",
      );
    });

    it("normalizes windows separators", () => {
      const anon = new PathAnonymizer("C:/work/proj", true, "C:/Users/me");
      expect(anon.toStorage("C:/work/proj/src/app.ts")).toBe("src/app.ts");
    });

    it("makes windows $HOME paths ~-relative", () => {
      const anon = new PathAnonymizer("C:/work/proj", true, "C:/Users/me");
      expect(anon.toStorage("C:/Users/me/notes/x.txt")).toBe("~/notes/x.txt");
    });

    it("is idempotent", () => {
      const anon = makeAnon();
      const once = anon.toStorage(`${workspace}/src/a.ts`);
      expect(anon.toStorage(once)).toBe(once);
    });

    it("passes paths through when disabled", () => {
      const abs = `${workspace}/src/a.ts`;
      expect(makeAnon(workspace, false).toStorage(abs)).toBe(abs);
    });

    it("handles null/undefined/empty", () => {
      const anon = makeAnon();
      expect(anon.toStorage(null)).toBeNull();
      expect(anon.toStorage(undefined)).toBeUndefined();
      expect(anon.toStorage("")).toBe("");
    });

    it("works with no workspace root (home-relative only)", () => {
      const anon = makeAnon(null);
      expect(anon.toStorage(`${home}/notes/x.txt`)).toBe("~/notes/x.txt");
    });
  });

  describe("fromStorage", () => {
    it("restores workspace-relative paths", () => {
      expect(makeAnon().fromStorage("src/auth/login.ts")).toBe(
        `${workspace}/src/auth/login.ts`,
      );
    });

    it("restores ~-relative paths", () => {
      expect(makeAnon().fromStorage("~/notes/scratch.txt")).toBe(
        `${home}/notes/scratch.txt`,
      );
    });

    it("leaves absolute paths untouched", () => {
      expect(makeAnon().fromStorage("/tmp/scratch.txt")).toBe(
        "/tmp/scratch.txt",
      );
    });

    it("round-trips every writable form", () => {
      const anon = makeAnon();
      const cases = [
        `${workspace}/src/a.ts`,
        `${workspace}/package.json`,
        `${home}/notes/x.txt`,
        "/tmp/y.txt",
      ];
      for (const original of cases) {
        expect(anon.fromStorage(anon.toStorage(original))).toBe(original);
      }
    });
  });

  describe("anonymization actually removes PII", () => {
    it("stored workspace path contains no username or layout", () => {
      const stored = makeAnon().toStorage(
        `${workspace}/src/auth/login.ts`,
      ) as string;
      expect(stored).toBe("src/auth/login.ts");
      expect(stored).not.toContain("testuser");
      expect(stored).not.toContain("projects");
    });

    it("stored home path contains no username", () => {
      const stored = makeAnon().toStorage(`${home}/notes/x.txt`) as string;
      expect(stored).not.toContain("testuser");
    });
  });
});
