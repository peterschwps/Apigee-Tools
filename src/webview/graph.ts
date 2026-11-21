// The relationships of an organization as a graph of five columns, from the
// owners of apps to the shared flows that proxies call, and its layout. Pure:
// no Lit and no DOM, so that node tests cover it.
import type {
  ApiKey,
  App,
  Attribute,
  FlowHookPoint,
  Owner,
  Product,
  Relationships,
  Row,
} from '../protocol';

export const columns = [
  'owners',
  'apps',
  'products',
  'apis',
  'sharedflows',
] as const;
export type Column = (typeof columns)[number];

/** A sign of `signs` in deployments.ts. */
export type SignKey = 'good' | 'warning' | 'error' | 'unknown' | 'none';

/** Something worth knowing about a node, such as a revoked app. */
export type Finding = {
  tone: 'error' | 'warning' | 'info';
  text: string;
  /** The API key of an app that it is about, by position. */
  key?: number;
};

/** The state of an API key, which the details of its app list. */
export type KeyState = {
  /** The last four characters, or the key's position without them. */
  name: string;
  sign: SignKey;
  label: string;
  /** Whether calls can use it: it is neither revoked nor expired. */
  usable: boolean;
  findings: Finding[];
};

export type GraphNode = {
  /** `<column>:<key>`, such as `apps:<appId>` or `products:<name>`. */
  id: string;
  column: Column;
  name: string;
  /** Lower-case texts that the search matches. */
  terms: string[];
  /** The state; proxies and shared flows take theirs from the deployment. */
  sign?: SignKey;
  /** The state in words, for the tooltip and screen readers. */
  label?: string;
  findings: Finding[];
  owner?: Owner;
  app?: App;
  /** The state of each API key of an app, in the app's order. */
  keys?: KeyState[];
  product?: Product;
  /** The proxy or shared flow, absent for one that does not exist. */
  row?: Row;
  /** The flow hooks that run a shared flow in the environment. */
  hooks?: FlowHookPoint[];
};

export type GraphEdge = {
  from: string;
  to: string;
  /**
   * An app whose keys wait for approval of a product or may not use it, or a
   * flow hook.
   */
  kind?: 'pending' | 'revoked' | 'hook';
};

export type Graph = {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
  outgoing: Map<string, GraphEdge[]>;
  incoming: Map<string, GraphEdge[]>;
};

/** The visible nodes of each column in order, and the edges between them. */
export type Layout = {
  columns: { ids: string[]; hidden: number }[];
  /** Per gap between columns: edges from a row on the left to one on the right. */
  gutters: { from: number; to: number; kind?: GraphEdge['kind'] }[][];
};

/** The height of a row and the width of a gap, as the styles draw them. */
export const pitch = 28;
export const gutterWidth = 40;

// Keys that expire within this time get a warning
const expiringMs = 30 * 86_400_000;

// How an app reaches an API product through its keys, the best first
const reaches = ['approved', 'pending', 'revoked'] as const;

// Findings by tone, the worst first
const tones: readonly Finding['tone'][] = ['error', 'warning', 'info'];

/**
 * Builds the graph of an environment: owners → apps → products → proxies →
 * shared flows. Apps reach products through their API keys; proxies run the
 * shared flows that their deployed revision calls and those of the
 * environment's flow hooks.
 */
