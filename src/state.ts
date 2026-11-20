import fs from 'node:fs';
import path from 'node:path';

export function sanitizeBranch(branch: string): string {
  return branch.replace(/\//g, '-');
}

export function getStateFilePath(stateDir: string, branch: string): string {
  return path.join(stateDir, `last_commit_${sanitizeBranch(branch)}.txt`);
}

export function readLastCommit(stateDir: string, branch: string): string | null {
  const filePath = getStateFilePath(stateDir, branch);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const content = fs.readFileSync(filePath, 'utf8').trim();
  return content.length > 0 ? content : null;
}

export function writeLastCommit(stateDir: string, branch: string, commitHash: string): void {
  fs.mkdirSync(stateDir, { recursive: true });
  const filePath = getStateFilePath(stateDir, branch);
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${commitHash.trim()}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}
