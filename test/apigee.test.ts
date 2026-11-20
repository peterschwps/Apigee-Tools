import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import {
  apiBase,
  ApigeeError,
  apigeeClient,
  applyStatus,
  cellOf,
  deployedRevisions,
  loadFlowHooks,
  loadOverview,
  loadRows,
  relationshipsOf,
  statusTargets,
} from '../src/apigee';
import { tokenSource } from '../src/gcloud';
import type { Cell, Row } from '../src/protocol';

const base = 'https://apigee.googleapis.com/v1';

type Handler = (path: string, token: string) => Response | Promise<Response>;

/** Replaces fetch with `handler` and records each request's path and token. */
function serve(t: TestContext, handler: Handler) {
  const requests: { path: string; token: string }[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string, init: RequestInit) => {
      const url = new URL(input);
      const headers = init.headers as Record<string, string>;
      const request = {
        path: `${url.pathname.slice('/v1'.length)}${url.search}`,
        token: headers.authorization.slice('Bearer '.length),
      };
      requests.push(request);
      return handler(request.path, request.token);
    },
  );
  return requests;
}

/** Answers with a JSON body. */
function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Creates a client whose gcloud hands out `token-1`, `token-2`, and so on. */
function client(concurrency?: number) {
  let runs = 0;
  return apigeeClient(
    tokenSource(async () => `token-${++runs}`),
    base,
    { concurrency },
  );
}

test('the API base accepts only Apigee endpoints', () => {
  assert.equal(apiBase(), 'https://apigee.googleapis.com/v1');
  assert.equal(
    apiBase('https://eu-apigee.googleapis.com/'),
    'https://eu-apigee.googleapis.com/v1',
  );
  assert.equal(
    apiBase('https://apigee.us.rep.googleapis.com/'),
    'https://apigee.us.rep.googleapis.com/v1',
  );
  for (const endpoint of [
    'http://apigee.googleapis.com/',
    'https://apigee.googleapis.com.example.com/',
    'https://example.com/apigee.googleapis.com',
    'https://storage.googleapis.com/',
  ]) {
    assert.throws(() => apiBase(endpoint), ApigeeError, endpoint);
  }
});

test('a rejected token is renewed once and the request repeated', async t => {
  const requests = serve(t, (_path, token) =>
    token === 'token-1' ? reply({}, 401) : reply({ organizations: [] }),
  );
  assert.deepEqual(await client().organizations(), []);
  assert.deepEqual(
    requests.map(request => request.token),
    ['token-1', 'token-2'],
  );
});

test('a second rejection asks to sign in again', async t => {
  serve(t, () =>
    reply({ error: { message: 'Request had invalid credentials.' } }, 401),
  );
  await assert.rejects(client().organizations(), {
    status: 401,
    message: 'Request had invalid credentials.',
    hint: /gcloud auth login/,
  });
});

test('missing permissions point to the read-only role', async t => {
  serve(t, () =>
    reply(
      { error: { message: "Permission 'apigee.deployments.list' denied" } },
      403,
    ),
  );
  await assert.rejects(client().deployments('acme', 'apis'), {
    status: 403,
    message: "Permission 'apigee.deployments.list' denied",
    hint: /roles\/apigee\.readOnlyAdmin/,
  });
});

test('an exhausted quota says to try again later', async t => {
  serve(
    t,
    () => new Response('', { status: 429, statusText: 'Too Many Requests' }),
  );
  await assert.rejects(client().organization('acme'), {
    status: 429,
    message: '429 Too Many Requests',
    hint: /quota/,
  });
});

test('network failures name the host', async t => {
  serve(t, () => {
    throw new TypeError('fetch failed');
  });
  await assert.rejects(client().organization('acme'), {
    message: 'Cannot reach apigee.googleapis.com.',
  });
});

test('list requests follow the page tokens', async t => {
  const requests = serve(t, path =>
    path.includes('pageToken=next')
      ? reply({ environmentGroups: [{ name: 'internal' }] })
      : reply({
          environmentGroups: [
            { name: 'public', hostnames: ['api.example.com'] },
          ],
          nextPageToken: 'next',
        }),
  );
  const groups = await client().environmentGroups('acme');
  assert.deepEqual(
    groups.map(group => group.name),
    ['public', 'internal'],
  );
  assert.deepEqual(
    requests.map(request => request.path),
    [
      '/organizations/acme/envgroups',
      '/organizations/acme/envgroups?pageToken=next',
    ],
  );
});

