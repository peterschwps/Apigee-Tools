// The Relationships tab: who uses what in an organization, in columns from the
// owners of apps to the shared flows that proxies call, with the details of
// the chosen node beside them.
import type { VscodeTextfield } from '@vscode-elements/elements/dist/vscode-textfield/index.js';
import { html, nothing, svg, type TemplateResult } from 'lit';
import type { App, FlowHookPoint, Relationships, Row } from '../protocol';
import {
  checking,
  signs,
  statuses,
  statusIcon,
  statusOf,
  type Loaded,
} from './deployments';
import {
  buildGraph,
  columns,
  curve,
  gutterWidth,
  layout,
  lineage,
  pitch,
  search,
  type Column,
  type Finding,
  type Graph,
  type GraphNode,
  type KeyState,
  type Layout,
} from './graph';

/** The state of the tab; only `node` and `pinned` are kept with the view. */
export type RelationshipState = {
  environment: string;
  /** The chosen node, or empty. */
  node: string;
  /** The node whose chain stays shown while others are chosen, or empty. */
  pinned: string;
  /** The search text, never kept: it may hold a full API key. */
  query: string;
  /** Whether the host found no app with the key searched for. */
  missingKey: boolean;
  /** The node of each column that keyboard focus enters it at. */
  roving: Partial<Record<Column, string>>;
};

export type RelationshipActions = {
  select(node: string): void;
  /** Keeps the chain of a node shown, or with an empty node, no longer. */
  pin(node: string): void;
  /** Clears the search, the choice, and the pin. */
  showAll(): void;
  setQuery(query: string): void;
  findKey(key: string): void;
  copyKey(app: string, key: number): void;
  rove(column: Column, node: string): void;
  openDetails(row: Row): void;
};

type Sign = Parameters<typeof statusIcon>[0];
type Prepared = {
  graph: Graph;
  layout: Layout;
  matches: string[];
  /** The nodes shown; all when absent. */
  shown?: Set<string>;
};

const titles: Readonly<Record<Column, string>> = {
  // App groups own apps like developers and show among them
  owners: 'Developers',
  apps: 'Apps',
  products: 'API Products',
  apis: 'API Proxies',
  sharedflows: 'Shared Flows',
};

const hookNames: Readonly<Record<FlowHookPoint, string>> = {
  PreProxyFlowHook: 'Pre-Proxy',
  PreTargetFlowHook: 'Pre-Target',
  PostTargetFlowHook: 'Post-Target',
  PostProxyFlowHook: 'Post-Proxy',
};

// Nodes per column; search or a choice narrows larger organizations
const limit = 100;
// Entries per group in the side panel
const listLimit = 50;

let cache: { key: readonly unknown[]; value: Prepared } | undefined;

