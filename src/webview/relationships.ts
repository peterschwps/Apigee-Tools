// The Relationships tab: who uses what in an organization, in columns from the
// owners of apps to the shared flows that proxies call, with the details of
// the chosen node beside them.
import type { VscodeTextfield } from '@vscode-elements/elements/dist/vscode-textfield/index.js';
import { html, nothing, svg, type TemplateResult } from 'lit';
import type { FlowHookPoint, Relationships, Row } from '../protocol';
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
  type Layout,
} from './graph';

/** The state of the tab; only `node` is kept with the view. */
export type RelationshipState = {
  environment: string;
  /** The chosen node, or empty. */
  node: string;
  /** The search text, never kept: it may hold a full API key. */
  query: string;
  /** Whether the host found no app with the key searched for. */
  missingKey: boolean;
  /** The node of each column that keyboard focus enters it at. */
  roving: Partial<Record<Column, string>>;
};

export type RelationshipActions = {
  select(node: string): void;
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
  keys: 'API Keys',
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
          state.node || query
            ? html`<button
                class="icon-button labeled show-all"
                @click=${() => {
                  actions.setQuery('');
                  actions.select('');
                }}
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
            ${graphView(prepared, state, actions, live)}
          </div>
        </section>
        <aside class="card side" aria-label="Details">
          ${side(prepared, state, actions, live)}
        </aside>
      </div>
    </div>
  `;
}

/**
 * Builds the graph and its layout, again only when the data, the
 * environment's revisions, the choice, or the search changed.
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
  const key = [data, state.environment, revisions, state.node, state.query];
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
  const roots = graph.nodes.has(state.node) ? [state.node] : matches;
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
      first: new Set(roots),
    }),
  };
  cache = { key, value };
  return value;
}

function graphView(
  prepared: Prepared,
  state: RelationshipState,
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
                return nodeItem(
                  node,
                  live(node),
                  id === entry,
                  id === state.node,
                  matches.has(id),
                  actions,
                );
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

function nodeItem(
  node: GraphNode,
  state: { sign: Sign; label: string },
  tabbable: boolean,
  chosen: boolean,
  match: boolean,
  actions: RelationshipActions,
): TemplateResult {
  const hooks = node.hooks?.length
    ? `Flow hook: ${node.hooks.map(point => hookNames[point]).join(', ')}`
    : '';
  const description = [state.label, hooks].filter(Boolean);
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
        }<span class="sr-only">${description.join(', ')}</span>
      </button>
    </li>
  `;
}

/**
 * Moves the focus with the arrow keys: up and down within a column, left and
 * right to a connected node of the next column, or else the same row there.
 * Escape shows all nodes again.
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
  actions: RelationshipActions,
  live: (node: GraphNode) => { sign: Sign; label: string },
): TemplateResult {
  const { graph } = prepared;
  const chosen = graph.nodes.get(state.node);
  if (chosen) return details(chosen, prepared, state, actions, live);
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
  keys: 'API Key',
  products: 'API Product',
  apis: 'API Proxy',
  sharedflows: 'Shared Flow',
};

function details(
  node: GraphNode,
  prepared: Prepared,
  state: RelationshipState,
  actions: RelationshipActions,
  live: (node: GraphNode) => { sign: Sign; label: string },
): TemplateResult {
  const { graph } = prepared;
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

  // The findings along the chain explain why calls may fail
  const chain = [...(prepared.shown ?? [])]
    .map(id => graph.nodes.get(id)!)
    .flatMap(other =>
      other.findings
        .filter(finding => other === node || finding.tone !== 'info')
        .map(finding => ({ node: other, finding })),
    )
    .sort((a, b) => rank(a.finding) - rank(b.finding));
  const counts = columns
    .filter(column => column !== node.column)
    .map(
      column =>
        [
          column,
          [...(prepared.shown ?? [])].filter(
            id => graph.nodes.get(id)?.column === column,
          ).length,
        ] as const,
    )
    .filter(([, count]) => count);

  return html`
    <div class="side-head">
      ${statusIcon(current.sign)}
      <h3>${node.name}</h3>
    </div>
    <p class="muted">${kind} · ${current.label}</p>
    <dl class="facts">${facts(node, state)}</dl>
    ${
      node.key
        ? html`<button
            class="icon-button labeled"
            @click=${() => actions.copyKey(node.app!.id, node.key!.index)}
          >
            <vscode-icon name="copy"></vscode-icon>Copy API Key
          </button>`
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
                          ? finding.text
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
  if (node.key && node.app) {
    const key = node.key.value;
    return [
      ...fact('Issued', date(key.issuedAt)),
      ...fact('Expires', key.expiresAt ? date(key.expiresAt) : 'Never'),
    ];
  }
  if (node.app) {
    return [
      ...fact('Created', date(node.app.createdAt)),
      ...fact('Keys', String(node.app.keys.length)),
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

function approval(kind: string | undefined): string | undefined {
  if (kind === 'pending') return 'Waiting for approval';
  if (kind === 'revoked') return 'Revoked';
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