test('path segments are encoded', async t => {
  const requests = serve(t, () => reply({ name: 'dev env' }));
  await client().environment('acme', 'dev env/../x');
  assert.equal(
    requests[0].path,
    '/organizations/acme/environments/dev%20env%2F..%2Fx',
  );
});

test('no more requests than allowed run at the same time', async t => {
  let active = 0;
  let peak = 0;
  serve(t, async () => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--;
    return reply({ name: 'dev' });
  });
  const api = client(2);
  await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      api.environment('acme', `env-${index}`),
    ),
  );
  assert.equal(peak, 2);
});

test('rows combine all bundles with their newest deployments', async t => {
  serve(t, path => {
    switch (path) {
      case '/organizations/acme/apis':
        return reply({ proxies: [{ name: 'orders' }, { name: 'idle' }] });
      case '/organizations/acme/sharedflows':
        return reply({ sharedFlows: [{ name: 'auth' }] });
      case '/organizations/acme/deployments?sharedFlows=false':
        return reply({
          deployments: [
            {
              environment: 'prod',
              apiProxy: 'orders',
              revision: '3',
              deployStartTime: '100',
            },
            {
              environment: 'prod',
              apiProxy: 'orders',
              revision: '4',
              deployStartTime: '200',
              proxyDeploymentType: 'PROXY_DEPLOYMENT_TYPE_UNSPECIFIED',
            },
            {
              environment: 'dev',
              apiProxy: 'orders',
              revision: '5',
              deployStartTime: '300',
              proxyDeploymentType: 'EXTENSIBLE',
            },
          ],
        });
      case '/organizations/acme/deployments?sharedFlows=true':
        return reply({
          deployments: [
            { environment: 'dev', apiProxy: 'auth', revision: '1' },
          ],
        });
      default:
        return reply({}, 404);
    }
  });
  assert.deepEqual(await loadRows(client(), 'acme'), [
    { kind: 'apis', name: 'idle', local: false, cells: {} },
    {
      kind: 'apis',
      name: 'orders',
      local: false,
      cells: {
        prod: { revision: '4', deployedAt: 200 },
        dev: { revision: '5', deployedAt: 300, proxyType: 'EXTENSIBLE' },
      },
    },
    {
      kind: 'sharedflows',
      name: 'auth',
      local: false,
      cells: { dev: { revision: '1', deployedAt: undefined } },
    },
  ]);
});

test('the overview lists environments, groups, and enabled add-ons', async t => {
  serve(t, path => {
    switch (path) {
      case '/organizations/acme':
        return reply({
          name: 'acme',
          projectId: 'acme-project',
          runtimeType: 'CLOUD',
          billingType: 'SUBSCRIPTION',
          environments: ['test', 'dev'],
          addonsConfig: {
            apiSecurityConfig: { enabled: true },
            monetizationConfig: { enabled: false },
          },
        });
      case '/organizations/acme/environments/test':
        return reply({ name: 'test', type: 'INTERMEDIATE' });
      case '/organizations/acme/environments/dev':
        return reply({ name: 'dev', type: 'BASE' });
      case '/organizations/acme/envgroups':
        return reply({
          environmentGroups: [
            { name: 'public', hostnames: ['api.example.com'] },
          ],
        });
      case '/organizations/acme/envgroups/public/attachments':
        return reply({
          environmentGroupAttachments: [
            { environment: 'test' },
            { environment: 'dev' },
          ],
        });
      default:
        return reply({}, 404);
    }
  });
  assert.deepEqual(await loadOverview(client(), 'acme'), {
    name: 'acme',
    projectId: 'acme-project',
    runtimeType: 'CLOUD',
    billingType: 'SUBSCRIPTION',
    state: undefined,
    addons: ['Advanced API Security'],
    environments: [
      { name: 'dev', type: 'BASE', state: undefined },
      { name: 'test', type: 'INTERMEDIATE', state: undefined },
    ],
    groups: [
      {
        name: 'public',
        hostnames: ['api.example.com'],
        environments: ['dev', 'test'],
      },
    ],
  });
});