export function relationshipsTab(
  snapshot: Loaded,
  data: Relationships | undefined,
  state: RelationshipState,
  actions: RelationshipActions,
): TemplateResult {
  if (!data || data.organization !== snapshot.organization) {
    return html`
      <div class="page">
        <div class="loading" role="status">
          <vscode-progress-ring></vscode-progress-ring>Loading relationships…
        </div>
      </div>
    `;
  }
  const prepared = prepare(data, snapshot.rows, state);
  const rows = new Map(
    snapshot.rows.map(row => [`${row.kind}:${row.name}`, row]),
  );
  const live = (node: GraphNode) =>
    liveState(node, rows, state.environment, snapshot.loading);
  const total = prepared.graph.nodes.size;
  const shown = prepared.shown?.size ?? total;
  const query = state.query.trim();
  // A pin from another organization or a node since deleted does nothing;
  // without a choice of its own, a pinned chain shows its node's details
  const nodes = prepared.graph.nodes;
  const pinned = nodes.has(state.pinned) ? state.pinned : '';
  const chosen = nodes.has(state.node) ? state.node : query ? '' : pinned;
  return html`
    <div class="page">
      <div class="toolbar">
        <vscode-textfield
          placeholder="Search by name, email, attribute=value, or API key"
          .label=${'Search the relationships'}
          .value=${state.query}
          @input=${(event: Event) =>
            actions.setQuery((event.target as VscodeTextfield).value)}
          @keydown=${(event: KeyboardEvent) => {
            // The field's own text, which a render may not have caught up with
            const text = (event.target as VscodeTextfield).value.trim();
            if (
              event.key === 'Enter' &&
              text &&
              !search(prepared.graph, text).length
            ) {
              actions.findKey(text);
            }
          }}
        >
          <vscode-icon slot="content-before" name="search"></vscode-icon>
        </vscode-textfield>
        ${
          state.node || pinned || query
            ? html`<button
                class="icon-button labeled show-all"
                @click=${() => actions.showAll()}
              >
                <vscode-icon name="clear-all"></vscode-icon>Show All
              </button>`
            : nothing
        }
        <span class="count" aria-live="polite" aria-atomic="true">
          ${shown} of ${total} shown
        </span>
      </div>
      ${
        query && !prepared.matches.length
          ? html`<p class="muted" role="status">
              ${
                state.missingKey
                  ? 'No app has this API key.'
                  : 'No matches. Press Enter to look it up as an API key.'
              }
            </p>`
          : nothing
      }
      <div class="relations">
        <section class="card graph-card">
          <div class="graph-scroll">
            ${graphView(prepared, state, { chosen, pinned }, actions, live)}
          </div>
        </section>
        <aside class="card side" aria-label="Details">
          ${side(prepared, state, chosen, actions, live)}
        </aside>
      </div>
    </div>
  `;
}

/**
 * Builds the graph and its layout, again only when the data, the
 * environment's revisions, the choice, the pin, or the search changed. A
 * pinned chain stays shown, whatever is chosen or searched.
 */
function prepare(
  data: Relationships,
  rows: readonly Row[],
  state: RelationshipState,
): Prepared {
  const revisions = rows
    .map(
      row =>
        `${row.kind}/${row.name}@${row.cells[state.environment]?.revision ?? ''}`,
    )
    .join(',');
  const key = [
    data,
    state.environment,
    revisions,
    state.node,
    state.query,
    state.pinned,
  ];
  if (cache?.key.every((part, index) => part === key[index])) {
    return cache.value;
  }
  const sameGraph = cache?.key
    .slice(0, 3)
    .every((part, index) => part === key[index]);
  const graph =
    sameGraph && cache
      ? cache.value.graph
      : buildGraph(data, rows, state.environment, Date.now());
  const matches = search(graph, state.query);
  const chosen = graph.nodes.has(state.node) ? [state.node] : [];
  const roots = graph.nodes.has(state.pinned)
    ? [state.pinned]
    : chosen.length
      ? chosen
      : matches;
  const shown = roots.length
    ? lineage(graph, roots)
    : state.query.trim()
      ? new Set<string>()
      : undefined;
  const value = {
    graph,
    matches,
    shown,
    layout: layout(graph, shown, {
      limit,
      hooks: roots.length > 0,
      // The node chosen in a pinned chain stays in view too
      first: new Set([...roots, ...chosen]),
    }),
  };
  cache = { key, value };
  return value;
}

