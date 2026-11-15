// The Apigee Tools dashboard. It renders the snapshots the extension sends and
// reports the user's actions back; it never calls an API itself.
import '@vscode-elements/elements/dist/vscode-badge/index.js';
import '@vscode-elements/elements/dist/vscode-button/index.js';
import '@vscode-elements/elements/dist/vscode-icon/index.js';
import '@vscode-elements/elements/dist/vscode-label/index.js';
import '@vscode-elements/elements/dist/vscode-option/index.js';
import '@vscode-elements/elements/dist/vscode-progress-ring/index.js';
import '@vscode-elements/elements/dist/vscode-single-select/index.js';
import '@vscode-elements/elements/dist/vscode-tab-header/index.js';
import '@vscode-elements/elements/dist/vscode-tab-panel/index.js';
import '@vscode-elements/elements/dist/vscode-tabs/index.js';
import '@vscode-elements/elements/dist/vscode-textfield/index.js';
import type { VscodeSingleSelect } from '@vscode-elements/elements/dist/vscode-single-select/index.js';
import { html, LitElement, nothing, type TemplateResult } from 'lit';
import type {
  HostMessage,
  Problem,
  Snapshot,
  WebviewMessage,
} from '../protocol';
import {
  deployments,
  signs,
  type Actions,
  type DeploymentView,
  type Loaded,
} from './deployments';
import { details } from './details';
import { overview } from './overview';
import { styles } from './styles';
import { tooltips } from './tooltip';

/** The view state that survives reloads of the webview. */
type ViewState = DeploymentView & {
  tab: number;
  /** Notes closed by the user, hidden until the dashboard closes. */
  dismissed: string[];
};

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewMessage): void;
  getState(): Partial<ViewState> | undefined;
  setState(state: ViewState): void;
};

const vscode = acquireVsCodeApi();
const send = (message: WebviewMessage) => vscode.postMessage(message);
const installUrl = 'https://cloud.google.com/sdk/docs/install';

// Set when a button that starts loading will disappear, taking the focus along
let refocus = false;

const reducedMotion = () =>
  matchMedia('(prefers-reduced-motion: reduce)').matches ||
  document.body.classList.contains('vscode-reduce-motion');

/**
 * vscode-tabs selects only on Enter; Space selects the focused tab too, instead
 * of scrolling. On the outer tabs, it also serves the tabs nested in a panel.
 */
const selectWithSpace = (event: KeyboardEvent) => {
  const header = event.target as HTMLElement;
  if (event.key !== ' ' || header.localName !== 'vscode-tab-header') return;
  event.preventDefault();
  header.click();
};

/** vscode-button clicks on Space but leaves the page to scroll as well. */
const keepScroll = (event: KeyboardEvent) => {
  if (event.key === ' ') event.preventDefault();
};

class ApigeeDashboard extends LitElement {
  static override properties = {
    snapshot: { state: true },
    view: { state: true },
  };

  static override styles = styles;

  // Declared rather than initialized as fields, so that Lit's accessors stay intact
  declare snapshot: Snapshot | undefined;
  declare view: ViewState;

  /** Hides the tooltip once a render removed its element. */
  private syncTooltip = () => {};

  /** The element to focus after the next render, as a selector. */
  private focusNext?: string;

  private readonly actions: Actions = {
    send,
    setView: patch => this.setView(patch),
    openDetails: row => {
      this.setView({ tab: 1, kind: row.kind, detail: row.name });
      send({ type: 'details', kind: row.kind, name: row.name });
    },
  };

  /** Hides a note; keyboard focus moves on to Refresh. */
  private dismiss(text: string): void {
    this.focusNext = '.refresh';
    // ponytail: keeps the last 20 texts, plenty for the notes of a load
    this.setView({ dismissed: [...this.view.dismissed, text].slice(-20) });
  }

  /** Changes the view and keeps it for a reload of the webview. */
  private setView(patch: Partial<ViewState>): void {
    // Keyboard focus moves into the details, and back to the row they show
    if (patch.detail !== undefined && patch.detail !== this.view.detail) {
      this.focusNext = patch.detail
        ? '.back'
        : `[data-name="${CSS.escape(`${this.view.kind}/${this.view.detail}`)}"]`;
    }
    this.view = { ...this.view, ...patch };
    vscode.setState(this.view);
  }