test('status checks start with local bundles, then the newest deployments', () => {
  const row = (
    name: string,
    local: boolean,
    cells: Record<string, number>,
  ): Row => ({
    kind: 'apis',
    name,
    local,
    cells: Object.fromEntries(
      Object.entries(cells).map(([environment, deployedAt]) => [
        environment,
        { revision: '1', deployedAt },
      ]),
    ),
  });
  const rows = [
    row('old', false, { prod: 1 }),
    row('new', false, { prod: 9 }),
    row('mine', true, { dev: 2, prod: 3 }),
  ];
  assert.deepEqual(
    statusTargets(rows, 3).map(
      ({ row, environment }) => `${row.name}/${environment}`,
    ),
    ['mine/prod', 'mine/dev', 'new/prod'],
  );
});

test('a status keeps the state, readable messages, and base paths', () => {
  const cell: Cell = { revision: '2' };
  applyStatus(cell, {
    state: 'ERROR',
    errors: [{ message: 'instance "eval" reported error InvalidAllowedRate' }],
    instances: [
      { deployedRoutes: [{ basepath: '/orders' }, { basepath: '/v2/orders' }] },
      { deployedRoutes: [{ basepath: '/orders' }] },
    ],
    routeConflicts: [
      {
        environmentGroup: 'public',
        conflictingDeployment: { apiProxy: 'legacy', basepath: '/orders' },
      },
    ],
  });
  assert.deepEqual(cell, {
    revision: '2',
    state: 'ERROR',
    errors: ['Instance "eval" reported error InvalidAllowedRate'],
    routeConflicts: ['Base path /orders conflicts with legacy in public.'],
    basePaths: ['/orders', '/v2/orders'],
  });
});

test('network failures name their cause', async t => {
  serve(t, () => {
    throw new TypeError('fetch failed', {
      cause: new Error('unable to get local issuer certificate'),
    });
  });
  await assert.rejects(client().organization('acme'), {
    message:
      'Cannot reach apigee.googleapis.com (unable to get local issuer certificate).',
    hint: /network connection/,
  });
});

test('a connection that drops while the body arrives is a network failure', async t => {
  serve(
    t,
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError('terminated'));
          },
        }),
      ),
  );
  await assert.rejects(client().organization('acme'), {
    message: /^Cannot reach apigee\.googleapis\.com/,
  });
});

test('pay-as-you-go organizations list add-ons per environment', async t => {
  serve(t, path => {
    switch (path) {
      case '/organizations/acme':
        return reply({
          name: 'acme',
          billingType: 'PAYG',
          environments: ['dev', 'prod'],
        });
      case '/organizations/acme/environments/dev':
        return reply({ name: 'dev', type: 'BASE' });
      case '/organizations/acme/environments/prod':
        return reply({ name: 'prod', type: 'COMPREHENSIVE' });
      case '/organizations/acme/environments/prod/addonsConfig':
        return reply({
          apiSecurityConfig: { enabled: true },
          analyticsConfig: { enabled: true },
        });
      case '/organizations/acme/envgroups':
        return reply({});
      default:
        // dev cannot read its add-ons, which must not break the overview
        return reply({}, 403);
    }
  });
  const { environments } = await loadOverview(client(), 'acme');
  assert.deepEqual(environments, [
    { name: 'dev', type: 'BASE', state: undefined },
    {
      name: 'prod',
      type: 'COMPREHENSIVE',
      state: undefined,
      addons: ['Advanced API Security', 'Analytics'],
    },
  ]);
});

test('products are read by name, without the repeated first item', async t => {
  const page = (from: number) =>
    Array.from({ length: 1000 }, (_, index) => ({
      name: `p${String(from + index).padStart(4, '0')}`,
    }));
  const requests = serve(t, path =>
    path.includes('startKey=p0999')
      ? reply({ apiProduct: [{ name: 'p0999' }, { name: 'p1000' }] })
      : reply({ apiProduct: page(0) }),
  );
  const products = await client().products('acme');
  assert.equal(products.length, 1001);
  assert.equal(products.at(-1)?.name, 'p1000');
  assert.deepEqual(
    requests.map(request => request.path),
    [
      '/organizations/acme/apiproducts?expand=true&count=1000',
      '/organizations/acme/apiproducts?expand=true&count=1000&startKey=p0999',
    ],
  );
});

