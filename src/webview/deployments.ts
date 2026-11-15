// The Deployments tab: the proxies and shared flows of one environment, with
// their deployment status, revision, comparison with local bundles, and
// problems.
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

/** The filters of the Deployments tab. */
export type DeploymentView = {
  environment: string;
  filter: string;
  onlyProblems: boolean;
};

/** How the tabs report actions: messages to the extension and view changes. */
export type Actions = {
  send(message: WebviewMessage): void;
  setView(patch: Partial<DeploymentView>): void;
};

/**
 * How a status shows: an icon whose shape differs per status, never color
 * alone; the label is its tooltip, its accessible name, and its legend entry.
 */
type StatusInfo = {
  label: string;
  /** Codicon name without the `codicon-` prefix. */
  icon: string;
  tone: 'success' | 'warning' | 'error' | 'neutral';
};

export const kindLabels: Readonly<Record<Kind, string>> = {
  apis: 'API proxy',
  sharedflows: 'Shared flow',
};

const groups: [Kind, string][] = [
  ['apis', 'API Proxies'],
  ['sharedflows', 'Shared Flows'],
];

const ready: StatusInfo = {
  label: 'Ready',
  icon: 'pass-filled',
  tone: 'success',
};
const conflict: StatusInfo = {
  label: 'Route conflict',
  icon: 'warning',
  tone: 'warning',
};
const failed: StatusInfo = { label: 'Failed', icon: 'error', tone: 'error' };
const deploying: StatusInfo = {
  label: 'Deploying',
  icon: 'sync',
  tone: 'neutral',
};
const unchecked: StatusInfo = {
  label: 'Status not checked',
  icon: 'clock',
  tone: 'neutral',
};
const matches: StatusInfo = {
  label: 'Matches the local bundle',
  icon: 'check',
  tone: 'neutral',
};
const differs: StatusInfo = {
  label: 'Differs from the local bundle',
  icon: 'diff-modified',
  tone: 'warning',
};
const incomparable: StatusInfo = {
  label: 'Comparison with the local bundle failed',
  icon: 'question',
  tone: 'neutral',
};

/** Returns whether a deployment failed or has a route conflict. */
export function isProblem(cell: Cell): boolean {
  return cell.state === 'ERROR' || Boolean(cell.routeConflicts?.length);
}

/** Returns the status of a deployment; without a state it may still load. */
function deploymentStatus(cell: Cell, loading: boolean): StatusInfo {
  if (cell.state === 'ERROR') return failed;
  if (cell.routeConflicts?.length) return conflict;
  if (cell.state === 'READY') return ready;
  if (cell.state === 'PROGRESSING') return deploying;
  return loading
    ? { label: 'Checking status', icon: 'clock', tone: 'neutral' }
    : unchecked;
}

/** Returns how a deployment compares with the local bundle of its name. */
function localStatus(cell: Cell, loading: boolean): StatusInfo {
  if (cell.drift) return differs;
  if (cell.drift === false) return matches;
  return loading
    ? {
        label: 'Comparing with the local bundle',
        icon: 'clock',
        tone: 'neutral',
      }
    : incomparable;
}

/** Renders a status icon, colored by tone. */
export function statusIcon(status: Pick<StatusInfo, 'icon' | 'tone'>) {
  return html`<vscode-icon
    name=${status.icon}
    class="tone-${status.tone}"
  ></vscode-icon>`;
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
  const rows = snapshot.rows.filter(row => {
    const cell = row.cells[environment];
    // A failed comparison is a difference that is not known yet
    const unknown = row.local && cell?.drift === undefined && !snapshot.loading;
    return (
      row.name.toLowerCase().includes(query) &&
      (!view.onlyProblems ||
        Boolean(cell && (isProblem(cell) || cell.drift || unknown)))
    );
  });
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
        <label class="checkbox">
          <input
            type="checkbox"
            .checked=${view.onlyProblems}
            @change=${(event: Event) =>
              actions.setView({
                onlyProblems: (event.target as HTMLInputElement).checked,
              })}
          />
          Only problems and differences
        </label>
        <span class="count" aria-live="polite" aria-atomic="true">
          ${rows.length} of ${snapshot.rows.length} shown
        </span>
      </div>
      <section class="card">
        ${
          environment
            ? table(snapshot, rows, environment, actions)
            : html`<p class="muted">
                This organization has no environments yet.
              </p>`
        }
      </section>
      ${problemList(snapshot.rows, environment)}
    </div>
  `;
}

/** The deployments of one environment, grouped into proxies and shared flows. */
function table(
  snapshot: Loaded,
  rows: Row[],
  environment: string,
  actions: Actions,
) {
  return html`
    <div class="table-scroll">
      <table class="deployments">
        <caption class="sr-only">
          Deployments in ${environment}
        </caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col" class="icon-cell">Status</th>
            <th scope="col" class="revision">Revision</th>
            <th scope="col" class="icon-cell">Local bundle</th>
            <th scope="col"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        ${groups.map(([kind, label]) => {
          const members = rows.filter(row => row.kind === kind);
          if (!members.length) return nothing;
          return html`
            <tbody>
              <tr class="group">
                <th scope="colgroup" colspan="5">${label}</th>
              </tr>
              ${members.map(row =>
                deploymentRow(snapshot, row, environment, actions),
              )}
            </tbody>
          `;
        })}
        ${
          rows.length
            ? nothing
            : html`
                <tbody>
                  <tr>
                    <td class="empty" colspan="5">
                      ${
                        snapshot.rows.length
                          ? 'No proxies or shared flows match the filter.'
                          : 'This organization has no API proxies or shared flows yet.'
                      }
                    </td>
                  </tr>
                </tbody>
              `
        }
      </table>
    </div>
    <ul class="legend" aria-label="Legend">
      ${[ready, conflict, failed, deploying, unchecked].map(
        status => html`<li>${statusIcon(status)}${status.label}</li>`,
      )}
      <li><span aria-hidden="true">—</span>Not deployed</li>
      ${[matches, differs, incomparable].map(
        status => html`<li>${statusIcon(status)}${status.label}</li>`,
      )}
    </ul>
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
  const status = cell && deploymentStatus(cell, snapshot.loading);
  const local = cell && row.local && localStatus(cell, snapshot.loading);
  const tooltip = cell && [status!.label, ...details(cell)].join('\n');
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
      <td class="icon-cell" title=${tooltip || 'Not deployed'}>
        ${
          status
            ? html`${statusIcon(status)}<span class="sr-only">${tooltip}</span>`
            : html`<span class="muted" aria-hidden="true">—</span
                ><span class="sr-only">Not deployed</span>`
        }
      </td>
      <td class="revision">${cell ? cell.revision : nothing}</td>
      <td class="icon-cell" title=${local ? local.label : nothing}>
        ${
          local
            ? html`${statusIcon(local)}<span class="sr-only"
                  >${local.label}</span
                >`
            : nothing
        }
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

/** Failed deployments and route conflicts with their full messages. */
function problemList(rows: Row[], environment: string) {
  const problems = rows.flatMap(row => {
    const cell = row.cells[environment];
    return cell && isProblem(cell) ? [{ row, cell }] : [];
  });
  if (!problems.length) return nothing;
  return html`
    <section class="card">
      <div class="card-head"><h2>Problems</h2></div>
      <ul class="problems">
        ${problems.map(({ row, cell }) => {
          const status = deploymentStatus(cell, false);
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
