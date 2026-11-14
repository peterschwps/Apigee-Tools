// The Overview tab: key figures, the environments, and the bundles in the
// workspace.
import { html, nothing } from 'lit';
import type { LocalBundle, Overview, Row } from '../protocol';
import {
  isProblem,
  kindLabels,
  statusIcon,
  type Actions,
  type Loaded,
} from './deployments';

export function overview(snapshot: Loaded, actions: Actions) {
  const { overview: organization, rows } = snapshot;
  const cells = rows.flatMap(row => Object.values(row.cells));
  const problems = cells.filter(isProblem).length;
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
              problems ? statusIcon({ icon: 'error', tone: 'error' }) : nothing
            }${problems}
          </dd>
        </div>
      </dl>
      <div class="cards">
        ${environmentsCard(organization)}
        ${workspace(snapshot.bundles ?? [], rows, actions)}
      </div>
    </div>
  `;
}

/** The bundles in the workspace with lint findings and differences. */
export function workspace(
  bundles: LocalBundle[] | undefined,
  rows: Row[] | undefined,
  actions: Actions,
) {
  // Bundles that share a name cannot be matched to a deployment
  const shared = (bundle: LocalBundle) =>
    (bundles ?? []).filter(
      other => other.kind === bundle.kind && other.name === bundle.name,
    ).length > 1;
  if (!bundles) {
    return html`
      <section class="card">
        <div class="card-head"><h2>Workspace</h2></div>
        <p class="muted" role="status">Scanning the workspace…</p>
      </section>
    `;
  }
  return html`
    <section class="card">
      <div class="card-head"><h2>Workspace</h2></div>
      ${
        bundles.length
          ? html`
              <ul class="list">
                ${bundles.map(bundle => {
                  const row = rows?.find(
                    item =>
                      item.kind === bundle.kind && item.name === bundle.name,
                  );
                  const drifted = Object.entries(row?.cells ?? {})
                    .filter(([, cell]) => cell.drift)
                    .map(([environment]) => environment);
                  return html`
                    <li>
                      <div class="item-head">
                        <button
                          class="link item-name"
                          @click=${() =>
                            actions.send({
                              type: 'openBundle',
                              path: bundle.path,
                            })}
                        >
                          ${bundle.name}
                        </button>
                        <vscode-badge>${kindLabels[bundle.kind]}</vscode-badge>
                      </div>
                      <div class="path">${bundle.path}</div>
                      <div class="findings">
                        ${findings(bundle)}
                        ${
                          shared(bundle)
                            ? html`<span class="finding"
                                >${statusIcon({ icon: 'info', tone: 'neutral' })}
                                Name used by several bundles, not compared</span
                              >`
                            : nothing
                        }
                        ${
                          drifted.length
                            ? html`<span class="finding"
                                >${statusIcon({ icon: 'warning', tone: 'warning' })}
                                Differs from ${drifted.join(', ')}</span
                              >`
                            : nothing
                        }
                      </div>
                    </li>
                  `;
                })}
              </ul>
            `
          : html`<p class="muted">
              No proxy or shared flow bundles in this workspace.
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

/** The lint findings of a bundle, or a note that there are none. */
function findings(bundle: LocalBundle) {
  if (!bundle.linted) {
    return html`<span class="finding muted"
      >Not linted: turned off by apigeeTools.enabled</span
    >`;
  }
  if (!bundle.errors && !bundle.warnings) {
    return html`<span class="finding"
      >${statusIcon({ icon: 'pass', tone: 'success' })}No lint findings</span
    >`;
  }
  return html`
    ${
      bundle.errors
        ? html`<span class="finding"
            >${statusIcon({ icon: 'error', tone: 'error' })}
            ${count(bundle.errors, 'error')}</span
          >`
        : nothing
    }
    ${
      bundle.warnings
        ? html`<span class="finding"
            >${statusIcon({ icon: 'warning', tone: 'warning' })}
            ${count(bundle.warnings, 'warning')}</span
          >`
        : nothing
    }
  `;
}

/** Returns a readable label for an enum value such as `INTERMEDIATE`. */
function valueLabel(value?: string): string {
  if (!value) return '—';
  return value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ');
}

function count(amount: number, noun: string): string {
  return `${amount} ${noun}${amount === 1 ? '' : 's'}`;
}