test('apps are listed by page size and arrive without secrets', async t => {
  const requests = serve(t, path =>
    path.includes('pageToken=next')
      ? reply({ app: [{ appId: 'b', name: 'second', status: 'revoked' }] })
      : reply({
          app: [
            {
              appId: 'a',
              name: 'first',
              developerEmail: 'dev@example.com',
              credentials: [
                {
                  consumerKey: 'key-1234',
                  consumerSecret: 'secret-5678',
                  status: 'approved',
                  expiresAt: '-1',
                  apiProducts: [{ apiproduct: 'gold', status: 'pending' }],
                },
              ],
            },
          ],
          nextPageToken: 'next',
        }),
  );
  const apps = await client().apps('acme');
  assert.deepEqual(
    requests.map(request => request.path),
    [
      '/organizations/acme/apps?pageSize=1000',
      '/organizations/acme/apps?pageSize=1000&pageToken=next',
    ],
  );
  assert.deepEqual(
    apps.map(app => [app.name, app.status]),
    [
      ['first', undefined],
      ['second', 'revoked'],
    ],
  );
  assert.equal(apps[0].credentials?.[0].consumerKey, 'key-1234');
  assert.doesNotMatch(JSON.stringify(apps), /secret-5678|consumerSecret/);
});

test('developers come expanded in one request', async t => {
  const requests = serve(t, () =>
    reply({ developer: [{ email: 'dev@example.com', status: 'active' }] }),
  );
  const developers = await client().developers('acme');
  assert.deepEqual(developers, [
    { email: 'dev@example.com', status: 'active' },
  ]);
  assert.deepEqual(
    requests.map(request => request.path),
    ['/organizations/acme/developers?expand=true'],
  );
});

test('flow hooks name their shared flow, and empty hooks are left out', async t => {
  const requests = serve(t, path =>
    path.endsWith('/eval/flowhooks/PreProxyFlowHook')
      ? reply({ flowHookPoint: 'PreProxyFlowHook', sharedFlow: 'security' })
      : reply({ continueOnError: true }),
  );
  const hooks = await loadFlowHooks(client(), 'acme', ['eval', 'test']);
  assert.deepEqual(hooks, {
    eval: { PreProxyFlowHook: 'security' },
    test: {},
  });
  assert.equal(requests.length, 8);
});

test('the relationships carry key hints, and only the host has the full keys', () => {
  const { relationships, keyOwners } = relationshipsOf('acme', {
    apps: [
      {
        appId: 'app-1',
        name: 'mobile',
        developerId: 'dev-1',
        developerEmail: 'dev@example.com',
        status: 'revoked',
        createdAt: '1700000000000',
        attributes: [{ name: 'tier', value: 'gold' }],
        credentials: [
          {
            consumerKey: 'full-key-abcd',
            status: 'approved',
            issuedAt: '1700000000000',
            expiresAt: '-1',
            apiProducts: [{ apiproduct: 'gold', status: 'pending' }],
          },
          {
            consumerKey: 'other-key-wxyz',
            status: 'revoked',
            expiresAt: '1800000000000',
          },
        ],
      },
    ],
    hooks: {},
  });
  assert.deepEqual(relationships.apps?.[0].keys, [
    {
      hint: 'abcd',
      status: 'approved',
      issuedAt: 1700000000000,
      expiresAt: undefined,
      products: [{ name: 'gold', status: 'pending' }],
    },
    {
      hint: 'wxyz',
      status: 'revoked',
      issuedAt: undefined,
      expiresAt: 1800000000000,
      products: [],
    },
  ]);
  assert.doesNotMatch(JSON.stringify(relationships), /full-key|other-key/);
  assert.deepEqual(keyOwners.get('other-key-wxyz'), { app: 'app-1', key: 1 });
  assert.equal(relationships.apps?.[0].status, 'revoked');
  assert.deepEqual(relationships.apps?.[0].attributes, [
    { name: 'tier', value: 'gold' },
  ]);
});

