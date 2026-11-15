import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import {
  drafts,
  history,
  pins,
  sampleBundles,
  testOrg,
  zip,
  type Context,
} from '../scripts/test-org';
import { tokenSource } from '../src/gcloud';
import { differs, fingerprints, readBundle, unzip } from '../src/revision';

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
      return new Response(
        Buffer.isBuffer(reply) ? new Uint8Array(reply) : JSON.stringify(reply),
        { status },
      );
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

/**
 * Answers like an evaluation organization and keeps what the commands create,
 * so that a second run sees the first one's results.
 */
function evaluation() {
  const environments = ['eval'];
  const instance = ['eval'];
  const groups = new Map([['eval-group', ['eval']]]);
  const bundles = new Map<string, Buffer[]>();
  const deployments: Record<
    'environment' | 'kind' | 'name' | 'revision',
    string
  >[] = [];
  const created = new Set<string>();
  const revoked = new Set<string>();
  let instanceChecks = 0;
  const operation = {
    body: { name: 'organizations/acme-test/operations/1', done: false },
  };
  const answer = ({ method, path, body }: Request) => {
    const url = new URL(path, 'https://apigee.test');
    const route = `${method} ${url.pathname.replace('/organizations/acme-test', '')}`;
    const named = body as {
      name?: string;
      email?: string;
      environment?: string;
    };
    let match: RegExpExecArray | null;
    switch (route) {
      case 'GET ':
        return { body: { state: 'ACTIVE', billingType: 'EVALUATION' } };
      case 'GET /instances':
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
      case 'GET /environments':
        return { body: environments };
      case 'POST /environments':
        environments.push(named.name!);
        return operation;
      case 'GET /instances/europe-west3/attachments':
        return {
          body: { attachments: instance.map(environment => ({ environment })) },
        };
      case 'POST /instances/europe-west3/attachments':
        instance.push(named.environment!);
        return operation;
      case 'GET /envgroups':
        return {
          body: {
            environmentGroups: [...groups.keys()].map(name => ({ name })),
          },
        };
      case 'POST /envgroups':
        groups.set(named.name!, []);
        return operation;
      case 'GET /deployments': {
        const kind =
          url.searchParams.get('sharedFlows') === 'true'
            ? 'sharedflows'
            : 'apis';
        return {
          body: {
            deployments: deployments
              .filter(item => item.kind === kind)
              .map(item => ({ ...item, apiProxy: item.name })),
          },
        };
      }
    }
    if (route.startsWith('GET /operations/')) return { body: { done: true } };

    // Attachments have generated names, as in Apigee
    if (
      (match = /^(GET|POST) \/envgroups\/([^/]+)\/attachments$/.exec(route))
    ) {
      const attached = groups.get(match[2])!;
      if (method === 'POST') {
        attached.push(named.environment!);
        return operation;
      }
      const items = attached.map(environment => ({
        name: `attachment-${environment}`,
        environment,
      }));
      return { body: { environmentGroupAttachments: items } };
    }
    if (
      (match = /^DELETE \/envgroups\/([^/]+)\/attachments\/(.+)$/.exec(route))
    ) {
      const attached = groups.get(match[1])!;
      const index = attached.findIndex(
        environment => `attachment-${environment}` === match![2],
      );
      if (index < 0) return { status: 404 };
      attached.splice(index, 1);
      return operation;
    }
    if ((match = /^POST \/(apis|sharedflows)$/.exec(route))) {
      const key = `${match[1]}/${url.searchParams.get('name')}`;
      bundles.set(key, [...(bundles.get(key) ?? []), body as Buffer]);
      return { body: { revision: String(bundles.get(key)!.length) } };
    }
    if (
      (match =
        /^GET \/(apis|sharedflows)\/([^/]+)\/revisions(?:\/(\d+))?$/.exec(
          route,
        ))
    ) {
      const list = bundles.get(`${match[1]}/${match[2]}`);
      if (!list) return { status: 404 };
      if (!match[3]) return { body: list.map((_, index) => String(index + 1)) };

      // Apigee writes the descriptor and manifests anew on import
      const files = unzip(list[Number(match[3]) - 1]);
      for (const [file, content] of files) {
        if (/^[^/]+\/[^/]+\.xml$/.test(file)) {
          const stamp = `<!-- revision ${match[3]} -->\n`;
          files.set(file, Buffer.concat([content, Buffer.from(stamp)]));
        }
      }
      const directory = match[1] === 'apis' ? 'apiproxy' : 'sharedflowbundle';
      files.set(
        `${directory}/manifests/manifest.xml`,
        Buffer.from('<Manifest name="manifest"/>\n'),
      );
      return { body: zip(files) };
    }
    match =
      /^(POST|GET) \/environments\/([^/]+)\/(apis|sharedflows)\/([^/]+)\/revisions\/(\d+)\/deployments$/.exec(
        route,
      );
    if (match) {
      const [, verb, environment, kind, name, revision] = match;
      if (Number(revision) > (bundles.get(`${kind}/${name}`)?.length ?? 0)) {
        return { status: 404, body: { error: { message: 'no revision' } } };
      }
      if (verb === 'POST') {
        // The deployment replaces the running revision
        const others = deployments.filter(
          item =>
            item.environment !== environment ||
            item.kind !== kind ||
            item.name !== name,
        );
        deployments.splice(0, Infinity, ...others, {
          environment,
          kind,
          name,
          revision,
        });
        return { body: {} };
      }
      if (name === 'admin') {
        return {
          body: { state: 'ERROR', errors: [{ message: 'MarshalFailure' }] },
        };
      }

      // With test in eval-group, base paths deployed in both environments clash
      const clashing =
        environment === 'test' &&
        groups.get('eval-group')!.includes('test') &&
        deployments.some(
          item => item.environment === 'eval' && item.name === name,
        );
      const routeConflicts = clashing
        ? [
            {
              environmentGroup: 'eval-group',
              conflictingDeployment: { apiProxy: name, environment: 'eval' },
            },
          ]
        : [];
      return { body: { state: 'READY', routeConflicts } };
    }
    if (method === 'PUT' && route.includes('/flowhooks/')) return { body: {} };
    if (
      (match = /^(GET|POST) \/developers\/[^/]+\/apps\/([^/]+)$/.exec(route))
    ) {
      if (method === 'POST') revoked.add(match[2]);
      return {
        body: { status: revoked.has(match[2]) ? 'revoked' : 'approved' },
      };
    }
    if (method === 'POST') {
      // Everything else is created once and exists afterwards
      const key = `${path} ${Buffer.isBuffer(body) ? '' : (named?.name ?? named?.email ?? '')}`;
      if (created.has(key)) {
        return { status: 409, body: { error: { message: 'already exists' } } };
      }
      created.add(key);
      return { body: {} };
    }
    return { status: 404 };
  };
  return { answer, bundles, deployments, groups };
}

