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
  type Actions,
  type DeploymentView,
  type Loaded,
} from './deployments';
import { overview, workspace } from './overview';
import { styles } from './styles';

/** The view state that survives reloads of the webview. */
type ViewState = DeploymentView & { tab: number };

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

  private readonly actions: Actions = {
    send,
    setView: patch => {
      this.view = { ...this.view, ...patch };
      vscode.setState(this.view);
    },
  };

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
        if (event.repeat && target.localName === 'vscode-button') {
          event.stopPropagation();
          event.preventDefault();
        }
      },
      true,
    );
    send({ type: 'ready' });
  }

  /** Moves focus to Refresh once a notice with the focused button is gone. */
  protected override async updated(): Promise<void> {
    if (!refocus) return;
    const refresh = this.renderRoot.querySelector<LitElement>(
      '.session vscode-button',
    );
    if (!refresh) return;
    refocus = false;
    // A new button renders its inner element first, then takes the focus
    await refresh.updateComplete;
    refresh.focus();
  }

  override render() {
    const snapshot = this.snapshot;
    return html`
      ${this.header(snapshot)}
      ${snapshot ? this.body(snapshot) : progress('Starting…')}
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
                      @change=${(event: Event) =>
                        send({
                          type: 'organization',
                          name: (event.target as VscodeSingleSelect).value,
                        })}
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
                  title=${`Signed in with gcloud as ${snapshot.account}`}
                  ><vscode-icon name="account"></vscode-icon
                  ><span class="address">${snapshot.account}</span></span
                >`
              : nothing
          }
          ${
            snapshot?.trusted && snapshot.requested
              ? html`
                  <vscode-button
                    icon="refresh"
                    ?icon-spin=${snapshot.loading && !reducedMotion()}
                    @click=${() => send({ type: 'refresh' })}
                    @keydown=${keepScroll}
                  >
                    ${snapshot.loading ? 'Refreshing…' : 'Refresh'}
                  </vscode-button>
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
        <div class="content">
          ${workspace(snapshot.bundles, undefined, this.actions)}
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
      ...(snapshot.notes ?? []).map(note => notice('info', 'info', '', note)),
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
        <vscode-tab-panel>
          ${deployments(snapshot, this.effectiveView(snapshot), this.actions)}
        </vscode-tab-panel>
      </vscode-tabs>
    `;
  }
}

/** A notice with a colored edge and icon; its text keeps the theme color. */
function notice(
  tone: 'error' | 'warning' | 'info',
  icon: string,
  title: string,
  text?: string,
  actions?: TemplateResult,
) {
  return html`
    <div class="notice ${tone}" role=${tone === 'error' ? 'alert' : 'status'}>
      <vscode-icon name=${icon}></vscode-icon>
      ${title ? html`<strong>${title}</strong>` : nothing}
      ${text ? html`<p>${text}</p>` : nothing}
      ${actions ? html`<div class="actions">${actions}</div>` : nothing}
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
