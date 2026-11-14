import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { testOrg, zip, type Context } from '../scripts/test-org';
import { tokenSource } from '../src/gcloud';
import { unzip } from '../src/revision';

type Request = { method: string; path: string; body?: unknown };

/** Serves `answer` as the Apigee API and records each request. */
function serve(
  t: TestContext,
  answer: (request: Request) => { status?: number; body?: unknown },
) {
  const requests: Request[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string, init: RequestInit) => {
      const url = new URL(input);
      const raw = init.body;
      const body =
        raw instanceof FormData
          ? Buffer.from(await (raw.get('file') as Blob).arrayBuffer())
          : typeof raw === 'string'
            ? JSON.parse(raw)
            : undefined;
      const request = {
        method: init.method ?? 'GET',
        path: `${url.pathname.slice('/v1'.length)}${url.search}`,
        body,
      };
      requests.push(request);
      const { status = 200, body: reply = {} } = answer(request);
      return new Response(JSON.stringify(reply), { status });
    },
  );
  return requests;
}

/** A context whose gcloud calls and waits are only recorded. */
function context(
  billing = 'True',
): Context & { gcloudCalls: string[][]; lines: string[] } {
  const gcloudCalls: string[][] = [];
  const lines: string[] = [];
  return {
    tokens: tokenSource(async () => 'ya29.test'),
    gcloud: args => void gcloudCalls.push(args),
    read: async () => `${billing}\n`,
    sleep: async () => {},
    log: line => void lines.push(line),
    gcloudCalls,
    lines,
  };
}

test('zip packs bundle files that unzip reads back', () => {
  const files = new Map([
    ['apiproxy/hello.xml', Buffer.from('<APIProxy name="hello"/>\n')],
    ['apiproxy/resources/oas/hällo.yaml', Buffer.from('openapi: 3.0.0\n')],
  ]);
  assert.deepEqual(unzip(zip(files)), files);
});

test('provision enables Apigee and waits until the organization is active', async t => {
  let checks = 0;
  const requests = serve(t, ({ method, path }) => {
    if (method === 'GET' && path === '/organizations/acme-test') {
      return ++checks < 3 ? { status: 403 } : { body: { state: 'ACTIVE' } };
    }
    return { body: { name: 'organizations/acme-test/operations/1' } };
  });
  const run = context();
  await testOrg(run).provision('acme-test');
  assert.deepEqual(run.gcloudCalls, [
    [
      'services',
      'enable',
      'apigee.googleapis.com',
      'cloudkms.googleapis.com',
      '--project=acme-test',
    ],
  ]);
  const provision = requests.find(request => request.method === 'POST');
  assert.deepEqual(provision, {
    method: 'POST',
    path: '/projects/acme-test:provisionOrganization',
    body: {
      analyticsRegion: 'europe-west3',
      runtimeLocation: 'europe-west3',
      disableVpcPeering: true,
    },
  });
  assert.equal(checks, 3);
});

test('provision leaves an existing organization alone', async t => {
  const requests = serve(t, () => ({ body: { state: 'ACTIVE' } }));
  const run = context();
  await testOrg(run).provision('acme-test');
  assert.deepEqual(run.gcloudCalls, []);
  assert.deepEqual(
    requests.map(request => request.method),
    ['GET'],
  );
});

/** Answers like an evaluation organization; `existing` adds the test setup. */
function evaluation(existing = false) {
  let revision = 0;
  let instanceChecks = 0;
  let operationChecks = 0;
  const answer = ({ method, path }: Request) => {
    const route = `${method} ${path.split('?')[0]}`;
    switch (route) {
      case 'GET /organizations/acme-test':
        return { body: { state: 'ACTIVE', billingType: 'EVALUATION' } };
      case 'GET /organizations/acme-test/instances':
        // The instance is still being created on the first request
        return {
          body: {
            instances: [
              {
                name: 'europe-west3',
                state: ++instanceChecks === 1 ? 'CREATING' : 'ACTIVE',
              },
            ],
          },
        };
      case 'GET /organizations/acme-test/environments':
        return { body: existing ? ['eval', 'test'] : ['eval'] };
      case 'GET /organizations/acme-test/instances/europe-west3/attachments':
        return {
          body: existing ? { attachments: [{ environment: 'test' }] } : {},
        };
      case 'GET /organizations/acme-test/envgroups':
        return {
          body: {
            environmentGroups: [
              { name: 'eval-group' },
              ...(existing ? [{ name: 'test-group' }] : []),
            ],
          },
        };
      case 'GET /organizations/acme-test/envgroups/test-group/attachments':
        return {
          body: existing
            ? { environmentGroupAttachments: [{ environment: 'test' }] }
            : {},
        };
      case 'GET /organizations/acme-test/operations/1':
        return { body: { done: ++operationChecks > 1 } };
      case 'POST /organizations/acme-test/apis':
      case 'POST /organizations/acme-test/sharedflows':
        return { body: { revision: String(++revision) } };
    }
    if (route.startsWith('POST ') && route.endsWith('/deployments')) {
      return { body: {} };
    }
    if (route.startsWith('GET ') && route.endsWith('/deployments')) {
      return { body: { state: 'READY' } };
    }
    if (route.startsWith('POST ')) {
      return {
        body: { name: 'organizations/acme-test/operations/1', done: false },
      };
    }
    return { status: 404 };
  };
  return { answer, checks: () => ({ instanceChecks, operationChecks }) };
}