test('populate deploys the sample shop as its files describe', async t => {
  const org = evaluation();
  const requests = serve(t, org.answer);
  const run = context();
  await testOrg(run).populate('acme-test');
  const posts = requests.filter(request => request.method === 'POST');
  assert.deepEqual(
    posts.slice(0, 4).map(request => request.path),
    [
      '/organizations/acme-test/environments',
      '/organizations/acme-test/instances/europe-west3/attachments',
      '/organizations/acme-test/envgroups',
      '/organizations/acme-test/envgroups/test-group/attachments',
    ],
  );
  assert.deepEqual(posts[2].body, {
    name: 'test-group',
    hostnames: ['test.apigee-tools.example'],
  });
  const gets = requests.filter(request => request.method === 'GET');
  assert.equal(
    gets.filter(item => item.path === '/organizations/acme-test/instances')
      .length,
    2,
    'populate waits for the instance',
  );
  assert.ok(gets.some(item => item.path.includes('/operations/')));

  // Environment configuration, with Cloud Code's field names translated
  const payments = posts.find(
    request => (request.body as { name?: string })?.name === 'payments-backend',
  );
  const server = payments?.body as {
    isEnabled?: boolean;
    sSLInfo?: { keyStore?: string };
  };
  assert.equal(
    payments?.path,
    '/organizations/acme-test/environments/eval/targetservers',
  );
  assert.equal(server.isEnabled, true);
  assert.equal(server.sSLInfo?.keyStore, 'ref://payments-keystore');
  const aliases = posts.filter(request =>
    request.path.includes('/aliases?format=selfsignedcert&'),
  );
  assert.equal(aliases.length, 2);
  assert.equal(requests.filter(request => request.method === 'PUT').length, 3);

  // Every bundle but the drafts, the history before the local files
  const bundles = await sampleBundles();
  for (const bundle of bundles) {
    const imported = org.bundles.get(`${bundle.kind}/${bundle.name}`) ?? [];
    const expected = drafts.has(bundle.name)
      ? 0
      : (history[bundle.name]?.length ?? 0) + 1;
    assert.equal(imported.length, expected, bundle.name);
  }
  const older = unzip(org.bundles.get('apis/orders-v1')![0]);
  assert.ok(older.has('apiproxy/policies/AM-LegacyOrderHeader.xml'));
  assert.ok(!older.has('apiproxy/policies/JS-ValidateOrder.xml'));

  // Shared flows deploy before the flow hooks, which come before the proxies
  const steps = requests.flatMap(request => {
    if (request.method === 'PUT') return ['hook'];
    if (request.method !== 'POST' || !request.path.endsWith('?override=true')) {
      return [];
    }
    return [request.path.includes('/sharedflows/') ? 'flow' : 'proxy'];
  });
  assert.ok(steps.lastIndexOf('flow') < steps.indexOf('hook'));
  assert.ok(steps.lastIndexOf('hook') < steps.indexOf('proxy'));

  // Pins choose older revisions in test that differ from the local bundle;
  // the eval environment runs the newest
  const running = (environment: string, name: string) =>
    org.deployments.find(
      item => item.environment === environment && item.name === name,
    )?.revision;
  for (const [name, revision] of Object.entries(pins.test)) {
    assert.ok(revision <= history[name].length, `${name} pins a history entry`);
    assert.equal(running('test', name), String(revision), name);
    assert.equal(running('eval', name), String(history[name].length + 1), name);
    const bundle = bundles.find(item => item.name === name)!;
    const stored = org.bundles.get(`${bundle.kind}/${name}`)!;
    const local = await readBundle(bundle.directory, bundle.kind);
    assert.ok(
      differs(fingerprints(unzip(stored[revision - 1])), fingerprints(local)),
      name,
    );
  }
  assert.equal(running('test', 'payments'), undefined);
  assert.ok(
    run.lines.some(line => /^- admin revision 1 in eval is ERROR/.test(line)),
  );

  // Products come before the apps that use them; one app is revoked
  const paths = posts.map(request => request.path);
  const products = paths.findIndex(item => item.endsWith('/apiproducts'));
  const apps = paths.findIndex(item => /\/developers\/[^/]+\/apps$/.test(item));
  assert.ok(products >= 0 && products < apps);
  assert.equal(paths.filter(item => item.endsWith('?action=revoke')).length, 1);

  // A second run neither imports nor deploys nor revokes again, although
  // downloaded revisions carry Apigee's own descriptor and manifest
  const before = requests.length;
  await testOrg(context()).populate('acme-test');
  const repeated = requests
    .slice(before)
    .filter(request => request.method === 'POST')
    .map(request => request.path);
  assert.deepEqual(
    repeated.filter(item => /action=(import|revoke)|override=true/.test(item)),
    [],
  );
});

