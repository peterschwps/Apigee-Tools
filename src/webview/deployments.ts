// The Deployments tab: the proxies and shared flows of one environment in a
// tab each, with their status, revision, comparison with the local bundle,
// and problems.
import type { VscodeSingleSelect } from '@vscode-elements/elements/dist/vscode-single-select/index.js';
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
type ComparisonKey = 'matches' | 'differs' | 'unknown';

/** The tab and the filters of the Deployments tab; empty filters show all. */
export type DeploymentView = {
  environment: string;
  kind: Kind;
  filter: string;
  status: StatusKey | '';
  comparison: ComparisonKey | '';
};

/** How the tabs report actions: messages to the extension and view changes. */
export type Actions = {
  send(message: WebviewMessage): void;
  setView(patch: Partial<DeploymentView>): void;
};

/**
 * How a state shows: an icon whose shape differs per state, never color
 * alone; the label is its tooltip, its accessible name, and its filter option.
 */
type StatusInfo = {
  label: string;
  /** Codicon name without the `codicon-` prefix. */
  icon: string;
  tone: 'success' | 'warning' | 'error' | 'neutral';
};

export const kindLabels: Readonly<Record<Kind, string>> = {
  apis: 'API Proxy',
  sharedflows: 'Shared Flow',
};

const tabs: [Kind, string][] = [
  ['apis', 'API Proxies'],
  ['sharedflows', 'Shared Flows'],
];

const statuses: Readonly<Record<StatusKey, StatusInfo>> = {
  ready: { label: 'Ready', icon: 'pass-filled', tone: 'success' },
  warnings: { label: 'Warnings', icon: 'warning', tone: 'warning' },
  failed: { label: 'Failed', icon: 'error', tone: 'error' },
  deploying: { label: 'Deploying', icon: 'sync', tone: 'neutral' },
  unknown: { label: 'Unknown', icon: 'question', tone: 'neutral' },
  none: { label: 'Not deployed', icon: 'dash', tone: 'neutral' },
};

export const comparisons: Readonly<Record<ComparisonKey, StatusInfo>> = {
  matches: { label: 'Matches', icon: 'check', tone: 'neutral' },
  differs: { label: 'Differs', icon: 'diff-modified', tone: 'warning' },
  unknown: { label: 'Not compared', icon: 'question', tone: 'neutral' },
};

/** What Apigee's route conflicts mean; its own messages follow. */
const conflictHint =
  'Base path conflict: another environment in the same environment group serves this base path too, so Apigee routes its requests to only one of them.';

/** Returns whether a deployment failed or has a route conflict. */
export function isProblem(cell: Cell): boolean {
  return cell.state === 'ERROR' || Boolean(cell.routeConflicts?.length);
}

/** Returns how a deployment is doing; without a cell, it is not deployed. */
function statusOf(cell: Cell | undefined): StatusKey {
  if (!cell) return 'none';
  if (cell.state === 'ERROR') return 'failed';
  if (cell.routeConflicts?.length) return 'warnings';
  if (cell.state === 'READY') return 'ready';
  if (cell.state === 'PROGRESSING') return 'deploying';
  return 'unknown';
}

/** Returns how a deployment compares with its local bundle, if it has one. */
function comparisonOf(
  row: Row,
  cell: Cell | undefined,
): ComparisonKey | undefined {
  if (!cell || !row.local) return undefined;
  if (cell.drift === undefined) return 'unknown';
  return cell.drift ? 'differs' : 'matches';
}

/** Renders a status icon, colored by tone. */
export function statusIcon(status: Pick<StatusInfo, 'icon' | 'tone'>) {
  return html`<vscode-icon
    name=${status.icon}
    class="tone-${status.tone}"
  ></vscode-icon>`;
}

/** Renders a state as its icon; the tooltip of its cell names it. */
function stateIcon(status: StatusInfo, tooltip: string) {
  return html`${statusIcon(status)}<span class="sr-only">${tooltip}</span>`;
}

/** Returns the Apigee console page of a proxy or shared flow. */
function consoleUrl(projectId: string, row: Row): string {
  const collection = row.kind === 'apis' ? 'proxies' : 'sharedflows';
  return `https://console.cloud.google.com/apigee/${collection}/${encodeURIComponent(row.name)}/overview?project=${encodeURIComponent(projectId)}`;
}

