import fs from 'node:fs';
import path from 'node:path';

export function sanitizeBranch(branch: string): string {
  return branch.replace(/\//g, '-');
}

export function sanitizeDockerTag(ref: string): string {
  const cleaned = ref
    .replace(/\//g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/^[.-]+/, '');
  return cleaned.length > 0 ? cleaned.slice(0, 128) : 'tag';
}

export function sanitizeStateKey(ref: string): string {
  return ref.replace(/[^a-zA-Z0-9._-]/g, '-');
}

export function getStateFilePath(stateDir: string, branch: string): string {
  return path.join(stateDir, `last_commit_${sanitizeBranch(branch)}.txt`);
}

export function getTagStateFilePath(stateDir: string, tag: string): string {
  return path.join(stateDir, `last_tag_${sanitizeStateKey(tag)}.txt`);
}

function readCommitFile(filePath: string): string | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const content = fs.readFileSync(filePath, 'utf8').trim();
  return content.length > 0 ? content : null;
}

function writeCommitFile(filePath: string, commitHash: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${commitHash.trim()}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

export function readLastCommit(stateDir: string, branch: string): string | null {
  return readCommitFile(getStateFilePath(stateDir, branch));
}

export function writeLastCommit(stateDir: string, branch: string, commitHash: string): void {
  writeCommitFile(getStateFilePath(stateDir, branch), commitHash);
}

export function readLastTagCommit(stateDir: string, tag: string): string | null {
  return readCommitFile(getTagStateFilePath(stateDir, tag));
}

export function writeLastTagCommit(stateDir: string, tag: string, commitHash: string): void {
  writeCommitFile(getTagStateFilePath(stateDir, tag), commitHash);
}
