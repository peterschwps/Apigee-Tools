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
import { keyed } from 'lit/directives/keyed.js';
import type {
  FlowView,
  HostMessage,
  Problem,
  Relationships,
  Snapshot,
  WebviewMessage,
} from '../protocol';
import {
  comparisons,
  deployments,
  signs,
  statuses,
  statusIcon,
  statusOf,
  type Actions,
  type DeploymentView,
  type Loaded,
} from './deployments';
import { details } from './details';
import { flowMaps, flowSubtitle, stationKeys, type FlowActions } from './flow';
import type { Column } from './graph';
import { overview } from './overview';
import { relationshipsTab, type RelationshipActions } from './relationships';
import { styles } from './styles';
import { tooltips } from './tooltip';

/** The view state that survives reloads of the webview. */
type ViewState = DeploymentView & {
  tab: number;
  /** Notes closed by the user, hidden until the dashboard closes. */
  dismissed: string[];
  /** The node chosen in the Relationships tab, or empty. */
  node: string;
  /** The node whose chain stays shown in the Relationships tab, or empty. */
  pinned: string;
};

// The index of the Relationships tab
const relationshipsIndex = 2;

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

/** A held-down key repeats clicks on buttons; one refresh is enough. */
function ignoreRepeats(element: HTMLElement): void {
  element.addEventListener(
    'keydown',
    event => {
      const target = event.composedPath()[0] as Element;
      if (
        event.repeat &&
        (target.localName === 'vscode-button' ||
          target.classList.contains('refresh') ||
          target.classList.contains('load'))
      ) {
        event.stopPropagation();
        event.preventDefault();
      }
    },
    true,
  );
}

/** vscode-button clicks on Space but leaves the page to scroll as well. */
const keepScroll = (event: KeyboardEvent) => {
  if (event.key === ' ') event.preventDefault();
};

class ApigeeDashboard extends LitElement {
  static override properties = {
    snapshot: { state: true },
    view: { state: true },
    relationships: { state: true },
    query: { state: true },
    missingKey: { state: true },
    roving: { state: true },
  };

  static override styles = styles;

  // Declared rather than initialized as fields, so that Lit's accessors stay intact
  declare snapshot: Snapshot | undefined;
  declare view: ViewState;
  declare relationships: Relationships | undefined;
  // The search of the Relationships tab is never kept: it may hold an API key
  declare query: string;
  declare missingKey: boolean;
  declare roving: Partial<Record<Column, string>>;

  /** Whether the Relationships tab asked the host for its data. */
  private relationshipsRequested = false;

  /** Hides the tooltip once a render removed its element. */
  private syncTooltip = () => {};

  /** Whether a load has finished; Refresh shows only from then on. */
  private loaded = false;

  /** The element to focus after the next render, as a selector. */
  private focusNext?: string;

  private readonly actions: Actions = {
    send,
    setView: patch => this.setView(patch),
    openDetails: row => {
      this.setView({ tab: 1, kind: row.kind, detail: row.name });
      send({ type: 'details', kind: row.kind, name: row.name });
    },
    // Shows the chain of the node, even where another one was pinned
    openRelationships: node =>
      this.setView({ tab: relationshipsIndex, node, pinned: '' }),
    // The flow opens in the environment chosen at the top, if deployed there
    openFlow: row => {
      if (!this.snapshot) return;
      send({
        type: 'showFlow',
        kind: row.kind,
        name: row.name,
        environment: this.effectiveView(this.snapshot).environment,
      });
    },
  };

