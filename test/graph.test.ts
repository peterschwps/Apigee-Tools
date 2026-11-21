import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Kind, Relationships, Row } from '../src/protocol';
import {
  buildGraph,
  curve,
  layout,
  lineage,
  search,
  type Graph,
} from '../src/webview/graph';

const now = Date.parse('2026-11-20T12:00:00Z');
const day = 86_400_000;

function row(kind: Kind, name: string, revisions: Record<string, string>): Row {
  return {
    kind,
    name,
    local: false,
    cells: Object.fromEntries(
      Object.entries(revisions).map(([environment, revision]) => [
        environment,
        { revision },
      ]),
    ),
  };
}

// A small shop: a partner key waits for approval, the mobile app is revoked
const data: Relationships = {
  organization: 'acme',
  owners: [
    {
      id: 'developer/d1',
      kind: 'developer',
      name: 'web@example.com',
      status: 'active',
      attributes: [],
    },
    {
      id: 'developer/d2',
      kind: 'developer',
      name: 'partner@example.com',
      status: 'active',
      attributes: [],
    },
    {
      id: 'developer/d3',
      kind: 'developer',
      name: 'mobile@example.com',
      status: 'inactive',
      attributes: [],
    },
  ],
  apps: [
    {
      id: 'a1',
      name: 'storefront-web',
      owner: 'developer/d1',
      status: 'approved',
      attributes: [{ name: 'channel', value: 'web' }],
      keys: [
        {
          hint: 'k3fz',
          status: 'approved',
          products: [{ name: 'catalog-free', status: 'approved' }],
        },
      ],
    },
    {
      id: 'a2',
      name: 'partner-portal',
      owner: 'developer/d2',
      status: 'approved',
      attributes: [{ name: 'tier', value: 'gold' }],
      keys: [
        {
          hint: 'a91b',
          status: 'approved',
          products: [{ name: 'partner-gold', status: 'pending' }],
        },
      ],
    },
    {
      id: 'a3',
      name: 'mobile-app',
      owner: 'developer/d3',
      status: 'revoked',
      attributes: [],
      keys: [
        {
          hint: '77qd',
          status: 'approved',
          expiresAt: now + 5 * day,
          products: [{ name: 'catalog-free', status: 'approved' }],
        },
        {
          hint: 'old1',
          status: 'approved',
          expiresAt: now - day,
          products: [],
        },
      ],
    },
  ],
  products: [
    {
      name: 'catalog-free',
      environments: [],
      proxies: ['catalog-v1', 'catalog-v2'],
      attributes: [],
    },
    {
      name: 'partner-gold',
      environments: ['test'],
      proxies: ['catalog-v2', 'orders-v1', 'partner-gateway'],
      attributes: [],
    },
    { name: 'unused', environments: [], proxies: [], attributes: [] },
  ],
  calls: {
    'apis/catalog-v1/1': ['cors'],
    'apis/catalog-v2/4': ['cors'],
    'apis/catalog-v2/2': ['old-flow'],
    'apis/orders-v1/2': ['quota-per-app'],
  },
  hooks: { eval: { PreProxyFlowHook: 'security-baseline' } },
  notes: [],
};

const rows: Row[] = [
  row('apis', 'catalog-v1', { eval: '1' }),
  row('apis', 'catalog-v2', { eval: '4', test: '2' }),
  row('apis', 'orders-v1', { eval: '2' }),
  row('apis', 'admin', {}),
  row('sharedflows', 'cors', { eval: '1' }),
  row('sharedflows', 'quota-per-app', { eval: '1' }),
  row('sharedflows', 'security-baseline', { eval: '1' }),
];

const edgesOf = (graph: Graph) =>
  graph.edges.map(
    edge => `${edge.from} → ${edge.to}${edge.kind ? ` (${edge.kind})` : ''}`,
  );

test('edges follow keys, products, and the revision deployed here', () => {
  const evaluation = edgesOf(buildGraph(data, rows, 'eval', now));
  for (const edge of [
    'owners:developer/d2 → apps:a2',
    'apps:a2 → products:partner-gold (pending)',
    'products:partner-gold → apis:partner-gateway',
    'apis:catalog-v2 → sharedflows:cors',
    'apis:orders-v1 → sharedflows:quota-per-app',
  ]) {
    assert.ok(evaluation.includes(edge), edge);
  }
  // In test, catalog-v2 runs revision 2, which called another shared flow
  const testing = edgesOf(buildGraph(data, rows, 'test', now));
  assert.ok(testing.includes('apis:catalog-v2 → sharedflows:old-flow'));
  assert.ok(!testing.includes('apis:catalog-v2 → sharedflows:cors'));
});