  constructor() {
    super();
    this.snapshot = undefined;
    this.view = {
      tab: 0,
      environment: '',
      kind: 'apis',
      filter: '',
      status: '',
      comparison: '',
      sort: 'asc',
      detail: '',
      dismissed: [],
      ...vscode.getState(),
    };
    window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
      if (event.data?.type === 'snapshot') this.snapshot = event.data.snapshot;
    });
    // A held-down key repeats clicks on buttons; one refresh is enough
    this.addEventListener(
      'keydown',
      event => {
        const target = event.composedPath()[0] as Element;
        if (
          event.repeat &&
          (target.localName === 'vscode-button' ||
            target.classList.contains('refresh'))
        ) {
          event.stopPropagation();
          event.preventDefault();
        }
      },
      true,
    );
    send({ type: 'ready' });
  }

  /** Sets up the tooltips once the shadow root exists. */
  protected override firstUpdated(): void {
    this.syncTooltip = tooltips(this, () =>
      this.renderRoot.querySelector('.tooltip'),
    );
  }

  /**
   * Moves the focus into or out of the details, and to Refresh once a notice
   * with the focused button is gone.
   */
  protected override async updated(): Promise<void> {
    this.syncTooltip();
    if (this.focusNext) {
      const selector = this.focusNext;
      this.focusNext = undefined;
      // Nested tabs show their panels only after updates of their own
      await new Promise(requestAnimationFrame);
      this.renderRoot.querySelector<HTMLElement>(selector)?.focus();
    }
    if (!refocus) return;
    const refresh = this.renderRoot.querySelector<HTMLElement>('.refresh');
    if (!refresh) return;
    refocus = false;
    refresh.focus();
  }

  override render() {
    const snapshot = this.snapshot;
    return html`
      ${this.header(snapshot)}
      ${snapshot ? this.body(snapshot) : progress('Starting…')}
      <div class="tooltip" aria-hidden="true" hidden></div>
    `;
  }

  /** The view with an environment of this organization, by default the first. */
  private effectiveView(snapshot: Snapshot): ViewState {
    const environments = snapshot.overview?.environments ?? [];
    return environments.some(({ name }) => name === this.view.environment)
      ? this.view
      : { ...this.view, environment: environments[0]?.name ?? '' };
  }

  private header(snapshot?: Snapshot) {
    const view = snapshot ? this.effectiveView(snapshot) : this.view;
    return html`
      <header class="topbar">
        <div class="brand">
          <h1>Dashboard</h1>
        </div>
        <div class="context">
          ${
            snapshot?.trusted && snapshot.organizations.length
              ? html`
                  <div class="field">
                    <vscode-label for="organization">
                      <span class="field-label">Organization</span>
                    </vscode-label>
                    <vscode-single-select
                      id="organization"
                      @change=${(event: Event) => {
                        // Details belong to the organization they came from
                        this.view = { ...this.view, detail: '' };
                        vscode.setState(this.view);
                        send({
                          type: 'organization',
                          name: (event.target as VscodeSingleSelect).value,
                        });
                      }}
                    >
                      ${snapshot.organizations.map(
                        name => html`
                          <vscode-option
                            value=${name}
                            ?selected=${name === snapshot.organization}
                            >${name}</vscode-option
                          >
                        `,
                      )}
                    </vscode-single-select>
                  </div>
                  <div class="field">
                    <vscode-label for="environment">
                      <span class="field-label">Environment</span>
                    </vscode-label>
                    <vscode-single-select
                      id="environment"
                      @change=${(event: Event) =>
                        this.actions.setView({
                          environment: (event.target as VscodeSingleSelect)
                            .value,
                        })}
                    >
                      ${(snapshot.overview?.environments ?? []).map(
                        ({ name }) => html`
                          <vscode-option
                            value=${name}
                            ?selected=${name === view.environment}
                            >${name}</vscode-option
                          >
                        `,
                      )}
                    </vscode-single-select>
                  </div>
                `
              : nothing
          }
        </div>
        <div class="session">
          ${
            snapshot?.account
              ? html`<span
                  class="account"
                  data-tooltip=${`Signed in with gcloud as ${snapshot.account}`}
                  ><vscode-icon name="account"></vscode-icon
                  ><span class="address">${snapshot.account}</span></span
                >`
              : nothing
          }
          ${
            snapshot?.trusted && snapshot.requested
              ? html`
                  <button
                    class="icon-button refresh"
                    data-tooltip=${snapshot.loading ? 'Refreshing…' : 'Refresh'}
                    aria-label=${snapshot.loading ? 'Refreshing…' : 'Refresh'}
                    @click=${() => send({ type: 'refresh' })}
                  >
                    <vscode-icon
                      name="refresh"
                      ?spin=${snapshot.loading && !reducedMotion()}
                    ></vscode-icon>
                  </button>
                `
              : nothing
          }
        </div>
      </header>
    `;
  }

  private body(snapshot: Snapshot) {
    if (!snapshot.trusted) {
      return html`
        <div class="messages">
          ${notice(
            'warning',
            'workspace-untrusted',
            'Restricted Mode',
            'The dashboard runs gcloud and reads from the Apigee API, which needs a trusted workspace. Linting keeps working in Restricted Mode.',
            button('Manage Workspace Trust', { type: 'trust' }),
          )}
        </div>
      `;
    }
    if (!snapshot.requested) {
      return html`
        <div class="messages">
          ${notice(
            'info',
            'info',
            'Not loaded yet',
            'The dashboard reads from the Apigee API only when you ask for it.',
            button('Load data', { type: 'refresh' }),
          )}
        </div>
      `;
    }
    const { overview: organization, rows } = snapshot;
    const messages = [
      snapshot.problem ? problemNotice(snapshot.problem) : undefined,
      ...(snapshot.notes ?? [])
        .filter(note => !this.view.dismissed.includes(note.text))
        .map(note =>
          notice(
            note.tone,
            note.tone === 'warning' ? signs.warning.icon : 'info',
            '',
            note.text,
            undefined,
            () => this.dismiss(note.text),
          ),
        ),
    ].filter(Boolean);
    return html`
      ${messages.length ? html`<div class="messages">${messages}</div>` : nothing}
      ${
        organization && rows
          ? this.tabs({ ...snapshot, overview: organization, rows })
          : snapshot.loading
            ? progress('Loading from the Apigee API…')
            : nothing
      }
    `;
  }

  private tabs(snapshot: Loaded) {
    return html`
      <vscode-tabs
        selected-index=${this.view.tab}
        @vsc-tabs-select=${(event: CustomEvent<{ selectedIndex: number }>) => {
          this.view = { ...this.view, tab: event.detail.selectedIndex };
          vscode.setState(this.view);
        }}
        @keydown=${selectWithSpace}
      >
        <vscode-tab-header slot="header">
          <span class="tab-label">Overview</span>
        </vscode-tab-header>
        <vscode-tab-header slot="header">
          <span class="tab-label">Deployments</span>
        </vscode-tab-header>
        <vscode-tab-panel>${overview(snapshot, this.actions)}</vscode-tab-panel>
        <vscode-tab-panel>${this.deploymentsTab(snapshot)}</vscode-tab-panel>
      </vscode-tabs>
    `;
  }

  /** The table of the Deployments tab, or the details of one of its rows. */
  private deploymentsTab(snapshot: Loaded) {
    const view = this.effectiveView(snapshot);
    const row = snapshot.rows.find(
      item => item.kind === view.kind && item.name === view.detail,
    );
    return row
      ? details(snapshot, row, this.actions)
      : deployments(snapshot, view, this.actions);
  }
}

