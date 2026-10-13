/**
 * PathAnonymizer - reversible path anonymization for data at rest.
 *
 * WHY:
 * `codePause.anonymizePaths` (default: true) claims stored file paths are
 * anonymized. Absolute paths embed the OS username and full machine layout
 * (e.g. /Users/jane.doe/work/acme-corp/src/auth.ts), which is PII and
 * directory disclosure. Previously the flag was never applied and raw paths
 * were written to ~/.codepause/*.db.
 *
 * DESIGN (reversible, so all runtime logic keeps using absolute paths):
 * - WRITE  (toStorage):  absolute -> anonymized form, stored in the DB.
 * - READ   (fromStorage): stored form -> absolute, so in-memory caches,
 *                         "open file for review", and lookup keys are
 *                         unaffected.
 *
 * Transform rules, in order:
 *  1. Inside the workspace root  -> workspace-relative POSIX path
 *                                  (src/auth/login.ts). Strips username AND
 *                                  machine layout.
 *  2. Inside the home directory  -> ~/rest/of/path.txt
 *                                  (strips the username, keeps it openable).
 *  3. Anything else (e.g. /tmp)  -> left as-is. Reversibility is a hard
 *                                  requirement (the dashboard opens these
 *                                  files), so we never hash-and-lose paths.
 *
 * Known limitation: a path outside both the workspace and $HOME still stores
 * its full absolute form. In practice this is rare (the extension is
 * workspace-scoped, and the no-workspace single-file case is normally under
 * $HOME).
 */

import * as os from "os";

/** Marker for home-relative paths. Chosen because it is not a legal Windows
 *  path character set member for the root, so it cannot collide with a real
 *  absolute path stored in the same column. */
const HOME_PREFIX = "~";

/**
 * Normalize separators to POSIX and collapse duplicate slashes.
 * Does not resolve symlinks or `..` (callers pass already-normalized paths).
 */
function toPosix(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/");
}

/**
 * True if `child` is inside `parent` (both already POSIX-normalized).
 * Compares with a trailing slash so /proj/foo is not treated as inside /proj.
 */
function isInside(parent: string, child: string): boolean {
  if (!parent) {
    return false;
  }
  const p = parent.endsWith("/") ? parent : `${parent}/`;
  return child.startsWith(p);
}

/**
 * True for POSIX roots ("/...") and Windows roots ("C:/...", "//server/share").
 * A bare "src/app.ts" is relative, so it is never "already anonymized" - it is
 * already workspace-relative and stays as-is.
 */
function isAbsolutePath(p: string): boolean {
  return p.startsWith("/") || /^[a-zA-Z]:\//.test(p) || p.startsWith("//");
}

export class PathAnonymizer {
  private workspaceRoot: string | null = null;
  private homeDir: string | null = null;
  private enabled = true;

  /**
   * @param workspaceRoot Absolute workspace root (normalized internally).
   * @param enabled       When false, both transforms are pass-throughs.
   * @param homeDir       Override for $HOME. Only used by tests; production
   *                      resolves os.homedir() lazily.
   */
  constructor(
    workspaceRoot?: string | null,
    enabled = true,
    homeDir?: string | null,
  ) {
    this.setWorkspaceRoot(workspaceRoot ?? null);
    this.enabled = enabled;
    if (homeDir !== undefined) {
      this.homeDir = homeDir ? toPosix(homeDir).replace(/\/+$/, "") : "";
    }
  }

  setWorkspaceRoot(workspaceRoot: string | null): void {
    this.workspaceRoot = workspaceRoot
      ? toPosix(workspaceRoot).replace(/\/+$/, "")
      : null;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Lazily resolved so the constructor can override it for tests. */
  private getHome(): string | null {
    if (this.homeDir === null) {
      try {
        const home = os.homedir();
        this.homeDir = home ? toPosix(home).replace(/\/+$/, "") : "";
      } catch {
        this.homeDir = "";
      }
    }
    return this.homeDir || null;
  }

  /** True when the path has a filesystem root (POSIX or Windows/UNC). */
  private isAbsolute(p: string): boolean {
    return isAbsolutePath(p);
  }

  /**
   * Absolute (or already-stored) path -> form suitable for storage.
   * Idempotent: running it on an already-anonymized path is a no-op.
   */
  toStorage(filePath: string | undefined | null): string | undefined | null {
    if (!filePath) {
      return filePath;
    }
    if (!this.enabled) {
      return filePath;
    }

    const posix = toPosix(filePath);

    // Already anonymized -> nothing to do.
    if (posix === HOME_PREFIX || posix.startsWith(`${HOME_PREFIX}/`)) {
      return posix;
    }
    // Already workspace-relative: either a bare POSIX path, or a Windows
    // path whose root we don't recognize (drive letter / UNC).
    if (this.workspaceRoot && !this.isAbsolute(posix)) {
      return posix;
    }

    // 1. Workspace-relative
    if (this.workspaceRoot && isInside(this.workspaceRoot, posix)) {
      return posix.slice(this.workspaceRoot.length + 1);
    }

    // 2. Home-relative
    const home = this.getHome();
    if (home && isInside(home, posix)) {
      return `${HOME_PREFIX}${posix.slice(home.length)}`;
    }

    // 3. Outside both - keep as-is to preserve reversibility.
    return posix;
  }

  /**
   * Stored form -> absolute path, so the rest of the app can keep working
   * with real filesystem paths. Falls back to the input when the workspace
   * root is unknown.
   */
  fromStorage(storedPath: string | undefined | null): string | undefined | null {
    if (!storedPath) {
      return storedPath;
    }

    const posix = toPosix(storedPath);

    if (posix === HOME_PREFIX || posix.startsWith(`${HOME_PREFIX}/`)) {
      const home = this.getHome();
      if (!home) {
        return posix;
      }
      return `${home}${posix.slice(HOME_PREFIX.length)}`;
    }

    if (this.isAbsolute(posix)) {
      return posix;
    }

    // Workspace-relative (only resolvable when we know the root)
    if (this.workspaceRoot) {
      return `${this.workspaceRoot}/${posix}`;
    }
    return posix;
  }
}