export function buildGraph(
  data: Relationships,
  rows: readonly Row[],
  environment: string,
  now: number,
): Graph {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const add = (node: GraphNode) => nodes.set(node.id, node);
  const link = (from: string, to: string, kind?: GraphEdge['kind']) =>
    edges.push({ from, to, ...(kind && { kind }) });

  for (const owner of data.owners) {
    const inactive = owner.status === 'inactive';
    add({
      id: `owners:${owner.id}`,
      column: 'owners',
      name: owner.name,
      terms: terms(owner.name, owner.displayName, owner.attributes),
      sign: inactive ? 'error' : owner.status ? 'good' : 'unknown',
      label: inactive ? 'Inactive' : owner.status ? 'Active' : 'Status unknown',
      findings: inactive ? [{ tone: 'error', text: 'Inactive' }] : [],
      owner,
    });
  }

  for (const app of data.apps ?? []) {
    const id = `apps:${app.id}`;
    const keys = app.keys.map((key, index) => keyState(key, index, now));
    // A product counts as approved through a working key approved for it,
    // else as waiting, else as revoked
    const reach = new Map<string, (typeof reaches)[number]>();
    app.keys.forEach((key, index) => {
      for (const product of key.products) {
        const status = !keys[index].usable
          ? 'revoked'
          : product.status === 'pending' || product.status === 'revoked'
            ? product.status
            : 'approved';
        const before = reach.get(product.name);
        if (!before || reaches.indexOf(status) < reaches.indexOf(before)) {
          reach.set(product.name, status);
        }
      }
    });
    // A revoked or expired key only needs cleaning up once working keys are
    // approved for all of its products
    const working = keys.some(key => key.usable);
    const replaced = app.keys.map(
      (key, index) =>
        !keys[index].usable &&
        working &&
        key.products.every(product => reach.get(product.name) === 'approved'),
    );
    add({
      id,
      column: 'apps',
      name: app.name,
      // The last characters of a key find its app
      terms: [
        ...terms(app.name, undefined, app.attributes),
        ...app.keys.flatMap(key => (key.hint ? [key.hint.toLowerCase()] : [])),
      ],
      ...appState(app, keys, replaced),
      app,
      keys,
    });
    if (app.owner) link(`owners:${app.owner}`, id);
    for (const [name, status] of reach) {
      link(id, `products:${name}`, status === 'approved' ? undefined : status);
    }
  }

  for (const product of data.products ?? []) {
    const id = `products:${product.name}`;
    const available =
      !product.environments.length ||
      product.environments.includes(environment);
    add({
      id,
      column: 'products',
      name: product.name,
      terms: terms(product.name, product.displayName, product.attributes),
      sign: available ? 'good' : 'none',
      label: `${available ? 'Available' : 'Not available'} in ${environment}`,
      findings: available
        ? []
        : [{ tone: 'info', text: `Not available in ${environment}` }],
      product,
    });
    for (const proxy of product.proxies) link(id, `apis:${proxy}`);
  }

  // Proxies of this environment run the shared flows of its flow hooks too
  const hooks = Object.entries(data.hooks[environment] ?? {}) as [
    FlowHookPoint,
    string,
  ][];
  const hooked = [...new Set(hooks.map(([, sharedFlow]) => sharedFlow))];
  for (const row of rows) {
    const id = `${row.kind}:${row.name}`;
    add({
      id,
      column: row.kind,
      name: row.name,
      terms: [row.name.toLowerCase()],
      findings: [],
      row,
      ...(row.kind === 'sharedflows' && {
        hooks: hooks
          .filter(([, sharedFlow]) => sharedFlow === row.name)
          .map(([point]) => point),
      }),
    });
    const cell = row.cells[environment];
    if (!cell) continue;
    const key = `${row.kind}/${row.name}/${cell.revision}`;
    for (const name of data.calls[key] ?? []) link(id, `sharedflows:${name}`);
    if (row.kind === 'apis') {
      for (const name of hooked) link(id, `sharedflows:${name}`, 'hook');
    }
  }

  // Names that nothing else lists still get a node
  for (const { from, to } of edges) {
    for (const id of [from, to]) {
      if (!nodes.has(id)) add(placeholder(id, Boolean(data.products)));
    }
  }

  const outgoing = new Map<string, GraphEdge[]>();
  const incoming = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge]);
  }

  // Housekeeping: what nothing uses or what uses nothing
  for (const node of nodes.values()) {
    if (node.column === 'products' && node.product) {
      if (!incoming.has(node.id)) {
        node.findings.push({ tone: 'info', text: 'No API key is for it' });
      }
      if (!outgoing.has(node.id)) {
        node.findings.push({ tone: 'info', text: 'Lists no API proxies' });
      }
    }
    if (
      node.column === 'apis' &&
      node.row &&
      data.products &&
      !incoming.has(node.id)
    ) {
      node.findings.push({ tone: 'info', text: 'No linked API product' });
    }
  }
  return { nodes, edges, outgoing, incoming };
}