test('apps belong to developers, app groups, or owners only they name', () => {
  const { relationships } = relationshipsOf('acme', {
    developers: [
      {
        developerId: 'dev-1',
        email: 'ann@example.com',
        firstName: 'Ann',
        lastName: 'Lee',
        status: 'inactive',
      },
    ],
    appGroups: [
      { name: 'partners', displayName: 'Partners', status: 'active' },
    ],
    apps: [
      { appId: 'a', name: 'portal', developerId: 'dev-1' },
      { appId: 'b', name: 'b2b', appGroup: 'partners' },
      {
        appId: 'c',
        name: 'legacy',
        developerId: 'dev-9',
        developerEmail: 'old@example.com',
      },
      { appId: 'c', name: 'legacy' },
    ],
    hooks: {},
  });
  assert.deepEqual(
    relationships.owners.map(owner => [
      owner.id,
      owner.name,
      owner.displayName,
      owner.status,
    ]),
    [
      ['developer/dev-1', 'ann@example.com', 'Ann Lee', 'inactive'],
      ['developer/dev-9', 'old@example.com', undefined, undefined],
      ['appgroup/partners', 'partners', 'Partners', 'active'],
    ],
  );
  assert.deepEqual(
    relationships.apps?.map(app => [app.name, app.owner]),
    [
      ['b2b', 'appgroup/partners'],
      ['legacy', 'developer/dev-9'],
      ['portal', 'developer/dev-1'],
    ],
  );
});

test('products list their proxies, also those their operations name', () => {
  const { relationships } = relationshipsOf('acme', {
    products: [
      {
        name: 'gold',
        displayName: 'Gold',
        approvalType: 'manual',
        environments: ['test', 'eval'],
        proxies: ['orders'],
        quota: '100',
        quotaInterval: '1',
        quotaTimeUnit: 'minute',
        operationGroup: {
          operationConfigs: [{ apiSource: 'catalog' }, { apiSource: 'orders' }],
        },
        graphqlOperationGroup: { operationConfigs: [{ apiSource: 'graph' }] },
      },
      {
        name: 'mesh',
        displayName: 'mesh',
        operationGroup: {
          operationConfigType: 'remoteservice',
          operationConfigs: [{ apiSource: 'envoy-service' }],
        },
      },
    ],
    hooks: { eval: { PreProxyFlowHook: 'security' } },
  });
  assert.deepEqual(relationships.products, [
    {
      name: 'gold',
      displayName: 'Gold',
      approvalType: 'manual',
      environments: ['eval', 'test'],
      proxies: ['catalog', 'graph', 'orders'],
      quota: '100 per 1 minute',
      attributes: [],
    },
    {
      name: 'mesh',
      displayName: undefined,
      approvalType: undefined,
      environments: [],
      proxies: [],
      quota: undefined,
      attributes: [],
    },
  ]);
  assert.equal(relationships.apps, undefined);
  assert.deepEqual(relationships.hooks, {
    eval: { PreProxyFlowHook: 'security' },
  });
});

test('each deployed revision is listed once, the newest first', () => {
  const rows: Row[] = [
    {
      kind: 'apis',
      name: 'orders',
      local: false,
      cells: {
        eval: { revision: '2', deployedAt: 300 },
        test: { revision: '2', deployedAt: 100 },
      },
    },
    {
      kind: 'sharedflows',
      name: 'cors',
      local: false,
      cells: { eval: { revision: '1', deployedAt: 200 } },
    },
  ];
  assert.deepEqual(
    deployedRevisions(rows).map(
      ({ row, revision }) => `${row.name}/${revision}`,
    ),
    ['orders/2', 'cors/1'],
  );
});

test('a row has deployments only in its own environments', () => {
  const row: Row = {
    kind: 'apis',
    name: 'hello',
    local: false,
    cells: { dev: { revision: '1' } },
  };
  assert.equal(cellOf(row, 'dev')?.revision, '1');
  for (const name of ['__proto__', 'constructor', 'toString', 'test']) {
    assert.equal(cellOf(row, name), undefined, name);
  }
});
