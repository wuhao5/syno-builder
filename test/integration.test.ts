import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { checkAndBuildBranch } from '../src/builder.js';
import type { Config } from '../src/config.js';
import { readLastCommit } from '../src/state.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trim();
}

describe('checkAndBuildBranch integration', () => {
  it('clones, builds via BUILD_SCRIPT, skips unchanged commits, and rebuilds on new commits', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'syno-builder-e2e-'));
    try {
      const originDir = path.join(tmp, 'origin.git');
      const workDir = path.join(tmp, 'work');
      const repoDir = path.join(tmp, 'repo');
      const stateDir = path.join(tmp, 'state');
      const secretsDir = path.join(tmp, 'secrets');
      const buildOutputFile = path.join(tmp, 'build-runs.jsonl');
      const buildScriptPath = path.join(tmp, 'custom-build.sh');

      fs.mkdirSync(originDir, { recursive: true });
      fs.mkdirSync(workDir, { recursive: true });
      fs.mkdirSync(secretsDir, { recursive: true });

      // Initialize bare remote + initial commit on main
      git(originDir, ['init', '--bare', '--initial-branch=main']);
      git(workDir, ['init', '--initial-branch=main']);
      git(workDir, ['remote', 'add', 'origin', originDir]);
      fs.writeFileSync(path.join(workDir, 'Dockerfile'), 'FROM alpine:latest\n');
      git(workDir, ['add', 'Dockerfile']);
      git(workDir, ['commit', '-m', 'initial commit']);
      const firstCommit = git(workDir, ['rev-parse', 'HEAD']);
      git(workDir, ['push', '-u', 'origin', 'main']);

      // Custom build script that logs exported env vars
      fs.writeFileSync(
        buildScriptPath,
        `#!/bin/sh
echo "{\\"branch\\":\\"$BRANCH\\",\\"commit\\":\\"$GIT_COMMIT_HASH\\",\\"tag\\":\\"$IMAGE_TAG\\",\\"latest\\":\\"$IMAGE_LATEST\\"}" >> "${buildOutputFile}"
`,
        { mode: 0o755 },
      );

      const cfg: Config = {
        gitRepo: originDir,
        gitBranches: ['main'],
        gitPat: '',
        gitPatSource: 'none',
        gitPatFile: path.join(secretsDir, 'pat'),
        triggerMode: 'poll',
        runOnStartup: true,
        checkIntervalMinutes: 60,
        gitTimeoutMs: 300_000,
        buildTimeoutMs: 1_800_000,
        dockerfilePath: '.',
        dockerImageName: 'testapp',
        dockerBuildFlags: [],
        shouldTagEachBuild: true,
        buildScript: buildScriptPath,
        webhookPort: 9000,
        webhookHost: '127.0.0.1',
        webhookPath: '/webhook',
        webhookSecret: '',
        webhookSecretSource: 'none',
        webhookSecretFile: path.join(secretsDir, 'webhook_secret'),
        repoDir,
        stateDir,
        secretsDir,
      };

      // First run should clone & build
      const run1 = await checkAndBuildBranch(cfg, 'main');
      assert.equal(run1, 'built');
      assert.equal(readLastCommit(stateDir, 'main'), firstCommit);

      // Second run with no new commit should skip
      const run2 = await checkAndBuildBranch(cfg, 'main');
      assert.equal(run2, 'unchanged');

      // Push a second commit to origin/main
      fs.writeFileSync(path.join(workDir, 'Dockerfile'), 'FROM alpine:3.20\n');
      git(workDir, ['add', 'Dockerfile']);
      git(workDir, ['commit', '-m', 'second commit']);
      const secondCommit = git(workDir, ['rev-parse', 'HEAD']);
      git(workDir, ['push', 'origin', 'main']);

      // Third run should detect change & rebuild
      const run3 = await checkAndBuildBranch(cfg, 'main');
      assert.equal(run3, 'built');
      assert.equal(readLastCommit(stateDir, 'main'), secondCommit);

      const lines = fs
        .readFileSync(buildOutputFile, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, string>);

      assert.equal(lines.length, 2);
      assert.deepEqual(lines[0], {
        branch: 'main',
        commit: firstCommit,
        tag: `testapp:main-${firstCommit.slice(0, 7)}`,
        latest: 'testapp:latest',
      });
      assert.deepEqual(lines[1], {
        branch: 'main',
        commit: secondCommit,
        tag: `testapp:main-${secondCommit.slice(0, 7)}`,
        latest: 'testapp:latest',
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