function graphView(
  prepared: Prepared,
  state: RelationshipState,
  { chosen, pinned }: { chosen: string; pinned: string },
  actions: RelationshipActions,
  live: (node: GraphNode) => { sign: Sign; label: string },
): TemplateResult {
  const { graph, layout: shape } = prepared;
  const matches = new Set(prepared.matches);
  const rowsDrawn = Math.max(
    1,
    ...shape.columns.map(column => column.ids.length),
  );
  return html`
    <div
      class="graph"
      @keydown=${(event: KeyboardEvent) =>
        moveInGraph(event, graph, shape, actions)}
    >
      ${columns.map((column, index) => {
        const { ids, hidden } = shape.columns[index];
        // Keyboard focus enters a column at its last focused node
        const entry = ids.includes(state.roving[column] ?? '')
          ? state.roving[column]
          : ids[0];
        return html`
          <section class="graph-column" aria-label=${titles[column]}>
            <h3 class="column-title">
              <span>${titles[column]}</span>
              <vscode-badge variant="counter"
                >${ids.length + hidden}</vscode-badge
              >
            </h3>
            <ul>
              ${ids.map(id => {
                const node = graph.nodes.get(id)!;
                return nodeItem(node, live(node), actions, {
                  tabbable: id === entry,
                  chosen: id === chosen,
                  pinned: id === pinned,
                  match: matches.has(id),
                });
              })}
              ${
                hidden
                  ? html`<li
                      class="more"
                      data-tooltip="Search or choose a node to see the others"
                    >
                      +${hidden.toLocaleString('en')} more
                    </li>`
                  : nothing
              }
            </ul>
          </section>
          ${
            index < columns.length - 1
              ? html`<div class="gutter" aria-hidden="true">
                  <svg width=${gutterWidth} height=${rowsDrawn * pitch}>
                    ${shape.gutters[index].map(
                      edge =>
                        svg`<path class=${`edge ${edge.kind ?? ''}`} d=${curve(edge.from, edge.to)}></path>`,
                    )}
                  </svg>
                </div>`
              : nothing
          }
        `;
      })}
    </div>
  `;
}

/**
 * A node of the graph. Its context menu pins its chain: the dashboard tells
 * VS Code which node it is when the menu opens.
 */
function nodeItem(
  node: GraphNode,
  state: { sign: Sign; label: string },
  actions: RelationshipActions,
  {
    tabbable,
    chosen,
    pinned,
    match,
  }: { tabbable: boolean; chosen: boolean; pinned: boolean; match: boolean },
): TemplateResult {
  const hooks = node.hooks?.length
    ? `Flow hook: ${node.hooks.map(point => hookNames[point]).join(', ')}`
    : '';
  const description = [state.label, hooks, pinned ? 'Pinned' : ''].filter(
    Boolean,
  );
  return html`
    <li>
      <button
        class=${match ? 'node match' : 'node'}
        data-id=${node.id}
        data-column=${node.column}
        tabindex=${tabbable ? 0 : -1}
        aria-current=${chosen ? 'true' : nothing}
        data-tooltip=${[node.name, ...description].join('\n')}
        @click=${() => actions.select(chosen ? '' : node.id)}
        @focus=${() => actions.rove(node.column, node.id)}
      >
        ${statusIcon(state.sign)}<span class="node-name">${node.name}</span>${
          hooks
            ? html`<vscode-icon name="plug" class="hook"></vscode-icon>`
            : nothing
        }${
          pinned
            ? html`<vscode-icon name="pinned" class="pin"></vscode-icon>`
            : nothing
        }<span class="sr-only">${description.join(', ')}</span>
      </button>
    </li>
  `;
}

/**
 * Moves the focus with the arrow keys: up and down within a column, left and
 * right to a connected node of the next column, or else the same row there.
 * Escape clears the choice, which shows all nodes again unless pinned.
 */
function moveInGraph(
  event: KeyboardEvent,
  graph: Graph,
  shape: Layout,
  actions: RelationshipActions,
): void {
  const target = event.target as HTMLElement;
  const id = target.dataset.id;
  if (!id) return;
  const column = columns.indexOf(target.dataset.column as Column);
  const ids = shape.columns[column].ids;
  const row = ids.indexOf(id);
  let next: string | undefined;
  switch (event.key) {
    case 'ArrowDown':
      next = ids[Math.min(row + 1, ids.length - 1)];
      break;
    case 'ArrowUp':
      next = ids[Math.max(row - 1, 0)];
      break;
    case 'Home':
      next = ids[0];
      break;
    case 'End':
      next = ids[ids.length - 1];
      break;
    case 'ArrowRight':
    case 'ArrowLeft': {
      const right = event.key === 'ArrowRight';
      const others = shape.columns[column + (right ? 1 : -1)]?.ids ?? [];
      const linked = new Set(
        (right ? graph.outgoing : graph.incoming)
          .get(id)
          ?.map(edge => (right ? edge.to : edge.from)),
      );
      next =
        others.find(other => linked.has(other)) ??
        others[Math.min(row, others.length - 1)];
      break;
    }
    case 'Escape':
      actions.select('');
      return;
    default:
      return;
  }
  event.preventDefault();
  if (!next) return;
  (event.currentTarget as HTMLElement)
    .querySelector<HTMLElement>(`[data-id="${CSS.escape(next)}"]`)
    ?.focus();
}

