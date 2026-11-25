// @archon-test-isolated
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toBranchName } from '@archon/git';
import { IsolationFailure } from '@archon/isolation';
import { trackTempRoots } from '@archon/paths/test-utils';
import { registerBuiltinProviders } from '@archon/providers/in-process';
import {
  finalizeWorkflowSource,
  prepareWorkflowSource,
  preparedWorkflowSourceRecord,
  recordSelectedWorkflow,
} from '@archon/workflows/run-source';
import { clearPlatformPolicies, setPlatformPolicies } from '../platforms/registry';
import { createFileWorkflowHost } from './file-host';
import { startAdmittedResourceStart } from './resource-start-host';

const roots = trackTempRoots();
const originalEnv = Object.fromEntries(
  ['ARCHON_HOME', 'DATABASE_URL', 'GITHUB_APP_ID', 'GIT_CONFIG_GLOBAL'].map(key => [
    key,
    process.env[key],
  ])
);
let root: string;

beforeEach(async () => {
  root = roots(await realpath(await mkdtemp(join(tmpdir(), 'resource-branch-reuse-'))));
  process.env.ARCHON_HOME = join(root, 'home');
  process.env.DATABASE_URL = '';
  process.env.GITHUB_APP_ID = '';
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig');
  registerBuiltinProviders();
  setPlatformPolicies([{ id: 'test', workspaceRetention: 'retain' }]);
});

afterEach(() => {
  clearPlatformPolicies();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function registeredStart(fromBranch: string | undefined) {
  const repo = join(root, 'repo');
  const worktree = join(root, 'worktree');
  await mkdir(join(repo, '.archon', 'workflows'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'commit.gpgsign', 'false');
  await writeFile(
    join(repo, '.archon', 'config.yaml'),
    'defaults:\n  loadDefaultCommands: false\n  loadDefaultWorkflows: false\n'
  );
  await writeFile(
    join(repo, '.archon', 'workflows', 'report.yaml'),
    'name: report\ndescription: Report the execution checkout\nnodes:\n  - id: report\n    bash: pwd\n'
  );
  git(repo, 'add', '.archon');
  git(repo, 'commit', '-qm', 'initial');
  git(repo, 'branch', 'start-point');
  git(repo, 'worktree', 'add', '-qb', 'task', worktree);
  git(worktree, 'commit', '--allow-empty', '-qm', 'task work');
  git(repo, 'commit', '--allow-empty', '-qm', 'new base');

  const host = await createFileWorkflowHost(join(root, 'store'));
  const codebase = await host.records.codebases.createCodebase({
    name: 'test/repo',
    default_cwd: repo,
    default_branch: 'main',
  });
  const env = await host.records.isolation.create({
    codebase_id: codebase.id,
    workflow_type: 'task',
    workflow_id: 'task',
    provider: 'worktree',
    working_path: worktree,
    branch_name: toBranchName('task'),
    metadata: { base_branch: 'main' },
  });
  const prepared = await prepareWorkflowSource(host.deps, { sourceRoot: repo });
  await recordSelectedWorkflow(prepared.anchor.root, 'report');
  const source = await finalizeWorkflowSource(host.deps, prepared, {
    cwd: repo,
    codebaseId: codebase.id,
  });
  const admitted = await host.deps.store.admitResourceStart({
    resource: 'report',
    capacity: 1,
    hostId: 'host',
    overlap: 'queue',
    launch: {
      version: 2,
      run: {
        id: source.runId,
        workflow_name: 'report',
        codebase_id: codebase.id,
        working_path: repo,
        user_message: '',
        metadata: { workflow_source: preparedWorkflowSourceRecord(source) },
      },
      execution: {
        cwd: repo,
        conversationId: 'report',
        isolation: { kind: 'worktree', branch: 'task', ...(fromBranch ? { fromBranch } : {}) },
      },
    },
  });
  if (admitted.status !== 'admitted') throw new Error('Expected an admitted start');
  const submit = spyOn(host.engine, 'submit');
  const start = () =>
    startAdmittedResourceStart({
      requestId: admitted.requestId,
      hostId: 'host',
      host,
      createPlatform: () => ({
        sendMessage: async () => undefined,
        getPlatformType: () => 'test',
        getStreamingMode: () => 'batch',
      }),
    });
  return { repo, worktree, host, env, runId: source.runId, submit, start };
}

describe('a resource start reusing a registered branch worktree', () => {
  test.each(['main', 'HEAD'])('refuses a start point outside its history: %s', async fromBranch => {
    const { repo, worktree, host, env, runId, submit, start } = await registeredStart(fromBranch);
    const before = {
      head: git(worktree, 'rev-parse', 'HEAD'),
      branches: git(repo, 'show-ref', '--heads'),
      worktrees: git(repo, 'worktree', 'list', '--porcelain'),
      status: git(worktree, 'status', '--porcelain'),
    };
    const failure = await start().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(IsolationFailure);
    if (!(failure instanceof IsolationFailure)) throw new Error('Expected a start-point refusal');
    expect(failure.kind).toBe('branch_exists');
    expect(submit).not.toHaveBeenCalled();
    expect(await host.deps.store.getWorkflowRun(runId)).toMatchObject({ status: 'failed' });
    const events = await host.deps.store.listWorkflowEvents(runId);
    expect(events.some(event => event.event_type === 'node_started')).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        event_type: 'workflow_failed',
        data: expect.objectContaining({ error: failure.message, exit_reason: 'launch_failed' }),
      })
    );
    expect(await host.records.isolation.getById(env.id)).toEqual(env);
    expect({
      head: git(worktree, 'rev-parse', 'HEAD'),
      branches: git(repo, 'show-ref', '--heads'),
      worktrees: git(repo, 'worktree', 'list', '--porcelain'),
      status: git(worktree, 'status', '--porcelain'),
    }).toEqual(before);
  });

  test.each(['start-point', undefined])(
    'reuses the checkout with start point %s',
    async fromBranch => {
      const { worktree, host, env, runId, submit, start } = await registeredStart(fromBranch);
      const head = git(worktree, 'rev-parse', 'HEAD');
      expect(await start()).toMatchObject({
        success: true,
        workflowRunId: runId,
        summary: worktree,
      });
      expect(submit).toHaveBeenCalledTimes(1);
      expect(submit.mock.calls[0]?.[0].cwd).toBe(worktree);
      expect(await host.deps.store.getWorkflowRun(runId)).toMatchObject({ status: 'completed' });
      expect(await host.records.isolation.getById(env.id)).toMatchObject({
        status: 'active',
        working_path: worktree,
        metadata: { adopted: true },
      });
      expect(git(worktree, 'rev-parse', 'HEAD')).toBe(head);
    }
  );
});
