// The Deployments tab: the proxies and shared flows of one environment in a
// tab each, with their status, revision, and comparison with the workspace; a
// name opens its details.
import type { VscodeTextfield } from '@vscode-elements/elements/dist/vscode-textfield/index.js';
import { html, nothing } from 'lit';
import type {
  Cell,
  Kind,
  Overview,
  Row,
  Snapshot,
  WebviewMessage,
} from '../protocol';

/** A snapshot with data to show. */
export type Loaded = Snapshot & { overview: Overview; rows: Row[] };

/** How a deployment is doing in its environment. */
type StatusKey =
  'ready' | 'warnings' | 'failed' | 'deploying' | 'unknown' | 'none';

/** How a deployment compares with the local bundle of its name. */
type ComparisonKey = 'matches' | 'differs' | 'unknown' | 'absent';

/** The tab and the filters of the Deployments tab; empty filters show all. */
export type DeploymentView = {
  environment: string;
  kind: Kind;
  filter: string;
  status: StatusKey | '';
  comparison: ComparisonKey | '';
  /** The order of the names. */
  sort: 'asc' | 'desc';
  /** The proxy or shared flow of `kind` whose details show, if any. */
  detail: string;
};

/** How the tabs report actions: messages to the extension and view changes. */
export type Actions = {
  send(message: WebviewMessage): void;
  setView(patch: Partial<DeploymentView>): void;
  /** Shows the details of a row and loads what they still miss. */
  openDetails(row: Row): void;
};

/**
 * How a state shows: an icon whose shape differs per state, never color
 * alone; the label is its filter option and, unless a tooltip says more, its
 * tooltip and accessible name.
 */
type StatusInfo = {
  label: string;
  tooltip?: string;
  /** Codicon name without the `codicon-` prefix. */
  icon: string;
  tone: 'success' | 'warning' | 'error' | 'info' | 'neutral';
};

export const kindLabels: Readonly<Record<Kind, string>> = {
  apis: 'API Proxy',
  sharedflows: 'Shared Flow',
};

const tabs: [Kind, string][] = [
  ['apis', 'API Proxies'],
  ['sharedflows', 'Shared Flows'],
];

type Sign = Pick<StatusInfo, 'icon' | 'tone'>;

/**
 * The icons of the dashboard, one per meaning: every view shows the same
 * meaning with the same icon and color.
 */
export const signs = {
  good: { icon: 'pass-filled', tone: 'success' },
  warning: { icon: 'warning', tone: 'warning' },
  error: { icon: 'error', tone: 'error' },
  unknown: { icon: 'question', tone: 'info' },
  /** A deployment whose files differ from the workspace. */
  differs: { icon: 'diff-modified', tone: 'warning' },
  /** Apigee is still working on it. */
  busy: { icon: 'sync', tone: 'neutral' },
  /** The dashboard is still loading it. */
  loading: { icon: 'clock', tone: 'neutral' },
  /** A missing value. */
  none: { icon: 'dash', tone: 'neutral' },
} satisfies Record<string, Sign>;

export const statuses: Readonly<Record<StatusKey, StatusInfo>> = {
  ready: { label: 'Ready', ...signs.good },
  warnings: { label: 'Warnings', ...signs.warning },
  failed: { label: 'Failed', ...signs.error },
  deploying: { label: 'Deploying', ...signs.busy },
  unknown: { label: 'Unknown', ...signs.unknown },
  none: { label: 'Not deployed', ...signs.none },
};

export const comparisons: Readonly<Record<ComparisonKey, StatusInfo>> = {
  matches: {
    label: 'Same',
    tooltip: 'Same as in the workspace',
    ...signs.good,
  },
  differs: {
    label: 'Differs',
    tooltip: 'Differs from the workspace',
    ...signs.differs,
  },
  // A comparison that failed needs attention, unlike an unknown status
  unknown: { label: 'Not compared', ...signs.warning },
  absent: {
    label: 'Not in workspace',
    tooltip: 'Not in the workspace',
    ...signs.none,
  },
};

// Unknown states while a load may still bring them
const checking: StatusInfo = { label: 'Checking…', ...signs.loading };
const comparing: StatusInfo = { ...checking, label: 'Comparing…' };

/** What Apigee's route conflicts mean; its own messages follow. */
export const conflictHint =
  'Base path conflict: another environment in the same environment group serves this base path too, so Apigee routes its requests to only one of them.';