test('conflict attaches test to eval-group, which populate refuses', async t => {
  const org = evaluation();
  const requests = serve(t, org.answer);
  const run = context();
  const commands = testOrg(run);
  await commands.populate('acme-test');
  await commands.conflict('acme-test', 'on');
  assert.deepEqual(org.groups.get('eval-group'), ['eval', 'test']);
  await assert.rejects(
    commands.populate('acme-test'),
    /Route conflicts are on/,
  );

  // status names the conflicting deployment
  run.lines.length = 0;
  await commands.status('acme-test');
  assert.ok(
    run.lines.includes(
      'API proxy catalog-v1 revision 1 in test: READY - route conflict with catalog-v1 in eval (eval-group)',
    ),
  );
  await commands.conflict('acme-test', 'off');
  assert.deepEqual(org.groups.get('eval-group'), ['eval']);
  assert.ok(
    requests.some(
      request =>
        request.method === 'DELETE' &&
        request.path ===
          '/organizations/acme-test/envgroups/eval-group/attachments/attachment-test',
    ),
  );
  await assert.rejects(
    commands.conflict('acme-test', 'maybe'),
    /Choose on or off/,
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
  await assert.rejects(
    commands.conflict('acme-test', 'on'),
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

test('changes locked by another operation are retried', async t => {
  const fake = evaluation();
  let rejected = 0;
  serve(t, request => {
    const importing =
      request.method === 'POST' && request.path.includes('action=import');
    if (importing && rejected < 2) {
      rejected++;
      return {
        status: 400,
        body: {
          error: {
            message:
              'the resource is locked by another operation that is 25 percent completed so far',
          },
        },
      };
    }
    return fake.answer(request);
  });
  const run = context();
  await testOrg(run).populate('acme-test');
  assert.equal(rejected, 2);
  assert.ok(
    run.lines.some(line => line.startsWith('Waiting for another operation')),
  );
});
