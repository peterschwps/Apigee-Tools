// The Overview tab: key figures, the organization, its environments and
// environment groups, and the bundles in the workspace.
import { html, nothing } from 'lit';
import type { LocalBundle, Overview, Row } from '../protocol';
import {
  isProblem,
  kindLabels,
  statusIcon,
  type Actions,
  type Loaded,
} from './deployments';

// Readable names of the API's enum values; others show capitalized
const valueLabels: Readonly<Record<string, string>> = {
  CLOUD: 'Google-managed',
  HYBRID: 'Hybrid',
  PAYG: 'Pay-as-you-go',
};

export function overview(snapshot: Loaded, actions: Actions) {
  const { overview: organization, rows } = snapshot;
  const cells = rows.flatMap(row => Object.values(row.cells));
  const problems = cells.filter(isProblem).length;
  return html`
    <div class="page">
      <dl class="kpis">
        ${kpi('Environments', organization.environments.length)}
        ${kpi('API proxies', rows.filter(row => row.kind === 'apis').length)}
        ${kpi(
          'Shared flows',
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
        ${organizationCard(organization)} ${environmentsCard(organization)}
        ${groupsCard(organization)}
        ${workspace(snapshot.bundles ?? [], rows, actions)}
      </div>
    </div>
  `;
}

/** The bundles in the workspace with lint findings and differences. */
export function workspace(
  bundles: LocalBundle[],
  rows: Row[] | undefined,
  actions: Actions,
) {
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

function organizationCard(organization: Overview) {
  return html`
    <section class="card">
      <div class="card-head"><h2>Organization</h2></div>
      <dl class="facts">
        <dt>Name</dt>
        <dd>${organization.name}</dd>
        <dt>Project</dt>
        <dd>${organization.projectId}</dd>
        <dt>Runtime</dt>
        <dd>${valueLabel(organization.runtimeType)}</dd>
        <dt>Billing</dt>
        <dd>${valueLabel(organization.billingType)}</dd>
        ${
          organization.state && organization.state !== 'ACTIVE'
            ? html`<dt>State</dt>
                <dd>${valueLabel(organization.state)}</dd>`
            : nothing
        }
        <dt>Add-ons</dt>
        <dd>
          ${
            organization.addons.length
              ? html`<ul class="chips">
                  ${organization.addons.map(
                    addon =>
                      html`<li><vscode-badge>${addon}</vscode-badge></li>`,
                  )}
                </ul>`
              : html`<span class="muted">None</span>`
          }
        </dd>
      </dl>
    </section>
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

function groupsCard(organization: Overview) {
  return html`
    <section class="card">
      <div class="card-head"><h2>Environment groups</h2></div>
      ${
        organization.groups.length
          ? html`
              <ul class="list">
                ${organization.groups.map(
                  group => html`
                    <li>
                      <div class="item-head">
                        <span class="item-name">${group.name}</span>
                        <ul class="chips" aria-label="Environments">
                          ${group.environments.map(
                            environment =>
                              html`<li>
                                <vscode-badge>${environment}</vscode-badge>
                              </li>`,
                          )}
                        </ul>
                      </div>
                      <ul class="hosts" aria-label="Hostnames">
                        ${group.hostnames.map(hostname => html`<li>${hostname}</li>`)}
                      </ul>
                    </li>
                  `,
                )}
              </ul>
            `
          : html`<p class="muted">No environment groups yet.</p>`
      }
    </section>
  `;
}

/** The lint findings of a bundle, or a note that there are none. */
function findings(bundle: LocalBundle) {
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
  return (
    valueLabels[value] ??
    value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ')
  );
}

function count(amount: number, noun: string): string {
  return `${amount} ${noun}${amount === 1 ? '' : 's'}`;
}