/** A notice with a colored edge and icon; its text keeps the theme color. */
function notice(
  tone: 'error' | 'warning' | 'info',
  icon: string,
  title: string,
  text?: string,
  actions?: TemplateResult,
  close?: () => void,
) {
  return html`
    <div class="notice ${tone}" role=${tone === 'error' ? 'alert' : 'status'}>
      <vscode-icon name=${icon}></vscode-icon>
      ${title ? html`<strong>${title}</strong>` : nothing}
      ${text ? html`<p>${text}</p>` : nothing}
      ${actions ? html`<div class="actions">${actions}</div>` : nothing}
      ${
        close
          ? html`<button
              class="icon-button close"
              data-tooltip="Dismiss"
              aria-label="Dismiss"
              @click=${close}
            >
              <vscode-icon name="close"></vscode-icon>
            </button>`
          : nothing
      }
    </div>
  `;
}

/** A problem with the actions that help with its reason. */
function problemNotice(problem: Problem) {
  const retry = button('Try again', { type: 'refresh' }, true);
  const actions = {
    gcloudMissing: html`
      <a href=${installUrl}>Install the Google Cloud CLI</a>
      <button class="link" @click=${() => send({ type: 'settings' })}>
        Set the gcloud path
      </button>
      ${retry}
    `,
    signedOut: html`${button('Sign in with gcloud', { type: 'signIn' })}${retry}`,
    noOrganization: retry,
    api: retry,
  }[problem.reason];
  return notice('error', 'error', problem.message, problem.hint, actions);
}

function button(label: string, message: WebviewMessage, secondary = false) {
  return html`
    <vscode-button
      ?secondary=${secondary}
      @click=${() => {
        // The notice with this button disappears when loading starts
        refocus = message.type === 'refresh';
        send(message);
      }}
      @keydown=${keepScroll}
      >${label}</vscode-button
    >
  `;
}

function progress(text: string) {
  return html`
    <div class="loading" role="status">
      <vscode-progress-ring></vscode-progress-ring>${text}
    </div>
  `;
}

customElements.define('apigee-dashboard', ApigeeDashboard);
