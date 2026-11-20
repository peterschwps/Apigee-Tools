// The details of one proxy or shared flow: its deployments in every
// environment, their errors and warnings in full, and its bundle in the
// workspace.
import { html, nothing } from 'lit';
import type { Cell, LocalBundle, Row } from '../protocol';
import {
  comparisons,
  consoleUrl,
  isProblem,
  kindLabels,
  messagesOf,
  none,
  revisionCell,
  statusCell,
  statuses,
  statusIcon,
  statusOf,
  workspaceCell,
  type Actions,
  type Loaded,
} from './deployments';

const proxyTypes = { STANDARD: 'Standard', EXTENSIBLE: 'Extensible' };

const relativeTime = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

// Units of relative times in milliseconds, largest first
const units: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86_400_000],
  ['month', 30 * 86_400_000],
  ['week', 7 * 86_400_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
  ['second', 1_000],
];

export function details(snapshot: Loaded, row: Row, actions: Actions) {
  const deployments = snapshot.overview.environments.map(
    ({ name }) => [name, row.cells[name]] as const,
  );
  const problems = deployments.flatMap(([environment, cell]) =>
    cell && isProblem(cell) ? [[environment, cell] as const] : [],
  );
  const bundles = snapshot.bundles?.filter(
    bundle => bundle.kind === row.kind && bundle.name === row.name,
  );
  const proxy = row.kind === 'apis';
  const type = proxy ? proxyType(row) : undefined;
  return html`
    <div class="page">
      <header class="details-head">
        <button
          class="icon-button labeled back"
          @click=${() => actions.setView({ detail: '' })}
        >
          <vscode-icon name="chevron-left"></vscode-icon>Deployments
        </button>
        <div class="details-title">
          <h2>${row.name}</h2>
          <div class="details-actions">
            <button
              class="icon-button"
              data-tooltip="Show Flow"
              aria-label="Show Flow"
              @click=${() => actions.openFlow(row)}
            >
              <vscode-icon name="open-preview"></vscode-icon>
            </button>
            <button
              class="icon-button"
              data-tooltip="Show in Relationships"
              aria-label="Show in Relationships"
              @click=${() =>
                actions.openRelationships(`${row.kind}:${row.name}`)}
            >
              <vscode-icon name="type-hierarchy"></vscode-icon>
            </button>
            <a
              class="icon-button"
              href=${consoleUrl(snapshot.overview.projectId, row)}
              data-tooltip="Open in the Apigee console"
              aria-label="Open in the Apigee console"
              ><vscode-icon name="link-external"></vscode-icon
            ></a>
            ${
              bundles?.length === 1
                ? html`<button
                    class="icon-button"
                    data-tooltip="Open the local bundle"
                    aria-label="Open the local bundle"
                    @click=${() =>
                      actions.send({
                        type: 'openBundle',
                        path: bundles[0].path,
                      })}
                  >
                    <vscode-icon name="go-to-file"></vscode-icon>
                  </button>`
                : nothing
            }
          </div>
        </div>
        <p class="muted">
          ${kindLabels[row.kind]}${
            type
              ? html` ·
                  <span
                    data-tooltip="The proxy type sets the price of a call under pay-as-you-go"
                    >${type}</span
                  >`
              : nothing
          }
        </p>
        ${local(bundles)}
      </header>
      <section class="card">
        <div class="card-head"><h3>Deployments</h3></div>
        <div class="table-scroll">
          <table class="deployments">
            <thead>
              <tr>
                <th scope="col">Environment</th>
                <th scope="col" class="icon-cell">Status</th>
                <th scope="col" class="revision">Revision</th>
                <th scope="col" class="fit">Deployed</th>
                ${proxy ? html`<th scope="col" class="fit">Base Path</th>` : nothing}
                <th scope="col" class="icon-cell">Workspace</th>
              </tr>
            </thead>
            <tbody>
              ${deployments.map(
                ([environment, cell]) => html`
                  <tr>
                    <th scope="row">${environment}</th>
                    ${statusCell(snapshot, cell)} ${revisionCell(cell)}
                    ${deployedCell(cell)}
                    ${
                      proxy
                        ? html`<td class="fit">
                            ${
                              cell?.basePaths?.length
                                ? cell.basePaths.join(', ')
                                : none()
                            }
                          </td>`
                        : nothing
                    }
                    ${workspaceCell(snapshot, row, environment, actions)}
                  </tr>
                `,
              )}
            </tbody>
          </table>
        </div>
      </section>
      ${problems.length ? messages(problems) : nothing}
    </div>
  `;
}

/** The paths of the bundles of this name in the workspace. */
function local(bundles: LocalBundle[] | undefined) {
  if (!bundles) return html`<p class="muted">Scanning the workspace…</p>`;
  if (!bundles.length) return html`<p class="muted">Not in this workspace</p>`;
  return html`
    ${bundles.map(bundle => html`<p class="path">${bundle.path}</p>`)}
    ${
      bundles.length > 1
        ? html`<div class="finding">
            ${statusIcon(comparisons.unknown)} Name used by several bundles, not
            compared
          </div>`
        : nothing
    }
  `;
}

/** When a deployment started, as a relative time with the exact one on hover. */
function deployedCell(cell: Cell | undefined) {
  if (!cell?.deployedAt) return html`<td class="fit">${none()}</td>`;
  const exact = new Date(cell.deployedAt).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return html`<td class="fit" data-tooltip=${exact}>
    ${ago(cell.deployedAt)}
  </td>`;
}

/** Returns how long ago a time was, such as "2 days ago". */
function ago(time: number): string {
  const elapsed = time - Date.now();
  const [unit, size] =
    units.find(([, size]) => Math.abs(elapsed) >= size) ?? units.at(-1)!;
  return relativeTime.format(Math.round(elapsed / size), unit);
}

/** The proxy type of the deployments, per environment where they differ. */
function proxyType(row: Row): string | undefined {
  const types = Object.entries(row.cells).flatMap(([environment, cell]) =>
    cell.proxyType ? [[environment, proxyTypes[cell.proxyType]] as const] : [],
  );
  if (new Set(types.map(([, type]) => type)).size <= 1) return types[0]?.[1];
  return types
    .map(([environment, type]) => `${type} in ${environment}`)
    .join(', ');
}

/** The errors and warnings of the deployments, in full. */
function messages(problems: (readonly [string, Cell])[]) {
  return html`
    <section class="card">
      <div class="card-head"><h3>Errors and Warnings</h3></div>
      <ul class="problems">
        ${problems.map(([environment, cell]) => {
          const status = statuses[statusOf(cell)];
          return html`
            <li>
              ${statusIcon(status)}
              <span>
                <strong>${environment}</strong> · Revision ${cell.revision}<span
                  class="sr-only"
                  >: ${status.label}</span
                >
              </span>
              ${messagesOf(cell).map(
                message => html`<span class="detail">${message}</span>`,
              )}
            </li>
          `;
        })}
      </ul>
    </section>
  `;
}