test('populate adds the test environment and group and deploys the fixtures', async t => {
  const fake = evaluation();
  const requests = serve(t, fake.answer);
  await testOrg(context()).populate('acme-test');
  assert.equal(fake.checks().instanceChecks, 2);
  assert.ok(fake.checks().operationChecks >= 2, 'operations are polled');
  const posts = requests.filter(request => request.method === 'POST');
  assert.deepEqual(
    posts.map(request => request.path),
    [
      '/organizations/acme-test/environments',
      '/organizations/acme-test/instances/europe-west3/attachments',
      '/organizations/acme-test/envgroups',
      '/organizations/acme-test/envgroups/test-group/attachments',
      '/organizations/acme-test/apis?name=hello&action=import',
      '/organizations/acme-test/apis?name=hello&action=import',
      '/organizations/acme-test/sharedflows?name=traffic-shared&action=import',
      '/organizations/acme-test/environments/eval/apis/hello/revisions/1/deployments?override=true',
      '/organizations/acme-test/environments/test/apis/hello/revisions/2/deployments?override=true',
      '/organizations/acme-test/environments/eval/sharedflows/traffic-shared/revisions/3/deployments?override=true',
    ],
  );
  assert.deepEqual(posts[2].body, {
    name: 'test-group',
    hostnames: ['test.apigee-tools.example'],
  });

  // The second revision differs from the fixture in one policy
  const [same, different] = posts
    .slice(4, 6)
    .map(post => unzip(post.body as Buffer));
  const policy = 'apiproxy/policies/SA-Limit.xml';
  assert.match(same.get(policy)!.toString(), /30ps/);
  assert.match(different.get(policy)!.toString(), /40ps/);
});

test('populate again only imports and deploys', async t => {
  const requests = serve(t, evaluation(true).answer);
  await testOrg(context()).populate('acme-test');
  const posts = requests.filter(request => request.method === 'POST');
  assert.equal(posts.length, 6);
  assert.ok(
    posts.every(
      request =>
        request.path.includes('action=import') ||
        request.path.endsWith('/deployments?override=true'),
    ),
  );
});

test('populate and delete change only evaluation organizations', async t => {
  const requests = serve(t, () => ({
    body: { state: 'ACTIVE', billingType: 'PAYG' },
  }));
  const commands = testOrg(context());
  await assert.rejects(
    commands.populate('acme-test'),
    /not an evaluation organization/,
  );
  await assert.rejects(
    commands.delete('acme-test'),
    /not an evaluation organization/,
  );
  assert.ok(requests.every(request => request.method === 'GET'));
});

test('provision treats a running provisioning as started', async t => {
  let checks = 0;
  serve(t, ({ method }) => {
    if (method === 'GET') {
      return ++checks < 3 ? { status: 403 } : { body: { state: 'ACTIVE' } };
    }
    return { status: 409, body: { error: { message: 'already exists' } } };
  });
  const run = context();
  await testOrg(run).provision('acme-test');
  assert.ok(run.lines.includes('Provisioning is already running.'));
});

test('delete waits until the organization is gone', async t => {
  let checks = 0;
  const requests = serve(t, ({ method }) =>
    method !== 'GET'
      ? { body: {} }
      : ++checks > 2
        ? { status: 403 }
        : { body: { state: 'ACTIVE', billingType: 'EVALUATION' } },
  );
  const run = context();
  await testOrg(run).delete('acme-test');
  assert.deepEqual(
    requests.slice(0, 2).map(request => request.method),
    ['GET', 'DELETE'],
  );
  assert.match(run.lines.at(-1)!, /^Deleted\./);
});

test('provision stops before any change when billing is off', async t => {
  const requests = serve(t, () => ({ status: 403 }));
  const run = context('False');
  await assert.rejects(
    testOrg(run).provision('acme-test'),
    /no active billing account/,
  );
  assert.deepEqual(run.gcloudCalls, []);
  assert.deepEqual(
    requests.map(request => request.method),
    ['GET'],
  );
});

test('provision waits until a newly enabled Apigee API is available', async t => {
  let attempts = 0;
  serve(t, ({ method, path }) => {
    if (method === 'GET') {
      return attempts < 2 ? { status: 403 } : { body: { state: 'ACTIVE' } };
    }
    if (path.endsWith(':provisionOrganization') && ++attempts === 1) {
      return {
        status: 403,
        body: {
          error: {
            message:
              'Apigee API has not been used in project acme-test before or it is disabled.',
          },
        },
      };
    }
    return { body: {} };
  });
  const run = context();
  await testOrg(run).provision('acme-test');
  assert.equal(attempts, 2);
  assert.ok(run.lines.some(line => line.startsWith('Waiting until')));
});
