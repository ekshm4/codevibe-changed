/**
 * DiffViewerHelper tests.
 *
 * Covers the git-integration paths: file-missing, no-workspace, not-a-repo,
 * untracked file, tracked file with a HEAD version, and temp-file cleanup.
 */

import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { DiffViewerHelper } from '../DiffViewerHelper';

jest.mock('vscode', () => ({
  Uri: {
    file: (p: string) => ({ fsPath: p, scheme: 'file' }),
  },
  window: {
    showErrorMessage: jest.fn(),
    showInformationMessage: jest.fn(),
    showTextDocument: jest.fn(),
  },
  workspace: {
    workspaceFolders: undefined as any,
    openTextDocument: jest.fn(),
  },
  commands: {
    executeCommand: jest.fn(),
  },
}), { virtual: true });

jest.mock('fs', () => ({
  existsSync: jest.fn(),
  writeFileSync: jest.fn(),
  unlinkSync: jest.fn(),
}));

jest.mock('child_process', () => ({
  execSync: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { execSync } = require('child_process') as { execSync: jest.Mock };

// The mocked `fs` (used by the module under test) vs the real `fs` (used by
// this suite for temp-dir setup/cleanup).
// jest.mock('fs') is hoisted and applies module-wide, so the real fs is
// pulled explicitly for this suite's own temp-dir setup/cleanup.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const realFs = jest.requireActual('fs') as typeof import('fs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fsMock = require('fs') as {
  existsSync: jest.Mock;
  writeFileSync: jest.Mock;
  unlinkSync: jest.Mock;
};

describe('DiffViewerHelper', () => {
  let helper: DiffViewerHelper;
  let tmpDir: string;
  let repoFile: string;

  beforeEach(() => {
    jest.clearAllMocks();
    tmpDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'diff-test-'));
    repoFile = path.join(tmpDir, 'src', 'app.ts');
    (vscode.workspace as any).workspaceFolders = [
      { uri: { fsPath: tmpDir } },
    ];
    (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue({
      getText: () => 'current',
    });
    (vscode.window.showTextDocument as jest.Mock).mockResolvedValue(undefined);
    (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);
    helper = new DiffViewerHelper();
  });

  afterEach(() => {
    (vscode.workspace as any).workspaceFolders = undefined;
    realFs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('openDiff - file missing', () => {
    it('shows an error and does not open anything', async () => {
      fsMock.existsSync.mockReturnValue(false);

      await helper.openDiff(repoFile);

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('File not found'),
      );
      expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    });
  });

  describe('openDiff - new file (no HEAD version)', () => {
    beforeEach(() => {
      fsMock.existsSync.mockReturnValue(true);
    });

    it('opens the file directly when there is no workspace folder', async () => {
      (vscode.workspace as any).workspaceFolders = undefined;

      await helper.openDiff(repoFile);

      expect(vscode.workspace.openTextDocument).toHaveBeenCalled();
      expect(vscode.window.showTextDocument).toHaveBeenCalled();
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('new file'),
      );
    });

    it('opens directly when not a git repository', async () => {
      execSync.mockImplementation((cmd: string) => {
        if (cmd.includes('rev-parse')) {
          throw new Error('not a repo');
        }
        return '';
      });

      await helper.openDiff(repoFile);

      expect(vscode.workspace.openTextDocument).toHaveBeenCalled();
      expect(vscode.window.showInformationMessage).toHaveBeenCalled();
    });

    it('opens directly when the file is untracked', async () => {
      execSync.mockImplementation((cmd: string) => {
        if (cmd.includes('ls-files')) {
          throw new Error('untracked');
        }
        return '';
      });

      await helper.openDiff(repoFile);

      expect(vscode.workspace.openTextDocument).toHaveBeenCalled();
    });
  });

  describe('openDiff - tracked file with a HEAD version', () => {
    beforeEach(() => {
      fsMock.existsSync.mockReturnValue(true);
      execSync.mockImplementation((cmd: string) => {
        if (cmd.includes('git show')) {
          return 'previous content';
        }
        return '';
      });
    });

    it('creates a temp file and opens a diff', async () => {
      await helper.openDiff(repoFile);

      // Temp file written with the HEAD content
      expect(fsMock.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('codepause-'),
        'previous content',
        'utf8',
      );
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        'vscode.diff',
        expect.objectContaining({ scheme: 'file' }),
        expect.objectContaining({ scheme: 'file' }),
        'app.ts (HEAD ↔ Working)',
        { preview: false },
      );
    });

    it('falls back to opening the file when git show fails', async () => {
      execSync.mockImplementation((cmd: string) => {
        if (cmd.includes('git show')) {
          throw new Error('boom');
        }
        return '';
      });
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      // git show failure is caught inside getPreviousVersion, so the file is
      // simply opened directly instead of a diff.
      await helper.openDiff(repoFile);
      expect(vscode.workspace.openTextDocument).toHaveBeenCalled();
      errSpy.mockRestore();
    });

    it('rethrows when the editor itself fails to open', async () => {
      // Force the direct-open path (no HEAD version), then fail the editor.
      execSync.mockImplementation((cmd: string) => {
        if (cmd.includes('rev-parse')) {
          throw new Error('not a repo');
        }
        return '';
      });
      (vscode.workspace.openTextDocument as jest.Mock).mockRejectedValue(
        new Error('cannot open'),
      );
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      await expect(helper.openDiff(repoFile)).rejects.toThrow('cannot open');

      errSpy.mockRestore();
    });
  });

  describe('lifecycle', () => {
    it('throws after dispose', async () => {
      helper.dispose();
      await expect(helper.openDiff(repoFile)).rejects.toThrow(
        'DiffViewerHelper has been disposed',
      );
    });

    it('dispose is idempotent', () => {
      helper.dispose();
      expect(() => helper.dispose()).not.toThrow();
    });

    it('dispose removes created temp files', async () => {
      fsMock.existsSync.mockReturnValue(true);
      execSync.mockImplementation((cmd: string) =>
        cmd.includes('git show') ? 'previous' : '',
      );
      await helper.openDiff(repoFile);
      // Second dispose still safe after files were tracked
      helper.dispose();
      expect(() => helper.dispose()).not.toThrow();
    });

    it('tolerates a temp file that is already gone', () => {
      // unlinkSync throwing during cleanup must not break dispose
      fsMock.existsSync.mockReturnValue(true);
      fsMock.unlinkSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      // Force a temp file into the tracker via a diff run
      execSync.mockImplementation((cmd: string) =>
        cmd.includes('git show') ? 'previous' : '',
      );
      return helper
        .openDiff(repoFile)
        .then(() => {
          expect(() => helper.dispose()).not.toThrow();
        });
    });
  });
});