/** The details of the chosen node, the matches of a search, or the findings. */
function side(
  prepared: Prepared,
  state: RelationshipState,
  chosen: string,
  actions: RelationshipActions,
  live: (node: GraphNode) => { sign: Sign; label: string },
): TemplateResult {
  const { graph } = prepared;
  const node = graph.nodes.get(chosen);
  if (node) return details(node, graph, state, actions, live);
  const link = (node: GraphNode, text = node.name) => html`
    <button class="link" @click=${() => actions.select(node.id)}>
      ${text}
    </button>
  `;
  if (state.query.trim()) {
    const matches = prepared.matches.slice(0, listLimit);
    return html`
      <div class="card-head"><h3>Matches</h3></div>
      ${
        matches.length
          ? html`<ul class="relation-list">
              ${matches.map(id => {
                const node = graph.nodes.get(id)!;
                return html`<li>
                  ${statusIcon(live(node).sign)} ${link(node)}
                  <span class="muted">${singular[node.column]}</span>
                </li>`;
              })}
            </ul>`
          : html`<p class="muted">Nothing matches.</p>`
      }
    `;
  }

  // Without a choice, what needs attention, grouped by column
  const groups = columns.flatMap(column => {
    const noted = [...graph.nodes.values()]
      .filter(node => node.column === column && node.findings.length)
      .sort((a, b) => worst(a) - worst(b) || a.name.localeCompare(b.name));
    return noted.length ? [[column, noted] as const] : [];
  });
  return html`
    <div class="card-head"><h3>Findings</h3></div>
    ${
      groups.length
        ? groups.map(
            ([column, noted]) => html`
              <h4 class="group-title">${titles[column]}</h4>
              <ul class="relation-list">
                ${noted.slice(0, listLimit).map(
                  node =>
                    html`<li>
                      ${statusIcon(toneSign(node.findings[0].tone))}
                      ${link(node)}
                      <span class="muted"
                        >${node.findings.map(finding => finding.text).join(' · ')}</span
                      >
                    </li>`,
                )}
              </ul>
            `,
          )
        : html`<p class="muted">Nothing needs attention.</p>`
    }
    <p class="muted hint">Choose a node to see what it uses and who uses it.</p>
  `;
}

const singular: Readonly<Record<Column, string>> = {
  owners: 'Developer',
  apps: 'App',
  products: 'API Product',
  apis: 'API Proxy',
  sharedflows: 'Shared Flow',
};