test('flow hooks connect only the proxies deployed in the environment', () => {
  const hooks = buildGraph(data, rows, 'eval', now)
    .edges.filter(edge => edge.kind === 'hook')
    .map(edge => edge.from);
  assert.deepEqual(hooks, [
    'apis:catalog-v1',
    'apis:catalog-v2',
    'apis:orders-v1',
  ]);
  const graph = buildGraph(data, rows, 'eval', now);
  assert.deepEqual(graph.nodes.get('sharedflows:security-baseline')?.hooks, [
    'PreProxyFlowHook',
  ]);
  assert.equal(
    buildGraph(data, rows, 'test', now).edges.filter(
      edge => edge.kind === 'hook',
    ).length,
    0,
  );
});

test('the lineage of a proxy holds its consumers and shared flows, not its siblings', () => {
  const graph = buildGraph(data, rows, 'eval', now);
  assert.deepEqual([...lineage(graph, ['apis:catalog-v1'])].sort(), [
    'apis:catalog-v1',
    'apps:a1',
    'apps:a3',
    'owners:developer/d1',
    'owners:developer/d3',
    'products:catalog-free',
    'sharedflows:cors',
    'sharedflows:security-baseline',
  ]);
});

test('the search finds names, emails, key hints, and attributes', () => {
  const graph = buildGraph(data, rows, 'eval', now);
  assert.deepEqual(search(graph, 'tier=gold'), ['apps:a2']);
  assert.deepEqual(search(graph, 'MOBILE@'), ['owners:developer/d3']);
  assert.deepEqual(search(graph, '77qd'), ['apps:a3']);
  assert.deepEqual(search(graph, '  '), []);
});

test('keys show what keeps them from working, and so do their apps', () => {
  const nodes = buildGraph(data, rows, 'eval', now).nodes;
  assert.deepEqual(
    ['apps:a1', 'apps:a2', 'apps:a3'].flatMap(id =>
      nodes.get(id)!.keys!.map(key => [key.name, key.sign, key.label]),
    ),
    [
      ['…k3fz', 'good', 'Approved'],
      ['…a91b', 'warning', 'Waiting for approval of partner-gold'],
      ['…77qd', 'warning', 'Expires on 2026-11-25'],
      ['…old1', 'error', 'Expired on 2026-11-19'],
    ],
  );
  assert.deepEqual(
    ['apps:a1', 'apps:a2', 'apps:a3'].map(id => [
      nodes.get(id)?.sign,
      nodes.get(id)?.label,
    ]),
    [
      ['good', 'Approved'],
      ['warning', 'Key …a91b: Waiting for approval of partner-gold'],
      ['error', 'Revoked'],
    ],
  );
});

test('an app reaches an API product through its best key', () => {
  const graph = buildGraph(
    {
      organization: 'acme',
      owners: [],
      apps: [
        {
          id: 'rotated',
          name: 'rotated',
          owner: '',
          status: 'approved',
          attributes: [],
          keys: [
            {
              hint: 'old1',
              status: 'revoked',
              products: [{ name: 'p', status: 'approved' }],
            },
            {
              hint: 'new1',
              status: 'approved',
              products: [
                { name: 'p', status: 'approved' },
                { name: 'q', status: 'pending' },
              ],
            },
          ],
        },
        {
          id: 'stuck',
          name: 'stuck',
          owner: '',
          status: 'approved',
          attributes: [],
          keys: [
            {
              hint: 'gone',
              status: 'approved',
              expiresAt: now - day,
              products: [{ name: 'p', status: 'approved' }],
            },
          ],
        },
        // Revoked before it expires, with a new key for the same product
        {
          id: 'renewed',
          name: 'renewed',
          owner: '',
          status: 'approved',
          attributes: [],
          keys: [
            {
              hint: 'old2',
              status: 'revoked',
              expiresAt: now + 10 * day,
              products: [{ name: 'p', status: 'approved' }],
            },
            {
              hint: 'new2',
              status: 'approved',
              products: [{ name: 'p', status: 'approved' }],
            },
          ],
        },
        // The working key is for another product
        {
          id: 'lost',
          name: 'lost',
          owner: '',
          status: 'approved',
          attributes: [],
          keys: [
            {
              hint: 'exp3',
              status: 'approved',
              expiresAt: now - day,
              products: [{ name: 'p', status: 'approved' }],
            },
            {
              hint: 'liv3',
              status: 'approved',
              products: [{ name: 'q', status: 'approved' }],
            },
          ],
        },
        {
          id: 'nameless',
          name: 'nameless',
          owner: '',
          status: 'approved',
          attributes: [],
          keys: [{ hint: '', status: 'revoked', products: [] }],
        },
      ],
      products: [
        { name: 'p', environments: [], proxies: [], attributes: [] },
        { name: 'q', environments: [], proxies: [], attributes: [] },
      ],
      calls: {},
      hooks: {},
      notes: [],
    },
    [],
    'eval',
    now,
  );
  assert.deepEqual(edgesOf(graph), [
    'apps:rotated → products:p',
    'apps:rotated → products:q (pending)',
    'apps:stuck → products:p (revoked)',
    'apps:renewed → products:p',
    'apps:lost → products:p (revoked)',
    'apps:lost → products:q',
  ]);
  const state = (id: string) => {
    const node = graph.nodes.get(id)!;
    return [
      node.sign,
      node.label,
      node.findings.map(finding => `${finding.tone}: ${finding.text}`),
    ];
  };
  // A dead key only needs cleaning up once working keys cover its products;
  // the worst finding comes first
  assert.deepEqual(state('apps:rotated'), [
    'warning',
    'Key …new1: Waiting for approval of q',
    [
      'warning: Key …new1: Waiting for approval of q',
      'info: Key …old1: Revoked',
    ],
  ]);
  assert.deepEqual(state('apps:stuck'), [
    'error',
    'Key …gone: Expired on 2026-11-19',
    ['error: Key …gone: Expired on 2026-11-19'],
  ]);
  assert.deepEqual(state('apps:renewed'), [
    'good',
    'Approved',
    ['info: Key …old2: Revoked', 'info: Key …old2: Expires on 2026-11-30'],
  ]);
  assert.deepEqual(state('apps:lost'), [
    'error',
    'Key …exp3: Expired on 2026-11-19',
    ['error: Key …exp3: Expired on 2026-11-19'],
  ]);
  assert.deepEqual(state('apps:nameless'), [
    'error',
    'Key 1: Revoked',
    ['error: Key 1: Revoked'],
  ]);
  assert.deepEqual(
    graph.nodes.get('apps:rotated')?.keys?.map(key => key.usable),
    [false, true],
  );
});

