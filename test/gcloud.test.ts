import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import {
  gcloudConfig,
  GcloudError,
  gcloudInvocation,
  gcloudRunner,
  tokenSource,
  type Gcloud,
} from '../src/gcloud';

/** Returns a fake gcloud that answers with `outputs` in turn and counts runs. */
function fakeGcloud(...outputs: (string | Error)[]): Gcloud & { runs: number } {
  const fake = Object.assign(
    async () => {
      const output = outputs[Math.min(fake.runs++, outputs.length - 1)];
      if (output instanceof Error) throw output;
      return output;
    },
    { runs: 0 },
  );
  return fake;
}

let scripts: string;

before(async () => {
  scripts = await mkdtemp(path.join(tmpdir(), 'apigee-tools-gcloud-'));
});

after(async () => {
  await rm(scripts, { recursive: true, force: true });
});

/** Writes an executable shell script that stands in for gcloud. */
async function script(name: string, body: string): Promise<string> {
  const file = path.join(scripts, name);
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}

test('concurrent token requests run gcloud once', async () => {
  const gcloud = fakeGcloud('ya29.token\n');
  const tokens = tokenSource(gcloud);
  const [first, second] = await Promise.all([tokens.token(), tokens.token()]);
  assert.equal(first, 'ya29.token');
  assert.equal(second, 'ya29.token');
  assert.equal(gcloud.runs, 1);
});

test('a failed token request is not cached', async () => {
  const gcloud = fakeGcloud(new GcloudError('signedOut', 'no'), 'ya29.next');
  const tokens = tokenSource(gcloud);
  await assert.rejects(tokens.token(), { reason: 'signedOut' });
  assert.equal(await tokens.token(), 'ya29.next');
  assert.equal(gcloud.runs, 2);
});

test('concurrent renewals of the same token run gcloud once more', async () => {
  const gcloud = fakeGcloud('ya29.old', 'ya29.new');
  const tokens = tokenSource(gcloud);
  const stale = tokens.token();
  await stale;
  const renewed = await Promise.all([tokens.renew(stale), tokens.renew(stale)]);
  assert.deepEqual(renewed, ['ya29.new', 'ya29.new']);
  assert.equal(await tokens.token(), 'ya29.new');
  assert.equal(gcloud.runs, 2);
});

test('output that is not a token is rejected', async () => {
  const tokens = tokenSource(fakeGcloud('Updates are available\n'));
  await assert.rejects(tokens.token(), { reason: 'failed' });
});

test('gcloud starts directly outside Windows', () => {
  assert.deepEqual(
    gcloudInvocation(
      '/opt/sdk/bin/gcloud',
      ['auth', 'print-access-token'],
      'linux',
    ),
    {
      file: '/opt/sdk/bin/gcloud',
      args: ['auth', 'print-access-token'],
      shell: false,
    },
  );
});

test('gcloud runs as one quoted command line on Windows', () => {
  assert.deepEqual(
    gcloudInvocation(
      'C:\\Program Files\\Google\\Cloud SDK\\bin\\gcloud.cmd',
      ['auth', 'print-access-token'],
      'win32',
    ),
    {
      file: '"C:\\Program Files\\Google\\Cloud SDK\\bin\\gcloud.cmd" auth print-access-token',
      args: [],
      shell: true,
    },
  );
  for (const unsafe of ['C:\\a"b\\gcloud.cmd', 'C:\\%PATH%\\gcloud.cmd']) {
    assert.throws(() => gcloudInvocation(unsafe, ['auth'], 'win32'), {
      reason: 'failed',
    });
  }
});

test('invalid configuration names are rejected', () => {
  assert.throws(() => gcloudRunner('gcloud', 'dev && calc'), {
    reason: 'failed',
  });
});

test('a command that is not on the PATH is reported as missing', async () => {
  // Elsewhere than on Windows, running it fails with ENOENT
  const gcloud = gcloudRunner('apigee-tools-no-such-command');
  await assert.rejects(gcloud(['version']), { reason: 'missing' });
});

test('gcloud runs in the home directory without prompts', async t => {
  if (process.platform === 'win32') return t.skip('uses a shell script');
  const file = await script(
    'echo-gcloud',
    'echo "$PWD|$CLOUDSDK_CORE_DISABLE_PROMPTS|$*"',
  );
  const output = await gcloudRunner(file, 'dev')(['config', 'list']);
  assert.equal(output.trim(), `${homedir()}|1|config list --configuration=dev`);
});

test('a missing sign-in is reported as signed out', async t => {
  if (process.platform === 'win32') return t.skip('uses a shell script');
  const file = await script(
    'signed-out-gcloud',
    'echo "ERROR: (gcloud.auth.print-access-token) You do not currently have an active account selected." >&2\nexit 1',
  );
  await assert.rejects(gcloudRunner(file)(['auth']), { reason: 'signedOut' });
});

test('other gcloud errors keep their message', async t => {
  if (process.platform === 'win32') return t.skip('uses a shell script');
  const file = await script(
    'failing-gcloud',
    'echo "WARNING: something" >&2\necho "ERROR: (gcloud.config.list) Invalid value" >&2\nexit 1',
  );
  await assert.rejects(gcloudRunner(file)(['config']), {
    reason: 'failed',
    message: 'ERROR: (gcloud.config.list) Invalid value',
  });
});

test('the configuration provides account, project, and endpoint', async () => {
  const gcloud = fakeGcloud(
    JSON.stringify({
      core: { account: 'dev@example.com', project: 'acme-apis' },
      api_endpoint_overrides: { apigee: 'https://eu-apigee.googleapis.com/' },
    }),
  );
  assert.deepEqual(await gcloudConfig(gcloud), {
    account: 'dev@example.com',
    project: 'acme-apis',
    endpoint: 'https://eu-apigee.googleapis.com/',
  });
});

test('a configured path that does not exist is missing without running', async () => {
  const gcloud = gcloudRunner(path.join(scripts, 'no-such-folder', 'gcloud'));
  await assert.rejects(gcloud(['version']), { reason: 'missing' });
});

test('a leading ~ in the configured path means the home directory', async () => {
  const gcloud = gcloudRunner('~/no-such-folder-for-apigee-tools/gcloud');
  const expected = path.join(
    homedir(),
    'no-such-folder-for-apigee-tools',
    'gcloud',
  );
  await assert.rejects(gcloud(['version']), (error: GcloudError) => {
    assert.equal(error.reason, 'missing');
    assert.ok(error.message.includes(expected), error.message);
    return true;
  });
});