/** Messages of a deployment: errors first, then route conflicts. */
function details(cell: Cell): string[] {
  return [...(cell.errors ?? []), ...(cell.routeConflicts ?? [])];
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
      (!view.comparison || comparisonOf(row, cell) === view.comparison)
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
        ${filterSelect(
          'status-filter',
          'Status',
          view.status,
          statuses,
          status => actions.setView({ status }),
        )}
        ${filterSelect(
          'comparison-filter',
          'Local Bundle',
          view.comparison,
          comparisons,
          comparison => actions.setView({ comparison }),
        )}
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

/** A select that filters by one column; its first option shows all rows. */
function filterSelect<Key extends string>(
  id: string,
  label: string,
  selected: Key | '',
  options: Readonly<Record<Key, StatusInfo>>,
  select: (key: Key | '') => void,
) {
  return html`
    <div class="field">
      <vscode-label for=${id}>
        <span class="field-label">${label}</span>
      </vscode-label>
      <vscode-single-select
        id=${id}
        @change=${(event: Event) =>
          select((event.target as VscodeSingleSelect).value as Key | '')}
      >
        <vscode-option value="" ?selected=${!selected}>All</vscode-option>
        ${(Object.keys(options) as Key[]).map(
          key => html`
            <vscode-option value=${key} ?selected=${key === selected}
              >${options[key].label}</vscode-option
            >
          `,
        )}
      </vscode-single-select>
    </div>
  `;
}

/**
 * The proxies and the shared flows in a tab each, counted after filtering;
 * the problems below a table follow its filters.
 */
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
            ${table(snapshot, rows, kind, label, view.environment, actions)}
            ${problemList(rows, view.environment)}
          </vscode-tab-panel>
        `;
      })}
    </vscode-tabs>
  `;
}

/** The deployments of one kind in the chosen environment. */
function table(
  snapshot: Loaded,
  rows: Row[],
  kind: Kind,
  label: string,
  environment: string,
  actions: Actions,
) {
  return html`
    <div class="table-scroll">
      <table class="deployments">
        <caption class="sr-only">
          ${label} in ${environment}
        </caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col" class="icon-cell">Status</th>
            <th scope="col" class="revision">Revision</th>
            <th scope="col" class="icon-cell">Local Bundle</th>
            <th scope="col" class="actions">
              <span class="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          ${
            rows.length
              ? rows.map(row =>
                  deploymentRow(snapshot, row, environment, actions),
                )
              : html`
                  <tr>
                    <td class="empty" colspan="5">
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

/** One row: name, status icon, revision, comparison icon, and Compare. */
function deploymentRow(
  snapshot: Loaded,
  row: Row,
  environment: string,
  actions: Actions,
) {
  const cell = row.cells[environment];
  const statusKey = statusOf(cell);
  const comparisonKey = comparisonOf(row, cell);
  // Unknown states may still be loading
  const loading = (key?: string) => key === 'unknown' && snapshot.loading;
  const status = loading(statusKey)
    ? { label: 'Checking…', icon: 'clock', tone: 'neutral' as const }
    : statuses[statusKey];
  const comparison = loading(comparisonKey)
    ? { label: 'Comparing…', icon: 'clock', tone: 'neutral' as const }
    : comparisonKey && comparisons[comparisonKey];
  const conflicts = cell?.routeConflicts ?? [];
  const tooltip = [
    status.label,
    ...(cell?.errors ?? []),
    ...(conflicts.length ? [conflictHint, ...conflicts] : []),
  ].join('\n');
  return html`
    <tr>
      <th scope="row">
        <a
          href=${consoleUrl(snapshot.overview.projectId, row)}
          title="Open in the Apigee console"
          >${row.name}<span class="sr-only">
            (opens the Apigee console)</span
          ></a
        >
      </th>
      <td class="icon-cell" title=${tooltip}>${stateIcon(status, tooltip)}</td>
      <td class="revision">${cell ? cell.revision : nothing}</td>
      <td class="icon-cell" title=${comparison ? comparison.label : nothing}>
        ${comparison ? stateIcon(comparison, comparison.label) : nothing}
      </td>
      <td class="actions">
        ${
          cell && row.local
            ? html`<button
                class="icon-button"
                title="Compare with local"
                aria-label=${`Compare revision ${cell.revision} in ${environment} with the local bundle`}
                @click=${() =>
                  actions.send({
                    type: 'compare',
                    kind: row.kind,
                    name: row.name,
                    environment,
                  })}
              >
                <vscode-icon name="git-compare"></vscode-icon>
              </button>`
            : nothing
        }
      </td>
    </tr>
  `;
}

/** The failed deployments and route conflicts shown, with their messages. */
function problemList(rows: Row[], environment: string) {
  const problems = rows.flatMap(row => {
    const cell = row.cells[environment];
    return cell && isProblem(cell) ? [{ row, cell }] : [];
  });
  if (!problems.length) return nothing;
  return html`
    <section class="problem-section">
      <h3>Problems</h3>
      <ul class="problems">
        ${problems.map(({ row, cell }) => {
          const status = statuses[statusOf(cell)];
          return html`
            <li>
              ${statusIcon(status)}
              <span>
                <strong>${row.name}</strong>, revision ${cell.revision}:
                ${status.label}
              </span>
              ${details(cell).map(
                message => html`<span class="detail">${message}</span>`,
              )}
            </li>
          `;
        })}
      </ul>
    </section>
  `;
}