  private readonly relationshipActions: RelationshipActions = {
    select: node => this.setView({ node }),
    setQuery: query => {
      this.query = query;
      this.missingKey = false;
    },
    findKey: key => send({ type: 'findKey', key }),
    copyKey: (app, key) => send({ type: 'copyKey', app, key }),
    rove: (column, node) => {
      if (this.roving[column] !== node) {
        this.roving = { ...this.roving, [column]: node };
      }
    },
    openDetails: row => this.actions.openDetails(row),
    // Pinning chooses the node too; releasing the pin keeps the choice, and
    // the focus on it, or else on the node that was pinned
    pin: node => {
      if (!node) {
        const kept = this.view.node || this.view.pinned;
        if (kept) this.focusNext = `[data-id="${CSS.escape(kept)}"]`;
      }
      this.setView(node ? { pinned: node, node } : { pinned: '' });
    },
    showAll: () => {
      this.query = '';
      this.missingKey = false;
      // Focus stays in the graph: on the chosen node, or else the pinned one
      if (!this.view.node && this.view.pinned) {
        this.focusNext = `[data-id="${CSS.escape(this.view.pinned)}"]`;
      }
      this.setView({ node: '', pinned: '' });
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
    // Moving to another tab moves the focus, even to the same details or node
    const moved = patch.tab !== undefined && patch.tab !== this.view.tab;
    // Keyboard focus moves into the details, and back to the row they show
    if (
      patch.detail !== undefined &&
      (moved || patch.detail !== this.view.detail)
    ) {
      this.focusNext = patch.detail
        ? '.back'
        : `[data-name="${CSS.escape(`${this.view.kind}/${this.view.detail}`)}"]`;
    }
    // A chosen node keeps the focus, and so does the last one when cleared
    if (patch.node !== undefined && (moved || patch.node !== this.view.node)) {
      const node = patch.node || this.view.node;
      this.focusNext = `[data-id="${CSS.escape(node)}"]`;
    }
    this.view = { ...this.view, ...patch };
    vscode.setState(this.view);
  }

  constructor() {
    super();
    this.snapshot = undefined;
    this.relationships = undefined;
    this.query = '';
    this.missingKey = false;
    this.roving = {};
    const saved = vscode.getState();
    this.view = {
      tab: 0,
      environment: '',
      kind: 'apis',
      filter: '',
      sort: 'asc',
      detail: '',
      dismissed: [],
      ...saved,
      // Dashboards saved before filters took several states kept one or ''
      status: Array.isArray(saved?.status) ? saved.status : [],
      comparison: Array.isArray(saved?.comparison) ? saved.comparison : [],
      node: typeof saved?.node === 'string' ? saved.node : '',
      pinned: typeof saved?.pinned === 'string' ? saved.pinned : '',
    };
    window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
      const message = event.data;
      if (message?.type === 'relationships') {
        this.relationships = message.relationships;
      } else if (message?.type === 'pin') {
        // Pin or Unpin, chosen in the context menu of a node
        this.relationshipActions.pin(message.node);
      } else if (message?.type === 'keyOwner') {
        // The app with the key; its details list the key
        if (message.found) {
          this.query = '';
          this.setView({ node: `apps:${message.found.app}` });
        } else {
          this.missingKey = true;
        }
      } else if (message?.type === 'snapshot') {
        const snapshot = message.snapshot;
        // The first snapshot arrives before loading starts, without data yet
        this.loaded ||=
          !snapshot.loading && Boolean(snapshot.overview || snapshot.problem);
        this.snapshot = snapshot;
      }
    });
    ignoreRepeats(this);
    send({ type: 'ready' });
  }

  /** Sets up the tooltips once the shadow root exists. */
  protected override firstUpdated(): void {
    this.syncTooltip = tooltips(this, () =>
      this.renderRoot.querySelector('.tooltip'),
    );
    // VS Code builds the context menu from data-vscode-context of the element
    // that the event targets, which outside the shadow root is this one: a
    // node of the graph offers Pin and Unpin, anything else the usual menu.
    // The pinned node is always drawn, with its pin, while its pin holds.
    this.addEventListener('contextmenu', event => {
      const node = event
        .composedPath()
        .find(
          (item): item is HTMLElement =>
            item instanceof HTMLElement && item.matches('.graph [data-id]'),
        );
      const id = node?.dataset.id;
      if (id) {
        this.dataset.vscodeContext = JSON.stringify({
          webviewSection: 'node',
          node: id,
          nodePinned: Boolean(node.querySelector('.pin')),
          preventDefaultContextMenuItems: true,
        });
      } else {
        delete this.dataset.vscodeContext;
      }
    });
  }

  /**
   * Moves the focus into or out of the details, and to Refresh once a notice
   * with the focused button is gone.
   */
  protected override async updated(): Promise<void> {
    this.syncTooltip();
    // The Relationships tab loads its data once it is first shown
    if (
      !this.relationshipsRequested &&
      this.view.tab === relationshipsIndex &&
      this.snapshot?.rows
    ) {
      this.relationshipsRequested = true;
      send({ type: 'relationships' });
    }
    if (this.focusNext) {
      const selector = this.focusNext;
      this.focusNext = undefined;
      // Nested tabs show their panels only after updates of their own
      await new Promise(requestAnimationFrame);
      // A node outside a pinned chain is not drawn, so its details take the
      // focus; a graph that is still loading has no nodes yet, so its tab
      (
        this.renderRoot.querySelector<HTMLElement>(selector) ??
        this.renderRoot.querySelector<HTMLElement>('.side-head h3') ??
        this.renderRoot.querySelector<HTMLElement>('vscode-tab-header[active]')
      )?.focus();
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
                        this.view = {
                          ...this.view,
                          detail: '',
                          node: '',
                          pinned: '',
                        };
                        vscode.setState(this.view);
                        this.query = '';
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
                  ><span class="sr-only"
                    >Signed in with gcloud as ${snapshot.account}</span
                  ></span
                >`
              : nothing
          }
          ${
            snapshot?.trusted && snapshot.requested && this.loaded
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
    const { overview: organization, rows } = snapshot;
    // The notes of the Relationships tab show while it is open
    const relationshipNotes =
      this.view.tab === relationshipsIndex &&
      this.relationships &&
      this.relationships.organization === snapshot.organization
        ? this.relationships.notes
        : [];
    const messages = [
      snapshot.problem ? problemNotice(snapshot.problem) : undefined,
      ...[...(snapshot.notes ?? []), ...relationshipNotes]
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
        <vscode-tab-header slot="header">
          <span class="tab-label">Relationships</span>
        </vscode-tab-header>
        <vscode-tab-panel>${overview(snapshot, this.actions)}</vscode-tab-panel>
        <vscode-tab-panel>${this.deploymentsTab(snapshot)}</vscode-tab-panel>
        <vscode-tab-panel>
          ${
            // Tabs render every panel; this one only renders while shown
            this.view.tab === relationshipsIndex
              ? relationshipsTab(
                  snapshot,
                  this.relationships,
                  {
                    environment: this.effectiveView(snapshot).environment,
                    node: this.view.node,
                    pinned: this.view.pinned,
                    query: this.query,
                    missingKey: this.missingKey,
                    roving: this.roving,
                  },
                  this.relationshipActions,
                )
              : nothing
          }
        </vscode-tab-panel>
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

/**
 * Back or Forward in the flow view: to the bundle shown before or after,
 * disabled where there is none.
 */
function travelButton(
  way: 'back' | 'forward',
  icon: string,
  label: string,
  to: string | undefined,
) {
  const name = to ? `${label} to ${to}` : label;
  return html`<button
    class="icon-button"
    data-tooltip=${name}
    aria-label=${name}
    ?disabled=${!to}
    @click=${() => send({ type: way === 'back' ? 'flowBack' : 'flowForward' })}
  >
    <vscode-icon name=${icon}></vscode-icon>
  </button>`;
}

/** The flow view of one bundle, in a tab of the editor. */
class ApigeeFlow extends LitElement {
  static override properties = {
    flow: { state: true },
    roving: { state: true },
    collapsed: { state: true },
    selected: { state: true },
    announcement: { state: true },
  };

  static override styles = styles;

  declare flow: FlowView | undefined;
  /** The focused row of each list and station of each map, its tab stop. */
  declare roving: Record<string, string>;
  /** The parts that the user collapsed; everything else shows expanded. */
  declare collapsed: ReadonlySet<string>;
  /** The row whose file was opened last, which stays marked. */
  declare selected: string;
  /** What screen readers hear when the source changes. */
  declare announcement: string;

  /** Hides the tooltip once a render removed its element. */
  private syncTooltip = () => {};

  /** The item to focus again when a rebuild replaced the focused one. */
  private focusKey?: string;

  /** Whether environments have loaded once; Refresh shows from then on. */
  private loaded = false;

  /** What is collapsed in the bundles shown before, by kind and name. */
  private readonly folds = new Map<string, ReadonlySet<string>>();

  /** The station that the map asked to show, once it is drawn. */
  private goTo?: string;

  /** Whether marking the station in sight waits for the next frame. */
  private spyQueued = false;

  /**
   * The station chosen on the map, which stays marked until the user scrolls
   * or types, also when the list ends before it reaches the top.
   */
  private spyHold?: string;

  private readonly actions: FlowActions = {
    open: (at, hook, row) => {
      if (this.flow) {
        this.selected = row;
        send({ type: 'flowOpen', version: this.flow.version, at, hook });
      }
    },
    toggle: key => {
      const next = new Set(this.collapsed);
      if (!next.delete(key)) next.add(key);
      this.collapsed = next;
    },
    route: (endpoint, route) => {
      if (this.flow) {
        send({
          type: 'flowRoute',
          version: this.flow.version,
          endpoint,
          route,
        });
      }
    },
    hook: sharedFlow => {
      if (this.flow) {
        send({
          type: 'showFlow',
          kind: 'sharedflows',
          name: sharedFlow,
          environment: this.flow.source,
        });
      }
    },
    rove: (group, key) => {
      if (this.roving[group] !== key) {
        this.roving = { ...this.roving, [group]: key };
      }
    },
    go: (station, band) => {
      // The station opens with all its parts, and so does its band
      this.collapsed = new Set(
        [...this.collapsed].filter(
          key =>
            key !== band &&
            key !== station &&
            !key.startsWith(`${station}/`) &&
            !key.startsWith(`${station}#`),
        ),
      );
      this.goTo = station;
      this.spyHold = station;
    },
  };

  constructor() {
    super();
    this.flow = undefined;
    this.roving = {};
    this.collapsed = new Set();
    this.selected = '';
    this.announcement = '';
    // The map marks the station whose part of the list is in sight
    const queue = () => this.queueSpy();
    window.addEventListener('scroll', queue, { passive: true });
    window.addEventListener('resize', queue);
    const release = () => {
      if (!this.spyHold) return;
      this.spyHold = undefined;
      this.queueSpy();
    };
    for (const type of ['wheel', 'touchstart', 'mousedown', 'keydown']) {
      window.addEventListener(type, release, { capture: true, passive: true });
    }
    window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
      if (event.data?.type !== 'flow') return;
      const flow = event.data.flow;
      const focused = this.shadowRoot?.activeElement as HTMLElement | null;
      this.focusKey = focused?.dataset.key;
      // Screen readers hear which source shows, and how far it differs
      const before = this.flow;
      if (
        before &&
        (before.source !== flow.source || before.name !== flow.name)
      ) {
        const label = flow.sources.find(item => item.id === flow.source);
        this.announcement = [
          `Showing ${flow.name}, ${label?.label ?? 'Workspace'}.`,
          flow.changes
            ? `${flow.changes} ${flow.changes === 1 ? 'file differs' : 'files differ'} from the workspace.`
            : '',
          ...flow.notes
            .filter(note => note.tone === 'warning')
            .map(note => note.text),
        ]
          .filter(Boolean)
          .join(' ');
      }
      // Each bundle keeps what is collapsed, also when Back returns to it
      if (before && (before.kind !== flow.kind || before.name !== flow.name)) {
        this.folds.set(`${before.kind}/${before.name}`, this.collapsed);
        this.collapsed =
          this.folds.get(`${flow.kind}/${flow.name}`) ?? new Set();
        this.selected = '';
      }
      this.loaded ||= ['ready', 'undeployed', 'problem'].includes(
        flow.environments,
      );
      this.flow = flow;
    });
    ignoreRepeats(this);
    send({ type: 'ready' });
  }

  protected override firstUpdated(): void {
    this.syncTooltip = tooltips(this, () =>
      this.renderRoot.querySelector('.tooltip'),
    );
  }

  /**
   * Keeps the focus on the same item when a rebuild replaced it, or else on
   * an item of the flow; a button that started loading hands it on.
   */
  protected override updated(): void {
    this.syncTooltip();
    const key = this.focusKey;
    this.focusKey = undefined;
    if (key && !this.shadowRoot?.activeElement) {
      (
        this.renderRoot.querySelector<HTMLElement>(
          `[data-key="${CSS.escape(key)}"]`,
        ) ??
        this.renderRoot.querySelector<HTMLElement>('[data-key][tabindex="0"]')
      )?.focus();
    }
    if (refocus && !this.shadowRoot?.activeElement) {
      const next =
        this.renderRoot.querySelector<HTMLElement>('.refresh') ??
        this.renderRoot.querySelector<HTMLElement>('#source');
      if (next) {
        refocus = false;
        next.focus();
      }
    }
    // A station chosen on the map comes into sight below the map, focused
    const station = this.goTo;
    this.goTo = undefined;
    const row =
      station &&
      this.renderRoot.querySelector<HTMLElement>(
        `[data-key="${CSS.escape(station)}"]`,
      );
    if (row) {
      const map = row
        .closest('.flow-map')
        ?.querySelector<HTMLElement>('.overview');
      const top =
        row.getBoundingClientRect().top +
        window.scrollY -
        (map?.offsetHeight ?? 0) -
        8;
      window.scrollTo({ top, behavior: reducedMotion() ? 'auto' : 'smooth' });
      row.focus({ preventScroll: true });
    }
    this.spy();
  }

  private queueSpy(): void {
    if (this.spyQueued) return;
    this.spyQueued = true;
    requestAnimationFrame(() => {
      this.spyQueued = false;
      this.spy();
    });
  }

  /** Marks on each map the station whose part of the list is at its top. */
  private spy(): void {
    for (const section of this.renderRoot.querySelectorAll<HTMLElement>(
      '.flow-map',
    )) {
      const map = section.querySelector<HTMLElement>('.overview');
      if (!map) continue;
      const limit = map.getBoundingClientRect().bottom + 8;
      const stations = [
        ...section.querySelectorAll<HTMLElement>('[data-station]'),
      ];
      let current = stations.find(row => row.dataset.station === this.spyHold)
        ?.dataset.station;
      for (const row of current ? [] : stations) {
        if (current && row.getBoundingClientRect().top > limit) break;
        current = row.dataset.station;
      }
      for (const chip of map.querySelectorAll<HTMLElement>('[data-go]')) {
        if (chip.dataset.go === current) {
          chip.setAttribute('aria-current', 'location');
        } else {
          chip.removeAttribute('aria-current');
        }
      }
    }
  }

  /** Collapse All folds the stations, so the list shows them; Expand All everything. */
  private foldButton(flow: FlowView) {
    const keys = stationKeys(flow);
    if (!keys.length) return nothing;
    const folded = keys.every(key => this.collapsed.has(key));
    const label = folded ? 'Expand All' : 'Collapse All';
    return html`<button
      class="icon-button fold"
      data-tooltip=${label}
      aria-label=${label}
      @click=${() => {
        this.collapsed = folded
          ? new Set()
          : new Set([...this.collapsed, ...keys]);
      }}
    >
      <vscode-icon name=${folded ? 'expand-all' : 'collapse-all'}></vscode-icon>
    </button>`;
  }

  override render() {
    const flow = this.flow;
    if (!flow) {
      return html`${progress('Reading the bundle…')}
        <div class="tooltip" aria-hidden="true" hidden></div>`;
    }
    return html`
      <header class="topbar">
        <div class="brand flow-brand">
          <div class="history">
            ${travelButton('back', 'arrow-left', 'Back', flow.back)}
            ${travelButton('forward', 'arrow-right', 'Forward', flow.forward)}
          </div>
          <h1>${flow.name}</h1>
          ${flowSubtitle(flow)}
        </div>
        <div class="session">
          ${this.foldButton(flow)}
          ${
            this.loaded
              ? html`<button
                  class="icon-button refresh"
                  data-tooltip=${flow.loading ? 'Refreshing…' : 'Refresh'}
                  aria-label=${flow.loading ? 'Refreshing…' : 'Refresh'}
                  @click=${() => send({ type: 'refresh' })}
                >
                  <vscode-icon
                    name="refresh"
                    ?spin=${flow.loading && !reducedMotion()}
                  ></vscode-icon>
                </button>`
              : nothing
          }
        </div>
        <div class="context">${this.source(flow)}</div>
      </header>
      ${
        flow.problem || flow.notes.length
          ? html`<div class="messages">
              ${flow.problem ? problemNotice(flow.problem) : nothing}
              ${flow.notes.map(note =>
                notice(
                  note.tone,
                  note.tone === 'warning' ? signs.warning.icon : 'info',
                  '',
                  note.text,
                ),
              )}
            </div>`
          : nothing
      }
      <div class="sr-only" role="status">${this.announcement}</div>
      ${flowMaps(
        flow,
        {
          roving: this.roving,
          collapsed: this.collapsed,
          selected: this.selected,
        },
        this.actions,
      )}
      <div class="tooltip" aria-hidden="true" hidden></div>
    `;
  }

  /**
   * The source of the flow: the workspace or an environment, with the
   * deployment's status and its difference from the workspace, or what keeps
   * environments from showing.
   */
  private source(flow: FlowView) {
    const status = flow.cell && statusOf(flow.cell);
    const deployment =
      status && status !== 'unknown' ? statuses[status] : undefined;
    const changes = flow.changes;
    const differ = `${changes} ${changes === 1 ? 'file differs' : 'files differ'} from the workspace`;
    return html`
      ${
        flow.sources.length
          ? html`<div class="field">
              <vscode-label for="source">
                <span class="field-label">Source</span>
              </vscode-label>
              <div class="source">
                ${keyed(
                  flow.sources.map(item => item.label).join('\n'),
                  html`<vscode-single-select
                    id="source"
                    @change=${(event: Event) => {
                      const index = Number(
                        (event.target as VscodeSingleSelect).value,
                      );
                      const chosen = flow.sources[index];
                      if (chosen)
                        send({ type: 'flowSource', source: chosen.id });
                    }}
                  >
                    ${flow.sources.map(
                      (item, index) =>
                        html`<vscode-option
                          value=${String(index)}
                          ?selected=${item.id === flow.source}
                          >${item.label}</vscode-option
                        >`,
                    )}
                  </vscode-single-select>`,
                )}
                ${
                  deployment
                    ? html`<span class="sign" data-tooltip=${deployment.label}
                        >${statusIcon(deployment)}<span class="sr-only"
                          >${deployment.label}</span
                        ></span
                      >`
                    : nothing
                }
                ${
                  changes === undefined
                    ? nothing
                    : changes
                      ? html`<button
                          class="icon-button"
                          data-tooltip=${`${differ}\nClick to compare`}
                          aria-label=${`${differ}. Compare`}
                          @click=${() =>
                            send({
                              type: 'compare',
                              kind: flow.kind,
                              name: flow.name,
                              environment: flow.source,
                            })}
                        >
                          ${statusIcon(signs.differs)}
                        </button>`
                      : html`<span
                          class="sign"
                          data-tooltip=${comparisons.matches.tooltip ?? ''}
                          >${statusIcon(comparisons.matches)}<span
                            class="sr-only"
                            >${comparisons.matches.tooltip}</span
                          ></span
                        >`
                }
              </div>
            </div>`
          : nothing
      }
      ${
        {
          ready: nothing,
          problem: nothing,
          unloaded: html`<button
            class="link load"
            @click=${() => {
              refocus = true;
              send({ type: 'refresh' });
            }}
          >
            Load Environments
          </button>`,
          loading: progress('Loading environments…'),
          untrusted: html`<p class="muted">
            Environments need a trusted workspace.
            <button class="link" @click=${() => send({ type: 'trust' })}>
              Manage Workspace Trust
            </button>
          </p>`,
          undeployed: html`<p class="muted">
            Not deployed in ${flow.organization}
          </p>`,
        }[flow.environments]
      }
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
  const pathSetting = html`
    <button class="link" @click=${() => send({ type: 'settings' })}>
      Set the gcloud path
    </button>
  `;
  const actions = {
    gcloudMissing: html`
      <a href=${installUrl}>Install the Google Cloud CLI</a>
      ${pathSetting} ${retry}
    `,
    gcloudFailed: html`${pathSetting} ${retry}`,
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
customElements.define('apigee-flow', ApigeeFlow);