function details(
  node: GraphNode,
  graph: Graph,
  state: RelationshipState,
  actions: RelationshipActions,
  live: (node: GraphNode) => { sign: Sign; label: string },
): TemplateResult {
  const current = live(node);
  const link = (other: GraphNode, text = other.name) => html`
    <button class="link" @click=${() => actions.select(other.id)}>
      ${text}
    </button>
  `;
  const kind =
    node.owner?.kind === 'appGroup' ? 'App Group' : singular[node.column];

  // Neighbors by column; a shared flow lists its flow hooks instead of every proxy
  const neighbors = new Map<Column, { node: GraphNode; note?: string }[]>();
  const add = (other: GraphNode | undefined, note?: string) => {
    if (!other) return;
    neighbors.set(other.column, [
      ...(neighbors.get(other.column) ?? []),
      { node: other, note },
    ]);
  };
  for (const edge of graph.incoming.get(node.id) ?? []) {
    if (edge.kind !== 'hook')
      add(graph.nodes.get(edge.from), approval(edge.kind));
  }
  for (const edge of graph.outgoing.get(node.id) ?? []) {
    add(
      graph.nodes.get(edge.to),
      edge.kind === 'hook' ? 'Flow hook' : approval(edge.kind),
    );
  }

  // The findings along its chain explain why calls may fail; a pinned chain
  // may be another one
  const lineal = [...lineage(graph, [node.id])];
  const chain = lineal
    .map(id => graph.nodes.get(id)!)
    .flatMap(other =>
      other.findings
        // The node's own keys show their state in its list of keys
        .filter(finding =>
          other === node ? finding.key === undefined : finding.tone !== 'info',
        )
        .map(finding => ({ node: other, finding })),
    )
    .sort((a, b) => rank(a.finding) - rank(b.finding));
  const counts = columns
    .filter(column => column !== node.column)
    .map(
      column =>
        [
          column,
          lineal.filter(id => graph.nodes.get(id)?.column === column).length,
        ] as const,
    )
    .filter(([, count]) => count);

  return html`
    <div class="side-head">
      ${statusIcon(current.sign)}
      <h3 tabindex="-1">${node.name}</h3>
    </div>
    <p class="muted">${kind} · ${current.label}</p>
    <dl class="facts">${facts(node, state)}</dl>
    ${
      node.app && node.keys?.length
        ? keysView(node.app, node.keys, actions)
        : nothing
    }
    ${
      node.row
        ? html`<button
            class="icon-button labeled"
            @click=${() => actions.openDetails(node.row!)}
          >
            <vscode-icon name="go-to-file"></vscode-icon>Show Details
          </button>`
        : nothing
    }
    ${columns.flatMap(column => {
      const list = neighbors.get(column);
      if (!list) return [];
      return html`
        <h4 class="group-title">${titles[column]}</h4>
        <ul class="relation-list">
          ${list
            .slice(0, listLimit)
            .map(
              ({ node: other, note }) =>
                html`<li>
                  ${statusIcon(live(other).sign)} ${link(other)}
                  ${note ? html`<span class="muted">${note}</span>` : nothing}
                </li>`,
            )}
          ${
            list.length > listLimit
              ? html`<li class="muted">+${list.length - listLimit} more</li>`
              : nothing
          }
        </ul>
      `;
    })}
    ${
      chain.length
        ? html`
            <h4 class="group-title">Along This Chain</h4>
            <ul class="relation-list">
              ${chain
                .slice(0, listLimit)
                .map(
                  ({ node: other, finding }) =>
                    html`<li>
                      ${statusIcon(toneSign(finding.tone))}
                      ${
                        other === node
                          ? html`<span class="fill">${finding.text}</span>`
                          : html`${link(other)}<span class="muted"
                                >${finding.text}</span
                              >`
                      }
                    </li>`,
                )}
            </ul>
          `
        : nothing
    }
    ${
      counts.length
        ? html`<p class="muted hint">
            In this chain:
            ${counts
              .map(([column, count]) => `${titles[column]} ${count}`)
              .join(' · ')}
          </p>`
        : nothing
    }
  `;
}

/**
 * The API keys of an app, by their last four characters, each with its state
 * and a button that copies the full key, which only the extension knows.
 */
function keysView(
  app: App,
  keys: readonly KeyState[],
  actions: RelationshipActions,
): TemplateResult {
  return html`
    <h4 class="group-title">API Keys</h4>
    <ul class="relation-list keys">
      ${app.keys.map((key, index) => {
        const state = keys[index];
        const products = key.products.map(product =>
          product.status === 'pending'
            ? `${product.name} (waiting for approval)`
            : product.status === 'revoked'
              ? `${product.name} (revoked)`
              : product.name,
        );
        const more = [
          key.issuedAt ? `Issued on ${date(key.issuedAt)}` : '',
          key.expiresAt
            ? `${key.expiresAt > Date.now() ? 'Expires' : 'Expired'} on ${date(key.expiresAt)}`
            : 'Never expires',
          products.length
            ? `API products: ${products.join(', ')}`
            : 'No linked API product',
        ].filter(Boolean);
        return html`<li data-tooltip=${more.join('\n')}>
          ${statusIcon(signs[state.sign])}<span>${state.name}</span>
          ${
            key.hint
              ? html`<button
                  class="icon-button"
                  data-tooltip="Copy API Key"
                  aria-label=${`Copy API Key ${state.name}`}
                  @click=${() => actions.copyKey(app.id, index)}
                >
                  <vscode-icon name="copy"></vscode-icon>
                </button>`
              : nothing
          }
          <span class="muted">${state.label}</span>
          <span class="sr-only">${more.join('. ')}</span>
        </li>`;
      })}
    </ul>
  `;
}

