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

test('populate adds the test environment and group and deploys the fixtures', async t => {
  let revision = 0;
  let instanceChecks = 0;
  const requests = serve(t, ({ method, path }) => {
    switch (`${method} ${path.split('?')[0]}`) {
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
        return { body: ['eval'] };
      case 'GET /organizations/acme-test/envgroups':
        return { body: { environmentGroups: [{ name: 'eval-group' }] } };
      case 'POST /organizations/acme-test/apis':
      case 'POST /organizations/acme-test/sharedflows':
        return { body: { revision: String(++revision) } };
      default:
        // Lists are empty, and operations are done at once
        return {
          body: { name: 'organizations/acme-test/operations/1', done: true },
        };
    }
  });
  await testOrg(context()).populate('acme-test');
  assert.equal(instanceChecks, 2);
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

test('delete waits until the organization is gone', async t => {
  let checks = 0;
  const requests = serve(t, ({ method }) =>
    method === 'GET' && ++checks > 1 ? { status: 403 } : { body: {} },
  );
  const run = context();
  await testOrg(run).delete('acme-test');
  assert.equal(requests[0].method, 'DELETE');
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
