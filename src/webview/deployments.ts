// The Deployments tab: proxies and shared flows by environment, with their
// deployment status, differences from local bundles, and problems.
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

/** How a status shows: never by color alone, always with an icon and a label. */
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

const legend: StatusInfo[] = [
  { label: 'Ready', icon: 'pass-filled', tone: 'success' },
  { label: 'Route conflict', icon: 'warning', tone: 'warning' },
  { label: 'Failed', icon: 'error', tone: 'error' },
  { label: 'Deploying', icon: 'sync', tone: 'neutral' },
  { label: 'Status not checked yet', icon: 'clock', tone: 'neutral' },
];

/** Returns whether a deployment failed or has a route conflict. */
export function isProblem(cell: Cell): boolean {
  return cell.state === 'ERROR' || Boolean(cell.routeConflicts?.length);
}

/** Returns the status of a deployment; without a state it may still load. */
function deploymentStatus(cell: Cell, loading: boolean): StatusInfo {
  if (cell.state === 'ERROR') {
    return { label: 'Failed', icon: 'error', tone: 'error' };
  }
  if (cell.routeConflicts?.length) {
    return { label: 'Route conflict', icon: 'warning', tone: 'warning' };
  }
  if (cell.state === 'READY') {
    return { label: 'Ready', icon: 'pass-filled', tone: 'success' };
  }
  if (cell.state === 'PROGRESSING') {
    return { label: 'Deploying', icon: 'sync', tone: 'neutral' };
  }
  return loading
    ? { label: 'Checking status', icon: 'clock', tone: 'neutral' }
    : { label: 'Status not checked', icon: 'clock', tone: 'neutral' };
}

/** Renders a status icon, colored by tone; the label goes next to it. */
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
  const environments = snapshot.overview.environments
    .map(environment => environment.name)
    .filter(name => view.environment === 'all' || name === view.environment);
  const query = view.filter.trim().toLowerCase();
  const rows = snapshot.rows.filter(
    row =>
      row.name.toLowerCase().includes(query) &&
      (!view.onlyProblems ||
        environments.some(environment => {
          const cell = row.cells[environment];
          return cell && (isProblem(cell) || cell.drift);
        })),
  );
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
        ${matrix(snapshot, rows, environments, actions)}
      </section>
      ${problemList(snapshot.rows, environments)}
    </div>
  `;
}

/** The deployment matrix with one column per environment. */
function matrix(
  snapshot: Loaded,
  rows: Row[],
  environments: string[],
  actions: Actions,
) {
  return html`
    <div class="table-scroll">
      <table>
        <caption class="sr-only">
          Deployments by environment
        </caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            ${environments.map(
              environment => html`<th scope="col">${environment}</th>`,
            )}
          </tr>
        </thead>
        <tbody>
          ${rows.map(
            row => html`
              <tr>
                <th scope="row">
                  <span class="name">
                    <a
                      href=${consoleUrl(snapshot.overview.projectId, row)}
                      title="Open in the Apigee console"
                      >${row.name}<span class="sr-only">
                        (opens the Apigee console)</span
                      ></a
                    >
                    <vscode-badge>${kindLabels[row.kind]}</vscode-badge>
                    ${
                      row.local
                        ? html`<vscode-badge
                            title="A bundle of this name is in the workspace"
                            >local</vscode-badge
                          >`
                        : nothing
                    }
                  </span>
                </th>
                ${environments.map(environment =>
                  statusCell(row, environment, snapshot.loading, actions),
                )}
              </tr>
            `,
          )}
          ${
            rows.length
              ? nothing
              : html`
                  <tr>
                    <td class="empty" colspan=${environments.length + 1}>
                      ${
                        snapshot.rows.length
                          ? 'No proxies or shared flows match the filter.'
                          : 'This organization has no API proxies or shared flows yet.'
                      }
                    </td>
                  </tr>
                `
          }
        </tbody>
      </table>
    </div>
    <ul class="legend" aria-label="Legend">
      ${legend.map(status => html`<li>${statusIcon(status)}${status.label}</li>`)}
      <li>
        <vscode-badge class="drift" aria-hidden="true">≠ local</vscode-badge>
        Differs from the local bundle
      </li>
      <li>
        <vscode-badge aria-hidden="true">local ?</vscode-badge>
        Comparison failed
      </li>
      <li><span aria-hidden="true">—</span>Not deployed</li>
    </ul>
  `;
}

/** One cell: status icon and label, revision, difference, and comparison. */
function statusCell(
  row: Row,
  environment: string,
  loading: boolean,
  actions: Actions,
) {
  const cell = row.cells[environment];
  if (!cell) {
    return html`
      <td>
        <span class="status">
          <span class="muted" aria-hidden="true">—</span>
          <span class="sr-only">Not deployed</span>
        </span>
      </td>
    `;
  }
  const status = deploymentStatus(cell, loading);
  const messages = details(cell);
  const unknownDrift = row.local && cell.drift === undefined && !loading;
  return html`
    <td title=${messages.join('\n') || nothing}>
      <span class="status">
        ${statusIcon(status)}
        <span>${status.label}</span>
        <span class="muted">rev ${cell.revision}</span>
        ${
          cell.drift
            ? html`<vscode-badge class="drift" aria-hidden="true"
                  >≠ local</vscode-badge
                ><span class="sr-only">differs from the local bundle</span>`
            : nothing
        }
        ${
          unknownDrift
            ? html`<vscode-badge
                  aria-hidden="true"
                  title="The comparison with the local bundle failed"
                  >local ?</vscode-badge
                ><span class="sr-only"
                  >comparison with the local bundle failed</span
                >`
            : nothing
        }
        ${
          row.local
            ? html`<vscode-icon
                action-icon
                name="git-compare"
                title="Compare with local"
                label=${`Compare revision ${cell.revision} in ${environment} with the local bundle`}
                @vsc-click=${() =>
                  actions.send({
                    type: 'compare',
                    kind: row.kind,
                    name: row.name,
                    environment,
                  })}
              ></vscode-icon>`
            : nothing
        }
      </span>
    </td>
  `;
}

/** Failed deployments and route conflicts with their full messages. */
function problemList(rows: Row[], environments: string[]) {
  const problems = rows.flatMap(row =>
    environments.flatMap(environment => {
      const cell = row.cells[environment];
      return cell && isProblem(cell) ? [{ row, environment, cell }] : [];
    }),
  );
  if (!problems.length) return nothing;
  return html`
    <section class="card">
      <div class="card-head"><h2>Problems</h2></div>
      <ul class="problems">
        ${problems.map(({ row, environment, cell }) => {
          const status = deploymentStatus(cell, false);
          return html`
            <li>
              ${statusIcon(status)}
              <span>
                <strong>${row.name}</strong> in ${environment}, revision
                ${cell.revision}: ${status.label}
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