/** The facts of a node, as terms and descriptions. */
function facts(node: GraphNode, state: RelationshipState): TemplateResult[] {
  const fact = (term: string, value: unknown) =>
    value === undefined || value === ''
      ? []
      : [
          html`<dt>${term}</dt>
            <dd>${value}</dd>`,
        ];
  const attributes = (list: { name: string; value: string }[]) =>
    list.length
      ? fact(
          'Attributes',
          html`${list.map(
            attribute =>
              html`<div>
                <span class="muted">${attribute.name}</span> ${attribute.value}
              </div>`,
          )}`,
        )
      : [];
  if (node.owner) {
    return [
      ...fact('Name', node.owner.displayName),
      ...fact('Created', date(node.owner.createdAt)),
      ...attributes(node.owner.attributes),
    ];
  }
  if (node.app) {
    return [
      ...fact('Created', date(node.app.createdAt)),
      ...attributes(node.app.attributes),
    ];
  }
  if (node.product) {
    const product = node.product;
    return [
      ...fact('Display Name', product.displayName),
      ...fact(
        'Approval',
        product.approvalType === 'manual'
          ? 'Manual'
          : product.approvalType === 'auto'
            ? 'Automatic'
            : undefined,
      ),
      ...fact(
        'Environments',
        product.environments.length ? product.environments.join(', ') : 'All',
      ),
      ...fact('Quota', product.quota),
      ...attributes(product.attributes),
    ];
  }
  if (node.hooks?.length) {
    return fact(
      'Flow Hooks',
      `${node.hooks.map(point => hookNames[point]).join(', ')}, for every API proxy in ${state.environment}`,
    );
  }
  return [];
}

/** Returns the live state of a node; proxies and shared flows by deployment. */
function liveState(
  node: GraphNode,
  rows: ReadonlyMap<string, Row>,
  environment: string,
  loading: boolean,
): { sign: Sign; label: string } {
  if (node.column !== 'apis' && node.column !== 'sharedflows') {
    return { sign: signs[node.sign ?? 'unknown'], label: node.label ?? '' };
  }
  const row = rows.get(node.id);
  if (!row) return { sign: signs.unknown, label: node.label ?? 'Not found' };
  const cell = row.cells[environment];
  if (!cell)
    return { sign: signs.none, label: `Not deployed in ${environment}` };
  const status = cell.state || !loading ? statuses[statusOf(cell)] : checking;
  return { sign: status, label: `${status.label} · Revision ${cell.revision}` };
}

/** What an edge between an app and an API product says, if anything. */
function approval(kind: string | undefined): string | undefined {
  if (kind === 'pending') return 'Waiting for approval';
  if (kind === 'revoked') return 'No working API key';
  return undefined;
}

// Remarks look like the info notes above the tabs
const remark: Sign = { icon: 'info', tone: 'neutral' };

function toneSign(tone: Finding['tone']): Sign {
  return tone === 'error'
    ? signs.error
    : tone === 'warning'
      ? signs.warning
      : remark;
}

function rank(finding: Finding): number {
  return ['error', 'warning', 'info'].indexOf(finding.tone);
}

function worst(node: GraphNode): number {
  return Math.min(...node.findings.map(rank));
}

function date(time?: number): string | undefined {
  return time
    ? new Date(time).toLocaleDateString(undefined, { dateStyle: 'medium' })
    : undefined;
}