/** The messages of a deployment: errors, then explained route conflicts. */
export function messagesOf(cell: Cell): string[] {
  const conflicts = cell.routeConflicts ?? [];
  return [
    ...(cell.errors ?? []),
    ...(conflicts.length ? [conflictHint, ...conflicts] : []),
  ];
}

/** Returns whether a deployment failed or has a route conflict. */
export function isProblem(cell: Cell): boolean {
  return cell.state === 'ERROR' || Boolean(cell.routeConflicts?.length);
}

/** Returns how a deployment is doing; without a cell, it is not deployed. */
export function statusOf(cell: Cell | undefined): StatusKey {
  if (!cell) return 'none';
  if (cell.state === 'ERROR') return 'failed';
  if (cell.routeConflicts?.length) return 'warnings';
  if (cell.state === 'READY') return 'ready';
  if (cell.state === 'PROGRESSING') return 'deploying';
  return 'unknown';
}

/** Returns how a deployment compares with the bundle of its name, if any. */
function comparisonOf(snapshot: Loaded, row: Row, cell: Cell): ComparisonKey {
  if (row.local) {
    if (cell.drift === undefined) return 'unknown';
    return cell.drift ? 'differs' : 'matches';
  }
  return sharesName(snapshot, row) ? 'unknown' : 'absent';
}

/** Returns whether several bundles in the workspace have the name of a row. */
function sharesName(snapshot: Loaded, row: Row): boolean {
  const bundles = (snapshot.bundles ?? []).filter(
    bundle => bundle.kind === row.kind && bundle.name === row.name,
  );
  return bundles.length > 1;
}

/** Renders a status icon, colored by tone. */
export function statusIcon(status: Sign) {
  return html`<vscode-icon
    name=${status.icon}
    class="tone-${status.tone}"
  ></vscode-icon>`;
}

/** A cell with the icon of a state, which its tooltip names. */
function stateCell(status: StatusInfo | undefined) {
  const tooltip = status && (status.tooltip ?? status.label);
  return html`<td class="icon-cell" data-tooltip=${tooltip ?? nothing}>
    ${
      status
        ? html`${statusIcon(status)}<span class="sr-only">${tooltip}</span>`
        : nothing
    }
  </td>`;
}

/** A dash for a missing value, which screen readers read as "None". */
export function none() {
  return html`${statusIcon(statuses.none)}<span class="sr-only">None</span>`;
}

/** The status of a deployment. */
export function statusCell(snapshot: Loaded, cell: Cell | undefined) {
  const key = statusOf(cell);
  return stateCell(
    key === 'unknown' && snapshot.loading ? checking : statuses[key],
  );
}

export function revisionCell(cell: Cell | undefined) {
  return html`<td class="revision">${cell ? cell.revision : none()}</td>`;
}

/**
 * How a deployment compares with the workspace; the icon of one that differs
 * opens the comparison.
 */
export function workspaceCell(
  snapshot: Loaded,
  row: Row,
  environment: string,
  actions: Actions,
) {
  const cell = row.cells[environment];
  if (!cell) return stateCell(statuses.none);
  const key = comparisonOf(snapshot, row, cell);
  if (key === 'differs') {
    const tooltip = comparisons.differs.tooltip;
    return html`<td class="icon-cell">
      <button
        class="icon-button"
        data-tooltip=${`${tooltip}\nClick to compare`}
        aria-label=${`${tooltip}. Compare revision ${cell.revision}`}
        @click=${() =>
          actions.send({
            type: 'compare',
            kind: row.kind,
            name: row.name,
            environment,
          })}
      >
        ${statusIcon(comparisons.differs)}
      </button>
    </td>`;
  }
  if (key === 'unknown' && !row.local) {
    return stateCell({
      ...comparisons.unknown,
      tooltip: 'Not compared: several bundles share this name',
    });
  }
  return stateCell(
    key === 'unknown' && snapshot.loading ? comparing : comparisons[key],
  );
}

/** Returns the Apigee console page of a proxy or shared flow. */
export function consoleUrl(projectId: string, row: Row): string {
  const collection = row.kind === 'apis' ? 'proxies' : 'sharedflows';
  return `https://console.cloud.google.com/apigee/${collection}/${encodeURIComponent(row.name)}/overview?project=${encodeURIComponent(projectId)}`;
}

