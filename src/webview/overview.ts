// The Overview tab: key figures and the failed deployments and warnings.
import { html, nothing } from 'lit';
import type { Cell, Row } from '../protocol';
import {
  isProblem,
  messagesOf,
  signs,
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
              problems.length ? statusIcon(signs.error) : nothing
            }${problems.length}
          </dd>
        </div>
      </dl>
      ${problemsCard(problems, snapshot.loading, actions)}
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