/** Returns the nodes whose name, email, attributes, or key hints contain a text. */
export function search(graph: Graph, query: string): string[] {
  const text = query.trim().toLowerCase();
  if (!text) return [];
  return [...graph.nodes.values()]
    .filter(node => node.terms.some(term => term.includes(text)))
    .map(node => node.id);
}

/**
 * Returns the lineage of nodes: everything that leads to them and everything
 * they lead to, but not what else those lead to.
 */
export function lineage(graph: Graph, roots: Iterable<string>): Set<string> {
  const reach = (direction: 'incoming' | 'outgoing') => {
    const seen = new Set(roots);
    const stack = [...seen];
    for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
      for (const edge of graph[direction].get(id) ?? []) {
        const next = direction === 'incoming' ? edge.from : edge.to;
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    return seen;
  };
  return new Set([...reach('incoming'), ...reach('outgoing')]);
}

/**
 * Lays out the shown nodes, at most `limit` per column: the `first` ones,
 * then those with errors or warnings, then by name. Rows are ordered to
 * reduce crossing edges; flow hook edges are drawn only with `hooks`.
 */
export function layout(
  graph: Graph,
  shown: ReadonlySet<string> | undefined,
  options: { limit: number; hooks: boolean; first?: ReadonlySet<string> },
): Layout {
  const byName = (a: GraphNode, b: GraphNode) =>
    a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  const visible = columns.map(column => {
    const candidates = [...graph.nodes.values()]
      .filter(node => node.column === column && (!shown || shown.has(node.id)))
      .sort(
        (a, b) =>
          Number(!options.first?.has(a.id)) -
            Number(!options.first?.has(b.id)) ||
          severity(a) - severity(b) ||
          byName(a, b),
      );
    const kept = candidates.slice(0, options.limit).sort(byName);
    return {
      ids: kept.map(node => node.id),
      hidden: candidates.length - kept.length,
    };
  });
  const drawn = (edge: GraphEdge) => options.hooks || edge.kind !== 'hook';
  const name = (id: string) => graph.nodes.get(id)?.name ?? id;

  // ponytail: barycenter sweeps only, without transpositions; they untangle
  // the edges of typical organizations, a crossing-minimal order is NP-hard
  const order = visible.map(column => column.ids);
  const sweep = (column: number, neighbor: number) => {
    const places = new Map(order[neighbor].map((id, row) => [id, row]));
    const center = new Map<string, number>();
    order[column].forEach((id, row) => {
      const edges =
        (neighbor < column ? graph.incoming : graph.outgoing).get(id) ?? [];
      const rows = edges
        .filter(drawn)
        .map(edge => places.get(neighbor < column ? edge.from : edge.to))
        .filter((place): place is number => place !== undefined);
      center.set(
        id,
        rows.length
          ? rows.reduce((sum, place) => sum + place) / rows.length
          : row,
      );
    });
    order[column].sort(
      (a, b) =>
        center.get(a)! - center.get(b)! || name(a).localeCompare(name(b)),
    );
  };
  for (let pass = 0; pass < 2; pass++) {
    for (let column = 1; column < columns.length; column++) {
      sweep(column, column - 1);
    }
    for (let column = columns.length - 2; column >= 0; column--) {
      sweep(column, column + 1);
    }
  }

  const rows = order.map(ids => new Map(ids.map((id, row) => [id, row])));
  const gutters = columns.slice(1).map((_, gap) =>
    graph.edges.filter(drawn).flatMap(edge => {
      const from = rows[gap].get(edge.from);
      const to = rows[gap + 1].get(edge.to);
      return from === undefined || to === undefined
        ? []
        : [{ from, to, ...(edge.kind && { kind: edge.kind }) }];
    }),
  );
  return {
    columns: order.map((ids, column) => ({
      ids,
      hidden: visible[column].hidden,
    })),
    gutters,
  };
}

/** Returns the path of an edge from a row on the left to one on the right. */
export function curve(from: number, to: number): string {
  const start = from * pitch + pitch / 2;
  const end = to * pitch + pitch / 2;
  const middle = gutterWidth / 2;
  return `M0 ${start}C${middle} ${start} ${middle} ${end} ${gutterWidth} ${end}`;
}

/** Returns the state of a key: revoked, expired, waiting, or expiring. */
function keyState(key: ApiKey, index: number, now: number): KeyState {
  const names = (status: 'pending' | 'revoked') =>
    key.products
      .filter(product => product.status === status)
      .map(product => product.name)
      .join(', ');
  const findings: Finding[] = [];
  const expired = Boolean(key.expiresAt && key.expiresAt <= now);
  if (key.status === 'revoked') {
    findings.push({ tone: 'error', text: 'Revoked' });
  }
  if (expired) {
    findings.push({ tone: 'error', text: `Expired on ${day(key.expiresAt!)}` });
  } else if (key.expiresAt && key.expiresAt - now < expiringMs) {
    findings.push({
      tone: 'warning',
      text: `Expires on ${day(key.expiresAt)}`,
    });
  }
  if (names('pending')) {
    findings.push({
      tone: 'warning',
      text: `Waiting for approval of ${names('pending')}`,
    });
  }
  if (names('revoked')) {
    findings.push({ tone: 'warning', text: `Revoked for ${names('revoked')}` });
  }
  const worst =
    findings.find(finding => finding.tone === 'error') ?? findings[0];
  return {
    name: key.hint ? `…${key.hint}` : `Key ${index + 1}`,
    sign: worst
      ? worst.tone === 'error'
        ? 'error'
        : 'warning'
      : key.status
        ? 'good'
        : 'unknown',
    label: worst?.text ?? (key.status ? 'Approved' : 'Status unknown'),
    usable: key.status !== 'revoked' && !expired,
    findings,
  };
}

/**
 * Returns the state of an app with the findings of its keys, the worst
 * first; those of a replaced key are only remarks.
 */
function appState(
  app: App,
  keys: readonly KeyState[],
  replaced: readonly boolean[],
): Pick<GraphNode, 'sign' | 'label' | 'findings'> {
  const revoked = app.status === 'revoked';
  const findings: Finding[] = [
    ...(revoked ? [{ tone: 'error' as const, text: 'App revoked' }] : []),
    ...(keys.length
      ? []
      : [{ tone: 'info' as const, text: 'Has no API keys' }]),
    ...keys.flatMap((key, index) =>
      key.findings.map((finding): Finding => ({
        tone: replaced[index] ? 'info' : finding.tone,
        // Keys without their last characters are named "Key 2" already
        text: `${key.name.startsWith('…') ? 'Key ' : ''}${key.name}: ${finding.text}`,
        key: index,
      })),
    ),
  ].sort((a, b) => tones.indexOf(a.tone) - tones.indexOf(b.tone));
  const worst = findings[0]?.tone === 'info' ? undefined : findings[0];
  return {
    sign: worst
      ? worst.tone === 'error'
        ? 'error'
        : 'warning'
      : app.status
        ? 'good'
        : 'unknown',
    label: revoked
      ? 'Revoked'
      : (worst?.text ?? (app.status ? 'Approved' : 'Status unknown')),
    findings,
  };
}

/** A node for a name that only an edge knows, such as a deleted product. */
function placeholder(id: string, productsLoaded: boolean): GraphNode {
  const separator = id.indexOf(':');
  const column = id.slice(0, separator) as Column;
  const name = id.slice(separator + 1);
  // Products that did not load are unknown rather than missing
  const missing = column !== 'products' || productsLoaded;
  return {
    id,
    column,
    name,
    terms: [name.toLowerCase()],
    sign: 'unknown',
    label: missing ? 'Not found' : 'Not loaded',
    findings: missing ? [{ tone: 'warning', text: 'Not found' }] : [],
  };
}

function terms(
  name: string,
  displayName: string | undefined,
  attributes: Attribute[],
): string[] {
  return [
    name,
    ...(displayName ? [displayName] : []),
    ...attributes.map(attribute => `${attribute.name}=${attribute.value}`),
  ].map(term => term.toLowerCase());
}

function severity(node: GraphNode): number {
  if (node.findings.some(finding => finding.tone === 'error')) return 0;
  return node.findings.some(finding => finding.tone === 'warning') ? 1 : 2;
}

/** Returns a day such as 2027-01-13, the same in every time zone. */
function day(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}