export function deployments(
  snapshot: Loaded,
  view: DeploymentView,
  actions: Actions,
) {
  const { environment } = view;
  const query = view.filter.trim().toLowerCase();
  const shown = snapshot.rows.filter(row => {
    const cell = row.cells[environment];
    return (
      row.name.toLowerCase().includes(query) &&
      (!view.status || statusOf(cell) === view.status) &&
      (!view.comparison ||
        (cell && comparisonOf(snapshot, row, cell) === view.comparison))
    );
  });
  const count = (rows: Row[]) =>
    rows.filter(row => row.kind === view.kind).length;
  return html`
    <div class="page">
      <div class="toolbar">
        <vscode-textfield
          placeholder="Filter by name"
          .label=${'Filter by name'}
          .value=${view.filter}
          @input=${(event: Event) =>
            actions.setView({
              filter: (event.target as VscodeTextfield).value,
            })}
        >
          <vscode-icon slot="content-before" name="filter"></vscode-icon>
        </vscode-textfield>
        <span class="count" aria-live="polite" aria-atomic="true">
          ${count(shown)} of ${count(snapshot.rows)} shown
        </span>
      </div>
      <section class="card">
        ${
          environment
            ? kindTabs(snapshot, shown, view, actions)
            : html`<p class="muted">
                This organization has no environments yet.
              </p>`
        }
      </section>
    </div>
  `;
}

/**
 * A filter in a column header: an icon button that opens a menu of the
 * column's states, with "All" first; an active filter fills the icon.
 */
function columnFilter<Key extends string>(
  id: string,
  column: string,
  selected: Key | '',
  options: Readonly<Record<Key, StatusInfo>>,
  select: (key: Key | '') => void,
) {
  const items: [Key | '', string, StatusInfo | undefined][] = [
    ['', 'All', undefined],
    ...(Object.keys(options) as Key[]).map(
      key =>
        [key, options[key].label, options[key]] as [Key, string, StatusInfo],
    ),
  ];
  const tooltip = selected
    ? `${column}: ${options[selected].label}`
    : `Filter by ${column.toLowerCase()}`;
  return html`
    <button
      class="icon-button"
      popovertarget=${id}
      aria-haspopup="menu"
      aria-label=${tooltip}
      data-tooltip=${tooltip}
    >
      <vscode-icon name=${selected ? 'filter-filled' : 'filter'}></vscode-icon>
    </button>
    <div
      id=${id}
      class="menu"
      popover
      role="menu"
      aria-label=${`Filter by ${column.toLowerCase()}`}
      @beforetoggle=${placeMenu}
      @toggle=${focusOnToggle}
      @keydown=${moveInMenu}
      @focusout=${closeOnLeave}
    >
      ${items.map(
        ([key, label, sign]) => html`
          <button
            class="menu-item"
            role="menuitemradio"
            aria-checked=${key === selected ? 'true' : 'false'}
            @click=${(event: Event) => {
              (event.currentTarget as HTMLElement)
                .closest<HTMLElement>('[popover]')
                ?.hidePopover();
              select(key);
            }}
          >
            <vscode-icon
              name="check"
              class=${key === selected ? '' : 'unchecked'}
            ></vscode-icon>
            ${sign ? statusIcon(sign) : html`<span class="no-icon"></span>`}
            ${label}
          </button>
        `,
      )}
    </div>
  `;
}

/** Places a menu below the button that opens it, inside the window. */
function placeMenu(event: ToggleEvent) {
  if (event.newState !== 'open') return;
  const menu = event.target as HTMLElement;
  const box = (
    menu.previousElementSibling as HTMLElement
  ).getBoundingClientRect();
  menu.style.top = `${box.bottom + 2}px`;
  // Near the right edge, the menu ends at the button instead of starting there
  const right = box.left + 220 > innerWidth;
  menu.style.left = right ? 'auto' : `${box.left}px`;
  menu.style.right = right ? `${innerWidth - box.right}px` : 'auto';
}

/**
 * Focuses the checked item of a menu that opened, and the button again when a
 * menu closes with the focus inside, such as after a choice or Escape.
 */
function focusOnToggle(event: ToggleEvent) {
  const menu = event.target as HTMLElement;
  if (event.newState === 'open') {
    menu.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    return;
  }
  const focused = (menu.getRootNode() as ShadowRoot).activeElement;
  if (!focused || menu.contains(focused)) {
    (menu.previousElementSibling as HTMLElement).focus();
  }
}

