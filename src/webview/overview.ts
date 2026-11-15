// The Overview tab: key figures, the environments, and the failed
// deployments and warnings.
import { html, nothing } from 'lit';
import type { Cell, Overview, Row } from '../protocol';
import {
  isProblem,
  messagesOf,
  statuses,
  statusIcon,
  statusOf,
  type Actions,
  type Loaded,
} from './deployments';

export function overview(snapshot: Loaded, actions: Actions) {
  const { overview: organization, rows } = snapshot;
  const cells = rows.flatMap(row => Object.values(row.cells));
  const problems = rows.flatMap(row =>
    organization.environments.flatMap(({ name: environment }) => {
      const cell = row.cells[environment];
      return cell && isProblem(cell) ? [{ row, environment, cell }] : [];
    }),
  );
  return html`
    <div class="page">
      <dl class="kpis">
        ${kpi('Environments', organization.environments.length)}
        ${kpi('API Proxies', rows.filter(row => row.kind === 'apis').length)}
        ${kpi(
          'Shared Flows',
          rows.filter(row => row.kind === 'sharedflows').length,
        )}
        ${kpi('Deployments', cells.length)}
        <div class="kpi">
          <dt>Problems</dt>
          <dd>
            ${
              problems.length
                ? statusIcon({ icon: 'error', tone: 'error' })
                : nothing
            }${problems.length}
          </dd>
        </div>
      </dl>
      <div class="cards">
        ${environmentsCard(organization)}
        ${problemsCard(problems, snapshot.loading, actions)}
      </div>
    </div>
  `;
}

/** The failed deployments and warnings, with their messages in full. */
function problemsCard(
  problems: { row: Row; environment: string; cell: Cell }[],
  loading: boolean,
  actions: Actions,
) {
  return html`
    <section class="card">
      <div class="card-head"><h2>Problems</h2></div>
      ${
        problems.length
          ? html`
              <ul class="problems">
                ${problems.map(({ row, environment, cell }) => {
                  const status = statuses[statusOf(cell)];
                  return html`
                    <li>
                      ${statusIcon(status)}
                      <span>
                        <button
                          class="link item-name"
                          @click=${() => actions.openDetails(row)}
                        >
                          ${row.name}
                        </button>
                        · ${environment} · Revision ${cell.revision}<span
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
            `
          : html`<p class="muted" role="status">
              ${
                loading
                  ? 'Checking the deployments…'
                  : 'No failed deployments or warnings.'
              }
            </p>`
      }
    </section>
  `;
}

function kpi(label: string, value: number) {
  return html`
    <div class="kpi">
      <dt>${label}</dt>
      <dd>${value}</dd>
    </div>
  `;
}

function environmentsCard(organization: Overview) {
  const groupsOf = (environment: string) =>
    organization.groups
      .filter(group => group.environments.includes(environment))
      .map(group => group.name);
  return html`
    <section class="card">
      <div class="card-head"><h2>Environments</h2></div>
      ${
        organization.environments.length
          ? html`
              <ul class="list">
                ${organization.environments.map(environment => {
                  const groups = groupsOf(environment.name);
                  return html`
                    <li>
                      <div class="item-head">
                        <span class="item-name">${environment.name}</span>
                        ${
                          environment.type
                            ? html`<vscode-badge
                                >${valueLabel(environment.type)}</vscode-badge
                              >`
                            : nothing
                        }
                      </div>
                      ${
                        environment.addons?.length
                          ? html`<ul class="chips" aria-label="Add-ons">
                              ${environment.addons.map(
                                addon =>
                                  html`<li>
                                    <vscode-badge>${addon}</vscode-badge>
                                  </li>`,
                              )}
                            </ul>`
                          : nothing
                      }
                      <div class="muted">
                        ${
                          groups.length
                            ? `Groups: ${groups.join(', ')}`
                            : 'Not attached to a group'
                        }
                      </div>
                    </li>
                  `;
                })}
              </ul>
            `
          : html`<p class="muted">No environments yet.</p>`
      }
    </section>
  `;
}

/** Returns a readable label for an enum value such as `INTERMEDIATE`. */
function valueLabel(value?: string): string {
  if (!value) return '—';
  return value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ');
}