test('findings mark what nothing uses, what is missing, and what is off', () => {
  const nodes = buildGraph(data, rows, 'eval', now).nodes;
  const findings = (id: string) =>
    nodes.get(id)?.findings.map(finding => `${finding.tone}: ${finding.text}`);
  assert.deepEqual(findings('products:unused'), [
    'info: No API key is for it',
    'info: Lists no API proxies',
  ]);
  assert.deepEqual(findings('products:partner-gold'), [
    'info: Not available in eval',
  ]);
  assert.deepEqual(findings('apis:admin'), ['info: In no API product']);
  assert.deepEqual(findings('apis:partner-gateway'), ['warning: Not found']);
  assert.deepEqual(findings('owners:developer/d3'), ['error: Inactive']);
  assert.deepEqual(findings('apps:a3'), [
    'error: App revoked',
    'warning: Key …77qd: Expires on 2026-11-25',
    'info: Key …old1: Expired on 2026-11-19',
  ]);
});

test('the layout untangles crossing edges and is deterministic', () => {
  const crossing: Relationships = {
    organization: 'acme',
    owners: [
      { id: 'developer/a', kind: 'developer', name: 'a', attributes: [] },
      { id: 'developer/b', kind: 'developer', name: 'b', attributes: [] },
    ],
    apps: [
      { id: 'x', name: 'x', owner: 'developer/b', attributes: [], keys: [] },
      { id: 'y', name: 'y', owner: 'developer/a', attributes: [], keys: [] },
    ],
    calls: {},
    hooks: {},
    notes: [],
  };
  const graph = buildGraph(crossing, [], 'eval', now);
  const first = layout(graph, undefined, { limit: 100, hooks: false });
  assert.deepEqual(first.columns[0].ids, [
    'owners:developer/a',
    'owners:developer/b',
  ]);
  assert.deepEqual(first.columns[1].ids, ['apps:y', 'apps:x']);
  assert.deepEqual(first.gutters[0].map(edge => [edge.from, edge.to]).sort(), [
    [0, 0],
    [1, 1],
  ]);
  assert.deepEqual(
    layout(graph, undefined, { limit: 100, hooks: false }),
    first,
  );
});

test('the layout caps each column, keeping chosen and troubled nodes', () => {
  const graph = buildGraph(data, rows, 'eval', now);
  const capped = layout(graph, undefined, {
    limit: 1,
    hooks: false,
    first: new Set(['apps:a1']),
  });
  assert.deepEqual(capped.columns[1], { ids: ['apps:a1'], hidden: 2 });
  // Without a choice, the revoked app comes first
  assert.deepEqual(
    layout(graph, undefined, { limit: 1, hooks: false }).columns[1].ids,
    ['apps:a3'],
  );
  const shown = lineage(graph, ['products:unused']);
  assert.deepEqual(
    layout(graph, shown, { limit: 100, hooks: false }).columns.map(
      column => column.ids,
    ),
    [[], [], ['products:unused'], [], []],
  );
});

test('hook edges are drawn only when asked for', () => {
  const graph = buildGraph(data, rows, 'eval', now);
  const kinds = (hooks: boolean) =>
    layout(graph, undefined, { limit: 100, hooks }).gutters[3].map(
      edge => edge.kind ?? 'call',
    );
  assert.ok(!kinds(false).includes('hook'));
  assert.equal(kinds(true).filter(kind => kind === 'hook').length, 3);
});

test('an edge curves from the middle of one row to the middle of another', () => {
  assert.equal(curve(0, 1), 'M0 14C20 14 20 42 40 42');
});
