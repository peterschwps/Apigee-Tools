// The flow view: per proxy endpoint, a map of its stations above a list of
// everything that runs, in the order Apigee runs it. The list is a tree for
// keyboards and screen readers, with rows like VS Code's own trees; the map
// jumps to a station, and the view marks the station in sight.
import { html, nothing, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import type {
  FlowBand,
  FlowCase,
  FlowHookPoint,
  FlowItem,
  FlowMap,
  FlowSign,
  FlowStep,
  FlowView,
} from '../protocol';
import { named } from '../protocol';
import { kindLabels, signs, statusIcon } from './deployments';
import { hookNames } from './relationships';

/** How the flow view reports what the user does. */
export type FlowActions = {
  /**
   * Opens a place of the model, or of a flow hook's shared flow, beside the
   * view; the row that opened it stays marked.
   */
  open(at: number, hook: FlowHookPoint | undefined, row: string): void;
  /** Collapses or expands a part of the flow. */
  toggle(key: string): void;
  /** Follows another route rule of a proxy endpoint. */
  route(endpoint: number, route: number): void;
  /** Remembers the focused row of a list or station of a map, its tab stop. */
  rove(group: string, key: string): void;
  /** Shows a station: opens it and its band, then scrolls and focuses it. */
  go(station: string, band: string): void;
};

/** What the user changed in the view, kept across rebuilds. */
export type FlowState = {
  /** The focused row of each list and station of each map, by its group. */
  roving: Readonly<Record<string, string>>;
  /** The parts that the user collapsed; everything else shows expanded. */
  collapsed: ReadonlySet<string>;
  /** The row whose file was opened last. */
  selected: string;
};

const bandTitles: Readonly<Record<FlowBand['kind'], string>> = {
  request: 'Request',
  backend: 'Backend',
  response: 'Response',
  event: 'Per Event',
  error: 'On Error',
  after: 'After the Response',
  steps: 'Steps',
};

const bandIcons: Readonly<Record<FlowBand['kind'], string>> = {
  request: 'arrow-right',
  backend: 'server',
  response: 'arrow-left',
  event: 'pulse',
  error: 'error',
  after: 'history',
  steps: 'list-flat',
};

const roleTitles = {
  proxy: 'Proxy Endpoint',
  target: 'Target Endpoint',
  shared: 'Shared Flow',
} as const;

/** The subtitle under the bundle's name. */
export function flowSubtitle(view: FlowView): TemplateResult {
  return html`<p class="muted flow-path">
    ${[kindLabels[view.kind], view.path].filter(Boolean).join(' · ')}
  </p>`;
}

/** The key that folds a band. */
const bandKey = (map: FlowMap, band: FlowBand) =>
  `${map.key}/${band.kind}#band`;

/**
 * The stations that can collapse: what Collapse All folds, so that the list
 * shows the stations of each band.
 */
export function stationKeys(view: FlowView): string[] {
  return view.maps.flatMap(map =>
    map.bands.flatMap(band =>
      band.items.flatMap(item =>
        item.kind === 'hook' ||
        item.kind === 'routes' ||
        (item.kind === 'endpoint' && item.segments.length)
          ? [item.key]
          : [],
      ),
    ),
  );
}

/** The maps of a bundle: per proxy endpoint, a map and a list. */
export function flowMaps(
  view: FlowView,
  state: FlowState,
  actions: FlowActions,
): TemplateResult {
  return html`<div class="flow-maps">
    ${view.maps.map(
      map => html`
        <section class="flow-map">
          <h2>${map.title}</h2>
          ${overview(map, state, actions)} ${tree(map, state, actions)}
        </section>
      `,
    )}
  </div>`;
}

/* The map: a row per band with content, stations in run order */

type Chip = {
  key: string;
  band: string;
  label: string;
  tip: string;
  icon?: string;
  sign?: FlowSign;
  empty?: boolean;
};

/** The strongest sign of an item and everything in it; disabled is no sign. */
function worst(value: unknown): FlowSign | undefined {
  const found = new Set<FlowSign>();
  const stack = [value];
  while (stack.length) {
    const next = stack.pop();
    if (Array.isArray(next)) stack.push(...next);
    else if (next && typeof next === 'object') {
      const sign = (next as { sign?: FlowSign }).sign;
      if (sign) found.add(sign);
      stack.push(...Object.values(next));
    }
  }
  return (['error', 'differs', 'warning', 'unknown'] as const).find(sign =>
    found.has(sign),
  );
}

function chipOf(map: FlowMap, band: FlowBand, item: FlowItem): Chip {
  const base = { key: item.key, band: bandKey(map, band), sign: worst(item) };
  switch (item.kind) {
    case 'client':
      return {
        ...base,
        label: 'Client',
        tip: ['Client', item.basePath].filter(Boolean).join(' · '),
      };
    case 'hook':
      return {
        ...base,
        label: hookNames[item.point],
        icon: 'plug',
        tip: `${hookNames[item.point]} Flow Hook · ${item.sharedFlow}${item.steps?.length ? '' : '\nNo steps'}`,
        empty: !item.steps?.length,
      };
    case 'endpoint':
      return {
        ...base,
        label: named(item.role === 'proxy' ? 'Proxy' : 'Target', item.name),
        tip: `${named(roleTitles[item.role], item.name)}${item.segments.length ? '' : '\nNo steps'}`,
        empty: !item.segments.length,
      };
    case 'routes': {
      const followed = item.cases.find(entry => entry.followed);
      return {
        ...base,
        label: 'Routes',
        tip: [
          'Route Rules',
          followed && `${followed.name} → ${followed.destination}`,
        ]
          .filter(Boolean)
          .join('\n'),
      };
    }
    case 'backend':
      return {
        ...base,
        label: 'Backend',
        tip: ['Backend', item.text, ...item.facts].join('\n'),
      };
  }
}

/** The columns of the map, so that the response sits under the request. */
const columns: readonly ((item: FlowItem) => boolean)[] = [
  item => item.kind === 'client',
  item =>
    item.kind === 'hook' &&
    (item.point === 'PreProxyFlowHook' || item.point === 'PostProxyFlowHook'),
  item => item.kind === 'endpoint' && item.role === 'proxy',
  item => item.kind === 'routes',
  item =>
    item.kind === 'hook' &&
    (item.point === 'PreTargetFlowHook' || item.point === 'PostTargetFlowHook'),
  item => item.kind === 'endpoint' && item.role === 'target',
];

/**
 * The map of a proxy endpoint. A shared flow has none: its one station needs
 * no overview.
 */
function overview(
  map: FlowMap,
  state: FlowState,
  actions: FlowActions,
): TemplateResult | typeof nothing {
  const request = map.bands.find(band => band.kind === 'request');
  if (!request) return nothing;
  const backend = map.bands.find(band => band.kind === 'backend');
  const rows = map.bands.filter(band => band.kind !== 'backend');
  const used = columns
    .map((_, index) => index)
    .filter(index => rows.some(band => band.items.some(columns[index])));

  // Where the request turns: the backend, or a route without a target
  const routes = request.items.find(item => item.kind === 'routes');
  const followed =
    routes?.kind === 'routes'
      ? routes.cases.find(entry => entry.followed)
      : undefined;
  const turn: Chip | undefined = backend?.items[0]
    ? chipOf(map, backend, backend.items[0])
    : routes && followed
      ? {
          key: routes.key,
          band: bandKey(map, request),
          label: 'No Target',
          tip: [
            `${followed.name} → ${followed.destination}`,
            ...followed.facts,
          ].join('\n'),
          empty: true,
          ...(followed.sign === 'error' && { sign: 'error' as const }),
        }
      : undefined;

  const group = `${map.key}#map`;
  const chips = rows.flatMap(band =>
    band.items.map(item => chipOf(map, band, item)),
  );
  if (turn) chips.push(turn);
  const entry = chips.some(chip => chip.key === state.roving[group])
    ? state.roving[group]
    : chips[0]?.key;

  const chip = (value: Chip, band: string, row: number, column: number) =>
    html`<button
      class="chip ${value.empty ? 'empty' : ''}"
      data-go=${value.key}
      data-band=${band}
      data-row=${row}
      data-column=${column}
      tabindex=${value.key === entry ? 0 : -1}
      data-tooltip=${value.tip}
      @click=${() => actions.go(value.key, value.band)}
    >
      ${
        value.icon
          ? html`<vscode-icon
              name=${value.icon}
              class="chip-icon"
            ></vscode-icon>`
          : nothing
      }
      <span class="chip-name">${value.label}</span>${signView(value.sign)}<span
        class="sr-only"
        >. ${value.tip.replaceAll('\n', '. ')}</span
      >
    </button>`;

  // Classes place the cells, since the page allows no inline styles
  const turnRows = rows.filter(
    band => band.kind === 'request' || band.kind === 'response',
  ).length;
  return html`<nav class="overview" aria-label="Overview of ${map.title}">
    <div
      class="stations"
      role="toolbar"
      aria-label="Stations"
      @keydown=${moveInMap}
      @focusin=${(event: FocusEvent) => {
        const key = (event.target as HTMLElement).dataset.go;
        if (key) actions.rove(group, key);
      }}
    >
      <svg class="links" aria-hidden="true"></svg>
      ${rows.map(
        (band, row) => html`
          <span
            class="row-mark r${row + 1} c1"
            data-tooltip=${bandTitles[band.kind]}
            ><vscode-icon name=${bandIcons[band.kind]}></vscode-icon
            ><span class="sr-only">${bandTitles[band.kind]}</span></span
          >
          ${used.map((index, column) => {
            const item = band.items.find(columns[index]);
            return item
              ? html`<span class="slot r${row + 1} c${column + 2}"
                  >${chip(chipOf(map, band, item), band.kind, row, column)}</span
                >`
              : nothing;
          })}
        `,
      )}
      ${
        turn
          ? html`<span class="turn c${used.length + 2} span${turnRows}"
              >${chip(turn, 'turn', 0, used.length)}</span
            >`
          : nothing
      }
    </div>
  </nav>`;
}

/**
 * Draws the connections of each map between its stations, with an arrow
 * halfway that points the way the message travels: to the right in the
 * request, back to the left in the response. The map's layout places the
 * stations, so the lines follow it after each render and resize.
 */
export function drawLinks(root: ParentNode): void {
  for (const bar of root.querySelectorAll<HTMLElement>('.stations')) {
    const svg = bar.querySelector('svg.links');
    if (!svg) continue;
    const origin = bar.getBoundingClientRect();
    const turn = bar.querySelector<HTMLElement>('[data-band="turn"]');
    const paths: string[] = [];
    for (const [kind, way] of [
      ['request', 1],
      ['response', -1],
    ] as const) {
      const stations = [
        ...bar.querySelectorAll<HTMLElement>(`[data-band="${kind}"]`),
      ];
      if (!stations.length) continue;
      const first = stations[0].getBoundingClientRect();
      const y = first.top + first.height / 2 - origin.top;
      const boxes = [...stations, ...(turn ? [turn] : [])].map(element =>
        element.getBoundingClientRect(),
      );
      boxes.slice(1).forEach((next, index) => {
        const from = boxes[index].right - origin.left;
        const to = next.left - origin.left;
        if (to - from < 4) return;
        paths.push(
          `<path class="link" d="M${from.toFixed(1)} ${y.toFixed(1)}H${to.toFixed(1)}"/>`,
        );
        if (to - from < 14) return;
        const mid = (from + to) / 2;
        const tail = mid - 3 * way;
        const tip = mid + 3 * way;
        paths.push(
          `<path class="arrow" d="M${tail.toFixed(1)} ${(y - 4).toFixed(1)}L${tip.toFixed(1)} ${y.toFixed(1)}L${tail.toFixed(1)} ${(y + 4).toFixed(1)}Z"/>`,
        );
      });
    }
    svg.innerHTML = paths.join('');
  }
}

/**
 * Moves the focus within the map: left and right along a row, up and down to
 * the station of the next row nearest in its column, Home and End to the
 * ends.
 */
function moveInMap(event: KeyboardEvent): void {
  const bar = event.currentTarget as HTMLElement;
  const chips = [...bar.querySelectorAll<HTMLElement>('[data-go]')];
  const current = event.target as HTMLElement;
  const index = chips.indexOf(current);
  if (index < 0) return;
  const row = Number(current.dataset.row);
  const column = Number(current.dataset.column);
  const inRow = (value: number) =>
    chips.filter(chip => Number(chip.dataset.row) === value);
  const nearest = (value: number) =>
    inRow(value).sort(
      (a, b) =>
        Math.abs(Number(a.dataset.column) - column) -
        Math.abs(Number(b.dataset.column) - column),
    )[0];
  const rows = [...new Set(chips.map(chip => Number(chip.dataset.row)))];
  let next: HTMLElement | undefined;
  switch (event.key) {
    case 'ArrowRight':
      next = inRow(row).find(chip => Number(chip.dataset.column) > column);
      break;
    case 'ArrowLeft':
      next = inRow(row)
        .reverse()
        .find(chip => Number(chip.dataset.column) < column);
      break;
    case 'ArrowDown':
      next = nearest(rows[rows.indexOf(row) + 1]);
      break;
    case 'ArrowUp':
      next = nearest(rows[rows.indexOf(row) - 1]);
      break;
    case 'Home':
      next = chips[0];
      break;
    case 'End':
      next = chips.at(-1);
      break;
    default:
      return;
  }
  event.preventDefault();
  next?.focus();
}

/* The list: one row per band, station, part, case, and step */

type Row = {
  key: string;
  level: number;
  kind: 'band' | 'station' | 'part' | 'step' | 'note';
  /** Absent for rows that cannot collapse. */
  expanded?: boolean;
  content: TemplateResult;
  tip?: string;
  activate?: () => void;
  /** The shape on the line: stations of a band hang on one line. */
  marker?: 'circle' | 'diamond' | 'square';
  rail?: 'first' | 'middle' | 'last' | 'through';
  /** A route rule that the view follows. */
  current?: boolean;
  /**
   * Where a row sits in a first-match group, which draws its alternatives as
   * branches of a decision: the head of each case, or a step under one.
   */
  branch?: 'first' | 'middle' | 'last' | 'only' | 'through' | 'end';
};

function tree(
  map: FlowMap,
  state: FlowState,
  actions: FlowActions,
): TemplateResult {
  const rows = rowsOf(map, state, actions);
  const group = `${map.key}#list`;
  const focusable = rows.filter(row => row.kind !== 'note');
  const entry = focusable.some(row => row.key === state.roving[group])
    ? state.roving[group]
    : focusable[0]?.key;
  return html`<div
    class="tree"
    role="tree"
    aria-label=${map.title}
    @keydown=${(event: KeyboardEvent) => moveInTree(event, actions)}
    @focusin=${(event: FocusEvent) => {
      const key = (event.target as HTMLElement).dataset.key;
      if (key) actions.rove(group, key);
    }}
  >
    ${repeat(
      rows,
      row => row.key,
      row => rowView(row, entry, state, actions),
    )}
  </div>`;
}

function rowView(
  row: Row,
  entry: string | undefined,
  state: FlowState,
  actions: FlowActions,
): TemplateResult {
  const classes = [
    'row',
    row.kind,
    `level-${row.level}`,
    row.marker && `mark-${row.marker}`,
    row.rail && `rail-${row.rail}`,
    row.branch && 'in-branch',
    row.activate && 'active',
  ]
    .filter(Boolean)
    .join(' ');
  if (row.kind === 'note') {
    return html`<div class=${classes} role="none">${row.content}</div>`;
  }
  return html`<div
    class=${classes}
    role="treeitem"
    data-key=${row.key}
    data-station=${row.kind === 'station' ? row.key : nothing}
    aria-level=${row.level}
    aria-expanded=${row.expanded === undefined ? nothing : String(row.expanded)}
    aria-selected=${row.key === state.selected ? 'true' : nothing}
    aria-current=${row.current ? 'true' : nothing}
    tabindex=${row.key === entry ? 0 : -1}
    data-tooltip=${row.tip ?? nothing}
    @click=${row.activate ?? nothing}
  >
    ${
      row.branch
        ? html`<span class="branch ${row.branch}" aria-hidden="true"
            >${
              row.branch === 'first' || row.branch === 'only'
                ? html`<span class="fork"></span>`
                : nothing
            }</span
          >`
        : nothing
    }
    ${
      row.expanded === undefined
        ? html`<span class="twisty"></span>`
        : html`<span
            class="twisty"
            aria-hidden="true"
            @click=${(event: Event) => {
              event.stopPropagation();
              actions.toggle(row.key);
            }}
            ><vscode-icon
              name=${row.expanded ? 'chevron-down' : 'chevron-right'}
            ></vscode-icon
          ></span>`
    }
    ${row.content}
  </div>`;
}

/** Lists the rows of a map in run order; collapsed parts leave theirs out. */
function rowsOf(map: FlowMap, state: FlowState, actions: FlowActions): Row[] {
  const rows: Row[] = [];
  const open = (key: string) => !state.collapsed.has(key);
  const toggle = (key: string) => () => actions.toggle(key);
  const note = (text: string, level: number) =>
    rows.push({
      key: `#note${rows.length}`,
      level,
      kind: 'note',
      content: html`<span class="fact">${text}</span>`,
    });

  const steps = (
    list: readonly FlowStep[],
    level: number,
    hook?: FlowHookPoint,
    branch?: Row['branch'],
  ) => {
    for (const step of list) {
      const tip = [
        step.name,
        step.type,
        step.condition && `If ${step.condition}`,
        ...step.facts,
      ]
        .filter(Boolean)
        .join('\n');
      rows.push({
        key: step.key,
        level,
        kind: 'step',
        tip,
        ...(branch && { branch }),
        activate: () => actions.open(step.at, hook, step.key),
        content: html`<span class="step-box"
          ><span
            class="pill ${step.condition ? 'conditional' : ''} ${step.muted ? 'muted' : ''}"
            >${signView(step.sign)}<span class="pill-name">${step.name}</span>${
              step.type ? html`<span class="type">${step.type}</span>` : nothing
            }</span
          >${
            step.condition
              ? html`<span class="condition" aria-hidden="true"
                  >if ${step.condition}</span
                >`
              : nothing
          }${
            step.condition || step.facts.length
              ? html`<span class="sr-only"
                  >.
                  ${[step.condition && `If ${step.condition}`, ...step.facts].filter(Boolean).join('. ')}</span
                >`
              : nothing
          }</span
        >`,
      });
    }
  };

  // A first-match group: its cases branch off a decision, one runs
  const cases = (
    list: readonly FlowCase[],
    level: number,
    endpoint?: number,
  ) => {
    // The order matters only when there is more than one case to try
    const numbered = list.filter(item => item.number !== undefined).length > 1;
    list.forEach((item, position) => {
      const last = position === list.length - 1;
      const branch =
        list.length === 1
          ? 'only'
          : position === 0
            ? 'first'
            : last
              ? 'last'
              : 'middle';
      const follows = endpoint !== undefined && item.number !== undefined;
      const extra = [
        item.condition && item.condition !== item.summary
          ? `If ${item.condition}`
          : '',
        ...item.facts,
        follows && item.followed ? 'The view follows this route' : '',
      ].filter(Boolean);
      rows.push({
        key: item.key,
        level,
        kind: 'part',
        branch,
        ...(item.steps.length && { expanded: open(item.key) }),
        ...(follows && { current: Boolean(item.followed) }),
        tip: [item.name, item.condition, ...item.facts]
          .filter(Boolean)
          .join('\n'),
        activate: follows
          ? () => actions.route(endpoint, position)
          : item.at !== undefined
            ? () => actions.open(item.at!, undefined, item.key)
            : item.steps.length
              ? toggle(item.key)
              : undefined,
        content: html`<span
          class="label case ${item.muted ? 'muted' : ''} ${follows ? 'route' : ''}"
          >${signView(item.sign)}${
            numbered && item.number !== undefined
              ? html`<span class="number">${item.number}</span>`
              : nothing
          }<span class="case-name">${item.name}</span>${
            item.summary
              ? html`<span class="summary">${item.summary}</span>`
              : nothing
          }${
            item.destination
              ? html`<span class="destination">→ ${item.destination}</span>`
              : nothing
          }${
            extra.length
              ? html`<span class="sr-only">. ${extra.join('. ')}</span>`
              : nothing
          }</span
        >`,
      });
      if (item.steps.length && open(item.key)) {
        steps(item.steps, level + 1, undefined, last ? 'end' : 'through');
      }
    });
  };

  const station = (item: FlowItem) => {
    switch (item.kind) {
      case 'client':
        rows.push({
          key: item.key,
          level: 2,
          kind: 'station',
          marker: 'circle',
          content: html`<span class="label"
            ><span class="station-name">Client</span>${
              item.basePath
                ? html`<span class="muted">${item.basePath}</span>`
                : nothing
            }</span
          >`,
        });
        return;
      case 'hook': {
        const title = `${hookNames[item.point]} Flow Hook`;
        rows.push({
          key: item.key,
          level: 2,
          kind: 'station',
          marker: 'circle',
          expanded: open(item.key),
          activate: toggle(item.key),
          content: html`<span class="label"
            ><vscode-icon name="plug" class="hook-mark"></vscode-icon
            ><span class="station-name">${title}</span></span
          >`,
        });
        if (!open(item.key)) return;
        rows.push({
          key: `${item.key}#flow`,
          level: 3,
          kind: 'part',
          tip: [title, item.sharedFlow, ...item.facts].join('\n'),
          content: html`<span class="label"
            ><span>${item.sharedFlow}</span>${signView(item.sign)}${
              item.revision
                ? html`<span class="muted">· Revision ${item.revision}</span>`
                : nothing
            }<span class="sr-only"
              >. ${[title, ...item.facts].join('. ')}</span
            ></span
          >`,
        });
        if (item.steps?.length) steps(item.steps, 3, item.point);
        return;
      }
      case 'endpoint': {
        const name = named(roleTitles[item.role], item.name);
        const parts = item.segments.length > 0;
        rows.push({
          key: item.key,
          level: 2,
          kind: 'station',
          marker: 'circle',
          ...(parts && { expanded: open(item.key) }),
          tip: [name, ...item.facts].join('\n'),
          activate: () => actions.open(item.at, undefined, item.key),
          content: html`<span class="label"
            ><span class="station-name link">${name}</span
            >${signView(item.sign)}${
              parts ? nothing : html`<span class="muted">no steps</span>`
            }${
              item.facts.length
                ? html`<span class="sr-only">. ${item.facts.join('. ')}</span>`
                : nothing
            }</span
          >`,
        });
        if (!parts || !open(item.key)) return;
        item.segments.forEach((segment, index) => {
          // Steps are keyed by their place under the endpoint, parts apart
          const key = `${item.key}#${index}`;
          rows.push({
            key,
            level: 3,
            kind: 'part',
            expanded: open(key),
            activate: toggle(key),
            content: html`<span class="label segment-label"
              >${segment.label}${
                'cases' in segment && segment.label === 'Flows'
                  ? html`<span class="muted">· the first match runs</span>`
                  : nothing
              }${
                segment.facts.length
                  ? html`<span class="sr-only"
                      >. ${segment.facts.join(' ')}</span
                    >`
                  : nothing
              }</span
            >`,
          });
          if (!open(key)) return;
          for (const fact of segment.facts) note(fact, 4);
          if ('cases' in segment) cases(segment.cases, 4);
          else steps(segment.steps, 4);
        });
        return;
      }
      case 'routes':
        rows.push({
          key: item.key,
          level: 2,
          kind: 'station',
          marker: 'diamond',
          expanded: open(item.key),
          activate: toggle(item.key),
          tip: ['Route Rules', ...item.facts].join('\n'),
          content: html`<span class="label"
            ><span class="station-name">Route Rules</span
            ><span class="muted">· the first match runs</span>${signView(
              item.sign,
            )}${
              item.facts.length
                ? html`<span class="sr-only">. ${item.facts.join('. ')}</span>`
                : nothing
            }</span
          >`,
        });
        if (!open(item.key)) return;
        for (const fact of item.facts) note(fact, 3);
        cases(item.cases, 3, item.endpoint);
        return;
      case 'backend':
        rows.push({
          key: item.key,
          level: 2,
          kind: 'station',
          marker: 'square',
          tip: ['Backend', item.text, ...item.facts].join('\n'),
          ...(item.at !== undefined && {
            activate: () => actions.open(item.at!, undefined, item.key),
          }),
          content: html`<span class="label"
            ><span class="station-name ${item.at === undefined ? '' : 'link'}"
              >${item.text}</span
            >${signView(item.sign)}${
              item.facts.length
                ? html`<span class="sr-only">. ${item.facts.join('. ')}</span>`
                : nothing
            }</span
          >`,
        });
        return;
    }
  };

  for (const band of map.bands) {
    const key = bandKey(map, band);
    const expanded = open(key);
    rows.push({
      key,
      level: 1,
      kind: 'band',
      expanded,
      activate: toggle(key),
      content: html`<span class="label band-title"
        ><vscode-icon name=${bandIcons[band.kind]}></vscode-icon
        >${bandTitles[band.kind]}${
          band.facts.length
            ? html`<span class="sr-only">. ${band.facts.join(' ')}</span>`
            : nothing
        }</span
      >`,
    });
    if (!expanded) continue;
    for (const fact of band.facts) note(fact, 2);
    const start = rows.length;
    band.items.forEach(station);
    // The stations of a band hang on one line, from the first to the last
    const marks = rows
      .map((row, index) =>
        index >= start && row.kind === 'station' ? index : -1,
      )
      .filter(index => index >= 0);
    if (marks.length > 1) {
      const first = marks[0];
      const last = marks.at(-1)!;
      for (let index = first; index <= last; index++) {
        rows[index].rail =
          index === first
            ? 'first'
            : index === last
              ? 'last'
              : rows[index].kind === 'station'
                ? 'middle'
                : 'through';
      }
    }
  }
  return rows;
}

function signView(sign: FlowSign | undefined) {
  return sign ? statusIcon(signs[sign]) : nothing;
}

/**
 * Moves through the list like VS Code's trees: up and down by row, right
 * opens a part or enters it, left closes it or goes to its parent, Home and
 * End to the ends, Enter and Space do what a click does.
 */
function moveInTree(event: KeyboardEvent, actions: FlowActions): void {
  const tree = event.currentTarget as HTMLElement;
  const rows = [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')];
  const current = event.target as HTMLElement;
  const index = rows.indexOf(current);
  if (index < 0) return;
  const level = Number(current.getAttribute('aria-level'));
  const expanded = current.getAttribute('aria-expanded');
  const key = current.dataset.key ?? '';
  let next: HTMLElement | undefined;
  switch (event.key) {
    case 'ArrowDown':
      next = rows[index + 1];
      break;
    case 'ArrowUp':
      next = rows[index - 1];
      break;
    case 'Home':
      next = rows[0];
      break;
    case 'End':
      next = rows.at(-1);
      break;
    case 'ArrowRight':
      if (expanded === 'false') actions.toggle(key);
      else if (expanded === 'true') next = rows[index + 1];
      break;
    case 'ArrowLeft':
      if (expanded === 'true') actions.toggle(key);
      else {
        next = rows
          .slice(0, index)
          .reverse()
          .find(row => Number(row.getAttribute('aria-level')) < level);
      }
      break;
    case 'Enter':
    case ' ':
      current.click();
      break;
    default:
      return;
  }
  event.preventDefault();
  next?.focus();
}