/** Moves the focus through a menu with the arrow keys, Home, and End. */
function moveInMenu(event: KeyboardEvent) {
  const items = [
    ...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>(
      '[role^="menuitem"]',
    ),
  ];
  const index = items.indexOf(event.target as HTMLElement);
  const next = {
    ArrowDown: (index + 1) % items.length,
    ArrowUp: (index - 1 + items.length) % items.length,
    Home: 0,
    End: items.length - 1,
  }[event.key];
  if (next === undefined) return;
  event.preventDefault();
  items[next].focus();
}

/** Closes a menu once the focus leaves it, such as with Tab. */
function closeOnLeave(event: FocusEvent) {
  const menu = event.currentTarget as HTMLElement;
  if (!menu.contains(event.relatedTarget as Node | null)) menu.hidePopover();
}

/** The proxies and the shared flows in a tab each, counted after filtering. */
function kindTabs(
  snapshot: Loaded,
  shown: Row[],
  view: DeploymentView,
  actions: Actions,
) {
  const selected = Math.max(
    0,
    tabs.findIndex(([kind]) => kind === view.kind),
  );
  return html`
    <vscode-tabs
      selected-index=${selected}
      @vsc-tabs-select=${(event: CustomEvent<{ selectedIndex: number }>) =>
        actions.setView({ kind: tabs[event.detail.selectedIndex][0] })}
    >
      ${tabs.map(
        ([kind, label]) => html`
          <vscode-tab-header slot="header">
            <span class="tab-label">${label}</span>
            <vscode-badge variant="counter" slot="content-after"
              >${shown.filter(row => row.kind === kind).length}</vscode-badge
            >
          </vscode-tab-header>
        `,
      )}
      ${tabs.map(([kind, label]) => {
        const rows = shown.filter(row => row.kind === kind);
        return html`
          <vscode-tab-panel>
            ${table(snapshot, rows, kind, label, view, actions)}
          </vscode-tab-panel>
        `;
      })}
    </vscode-tabs>
  `;
}

/** The deployments of one kind in the chosen environment, sorted by name. */
function table(
  snapshot: Loaded,
  rows: Row[],
  kind: Kind,
  label: string,
  view: DeploymentView,
  actions: Actions,
) {
  const { environment } = view;
  const order = view.sort === 'desc' ? -1 : 1;
  const sorted = [...rows].sort((a, b) => order * a.name.localeCompare(b.name));
  return html`
    <div class="table-scroll">
      <table class="deployments">
        <caption class="sr-only">
          ${label} in ${environment}
        </caption>
        <thead>
          <tr>
            <th
              scope="col"
              aria-sort=${view.sort === 'desc' ? 'descending' : 'ascending'}
            >
              <button
                class="icon-button labeled sort"
                @click=${() =>
                  actions.setView({
                    sort: view.sort === 'desc' ? 'asc' : 'desc',
                  })}
              >
                Name<vscode-icon
                  name=${view.sort === 'desc' ? 'arrow-down' : 'arrow-up'}
                ></vscode-icon>
              </button>
            </th>
            <th scope="col" class="icon-cell">
              Status
              ${columnFilter(
                `${kind}-status`,
                'Status',
                view.status,
                statuses,
                status => actions.setView({ status }),
              )}
            </th>
            <th scope="col" class="revision">Revision</th>
            <th scope="col" class="icon-cell">
              Workspace
              ${columnFilter(
                `${kind}-comparison`,
                'Workspace',
                view.comparison,
                comparisons,
                comparison => actions.setView({ comparison }),
              )}
            </th>
          </tr>
        </thead>
        <tbody>
          ${
            sorted.length
              ? sorted.map(row =>
                  deploymentRow(snapshot, row, environment, actions),
                )
              : html`
                  <tr>
                    <td class="empty" colspan="4">
                      ${
                        snapshot.rows.some(row => row.kind === kind)
                          ? 'None match the filters.'
                          : 'None in this organization yet.'
                      }
                    </td>
                  </tr>
                `
          }
        </tbody>
      </table>
    </div>
  `;
}

/** One row; its name opens the details. */
function deploymentRow(
  snapshot: Loaded,
  row: Row,
  environment: string,
  actions: Actions,
) {
  const cell = row.cells[environment];
  return html`
    <tr>
      <th scope="row">
        <button
          class="link"
          data-name=${`${row.kind}/${row.name}`}
          @click=${() => actions.openDetails(row)}
        >
          ${row.name}
        </button>
      </th>
      ${statusCell(snapshot, cell)} ${revisionCell(cell)}
      ${workspaceCell(snapshot, row, environment, actions)}
    </tr>
  `;
}
