// The flow view: one map per proxy endpoint, with bands of stages in the
// order Apigee runs them. The DOM keeps that order for keyboards and screen
// readers; only CSS lays it out as a rail or as Apigee's two bands.
import { html, nothing, type TemplateResult } from 'lit';
import type {
  FlowBand,
  FlowCase,
  FlowHookPoint,
  FlowItem,
  FlowMap,
  FlowSegment,
  FlowSign,
  FlowStep,
  FlowView,
} from '../protocol';
import { kindLabels, none, signs, statusIcon } from './deployments';
import { hookNames } from './relationships';

/** How the flow view reports what the user does. */
export type FlowActions = {
  /** Opens a place of the model, or of a flow hook's shared flow, beside. */
  open(at: number, hook?: FlowHookPoint): void;
  /** Collapses or expands a part of the flow. */
  toggle(key: string): void;
  /** Follows another route rule of a proxy endpoint. */
  route(endpoint: number, route: number): void;
  /** Shows the flow of a flow hook's shared flow in the same environment. */
  hook(sharedFlow: string): void;
  /** Remembers the focused item of a band, its tab stop. */
  rove(band: string, key: string): void;
};

const bandTitles: Readonly<Record<FlowBand['kind'], string>> = {
  request: 'Request',
  response: 'Response',
  event: 'Per Event',
  error: 'On Error',
  after: 'After the Response',
  steps: 'Steps',
  backend: 'Backend',
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

/** The maps of a bundle, each with its bands. */
export function flowMaps(
  view: FlowView,
  roving: Readonly<Record<string, string>>,
  collapsed: ReadonlySet<string>,
  actions: FlowActions,
): TemplateResult {
  const parts = { entry: undefined, collapsed, actions };
  return html`<div class="flow-maps">
    ${view.maps.map(
      map => html`
        <section class="flow-map">
          <h2>${map.title}</h2>
          ${map.bands.map(band => bandView(map, band, roving, parts))}
        </section>
      `,
    )}
  </div>`;
}

/**
 * What the parts of a band share: its tab stop, the collapsed parts, all
 * expanded at first, and the actions.
 */
type Parts = {
  entry: string | undefined;
  collapsed: ReadonlySet<string>;
  actions: FlowActions;
};

function bandView(
  map: FlowMap,
  band: FlowBand,
  roving: Readonly<Record<string, string>>,
  shared: Parts,
): TemplateResult {
  const key = `${map.key}/${band.kind}`;
  const title = bandTitles[band.kind];
  // A shared flow's card has its band's key, so the band's toggle has its own
  const fold = `${key}#band`;
  const open = !shared.collapsed.has(fold);
  // One tab stop per band: the item focused last, or else the first
  const keys = band.items.flatMap(item => keysOf(item, shared.collapsed));
  const parts = {
    ...shared,
    entry: keys.includes(roving[key]) ? roving[key] : keys[0],
  };
  const { actions } = parts;
  return html`
    <section class="band ${band.kind}">
      <h3>
        <button
          class="icon-button labeled"
          data-key=${fold}
          aria-expanded=${String(open)}
          @click=${() => actions.toggle(fold)}
        >
          ${chevron(open)}${title}
        </button>
      </h3>
      ${
        open
          ? html`${band.facts.map(fact => html`<p class="band-fact">${fact}</p>`)}
            ${stagesView(key, title, band.items, parts)}`
          : nothing
      }
    </section>
  `;
}

function stagesView(
  key: string,
  title: string,
  items: readonly FlowItem[],
  parts: Parts,
): TemplateResult {
  const { actions } = parts;
  return html`<ol
    class="stages"
    aria-label=${title}
    @keydown=${moveInBand}
    @focusin=${(event: FocusEvent) => {
      const focused = (event.target as HTMLElement).dataset.key;
      if (focused) actions.rove(key, focused);
    }}
  >
    ${items.map(
      stage =>
        html`<li class=${stageClass(stage)}>${itemView(stage, parts)}</li>`,
    )}
  </ol>`;
}

function chevron(open: boolean): TemplateResult {
  return html`<vscode-icon
    name=${open ? 'chevron-down' : 'chevron-right'}
  ></vscode-icon>`;
}

/**
 * A button in a band that collapses or expands a part, such as the steps of
 * an endpoint. Without text, it is an icon whose label names the part.
 */
function toggleView(
  key: string,
  label: string,
  parts: Parts,
  text?: string,
): TemplateResult {
  const open = !parts.collapsed.has(key);
  const toggle = `${key}#toggle`;
  return html`<button
    class="icon-button ${text ? 'labeled segment-label' : 'toggle'}"
    data-key=${toggle}
    tabindex=${toggle === parts.entry ? 0 : -1}
    aria-expanded=${String(open)}
    aria-label=${text ? nothing : label}
    @click=${() => parts.actions.toggle(key)}
  >
    ${chevron(open)}${text ?? nothing}
  </button>`;
}

/** Classes that place a stage in its column of the wide layout. */
function stageClass(item: FlowItem): string {
  if (item.kind === 'endpoint') return `stage endpoint ${item.role}`;
  if (item.kind === 'hook') {
    const proxy =
      item.point === 'PreProxyFlowHook' || item.point === 'PostProxyFlowHook';
    return `stage hook ${proxy ? 'proxy-hook' : 'target-hook'}`;
  }
  return `stage ${item.kind}`;
}

/** The keys of the focusable parts of an item, in DOM order. */
function keysOf(item: FlowItem, collapsed: ReadonlySet<string>): string[] {
  // A part with a toggle: its toggle, its head, and its content while open
  const part = (key: string, head: string[], content: () => string[]) => [
    `${key}#toggle`,
    ...head,
    ...(collapsed.has(key) ? [] : content()),
  ];
  const steps = (list: readonly FlowStep[]) => list.map(step => step.key);
  const cases = (list: readonly FlowCase[]) =>
    list.flatMap(item =>
      item.steps.length
        ? part(item.key, [item.key], () => steps(item.steps))
        : [item.key],
    );
  switch (item.kind) {
    case 'endpoint':
      if (!item.segments.length) return [item.key];
      return part(item.key, [item.key], () =>
        item.segments.flatMap((segment, index) =>
          part(`${item.key}/${index}`, [], () =>
            'cases' in segment ? cases(segment.cases) : steps(segment.steps),
          ),
        ),
      );
    case 'routes':
      return cases(item.cases);
    case 'backend':
      return item.at === undefined ? [] : [item.key];
    case 'hook':
      return item.steps?.length
        ? part(item.key, [item.key], () => steps(item.steps!))
        : [item.key];
    case 'client':
      return [];
  }
}

function itemView(item: FlowItem, parts: Parts): TemplateResult {
  const { entry, actions } = parts;
  switch (item.kind) {
    case 'client':
      return html`<div class="terminal">
        <span class="terminal-name">Client</span>
        ${item.basePath ? html`<span class="muted">${item.basePath}</span>` : nothing}
      </div>`;
    case 'backend':
      // Its band is called Backend, so the item names only where it calls
      return html`<div class="terminal">
        ${
          item.at === undefined
            ? html`<span>${item.text}</span>`
            : html`<button
                class="link"
                data-key=${item.key}
                tabindex=${item.key === entry ? 0 : -1}
                data-tooltip=${['Backend', item.text, ...item.facts].filter(Boolean).join('\n')}
                @click=${() => actions.open(item.at!)}
              >
                ${item.text}${
                  item.facts.length
                    ? html`<span class="sr-only"
                        >. ${item.facts.join('. ')}</span
                      >`
                    : nothing
                }
              </button>`
        }
        ${signView(item.sign)}
      </div>`;
    case 'routes':
      return html`<div class="routes-group">
        <span class="segment-label">Route Rules</span>
        ${casesView(item.cases, 'Route Rules', parts, item.endpoint)}
      </div>`;
    case 'hook': {
      const label = `${hookNames[item.point]} Flow Hook`;
      const steps = item.steps?.length ? item.steps : undefined;
      const open = !parts.collapsed.has(item.key);
      return html`<div class="terminal">
          <span class="terminal-head">
            ${steps ? toggleView(item.key, `Steps of ${item.sharedFlow}`, parts) : nothing}
            <span class="terminal-name" aria-hidden="true"
              ><vscode-icon name="plug" class="hook-mark"></vscode-icon
              >${hookNames[item.point]}</span
            >
          </span>
          <button
            class="link"
            data-key=${item.key}
            tabindex=${item.key === entry ? 0 : -1}
            data-tooltip=${[label, item.sharedFlow, ...item.facts].join('\n')}
            @click=${() => actions.hook(item.sharedFlow)}
          >
            ${item.sharedFlow}<span class="sr-only"
              >.
              ${[label, item.revision && `Revision ${item.revision}`, ...item.facts].filter(Boolean).join('. ')}</span
            >
          </button>
          ${signView(item.sign)}
          ${
            item.revision
              ? html`<span class="muted" aria-hidden="true"
                  >Revision ${item.revision}</span
                >`
              : nothing
          }
        </div>
        ${
          steps && open
            ? html`<div class="hook-steps">
                ${stepsView(steps, parts, item.point)}
              </div>`
            : nothing
        }`;
    }
    case 'endpoint': {
      const open = !parts.collapsed.has(item.key);
      const name = `${roleTitles[item.role]} ${item.name}`;
      return html`<div class="card endpoint-card">
        <h4>
          ${item.segments.length ? toggleView(item.key, `Steps of ${name}`, parts) : nothing}
          <button
            class="link"
            data-key=${item.key}
            tabindex=${item.key === entry ? 0 : -1}
            data-tooltip=${[name, ...item.facts].join('\n')}
            @click=${() => actions.open(item.at)}
          >
            ${name}${
              item.facts.length
                ? html`<span class="sr-only">. ${item.facts.join('. ')}</span>`
                : nothing
            }
          </button>
          ${signView(item.sign)}
        </h4>
        ${
          !item.segments.length
            ? html`<p class="no-steps">${none()}</p>`
            : open
              ? html`<div class="segments">
                  ${item.segments.map((segment, index) =>
                    segmentView(segment, `${item.key}/${index}`, parts),
                  )}
                </div>`
              : nothing
        }
      </div>`;
    }
  }
}

function segmentView(
  segment: FlowSegment,
  key: string,
  parts: Parts,
): TemplateResult {
  const open = !parts.collapsed.has(key);
  return html`<div class="segment">
    ${toggleView(key, segment.label, parts, segment.label)}
    ${
      open
        ? html`${segment.facts.map(fact => html`<p class="segment-fact">${fact}</p>`)}
          ${
            'cases' in segment
              ? casesView(segment.cases, segment.label, parts)
              : stepsView(segment.steps, parts)
          }`
        : nothing
    }
  </div>`;
}

/**
 * A first-match group: numbered cases in evaluation order. Route rules are
 * toggle buttons that choose the route the view follows.
 */
function casesView(
  cases: readonly FlowCase[],
  label: string,
  parts: Parts,
  endpoint?: number,
): TemplateResult {
  const { entry, actions } = parts;
  // The order matters only when there is more than one case to try
  const numbered = cases.filter(item => item.number !== undefined).length > 1;
  // Heads line up when only some cases have steps to collapse
  const foldable = cases.some(item => item.steps.length);
  return html`<ol class="cases" aria-label="${label}, the first match runs">
    ${cases.map((item, position) => {
      const route = endpoint !== undefined && item.number !== undefined;
      const open = !parts.collapsed.has(item.key);
      return html`<li class="case">
        <div class="case-line">
          ${
            item.steps.length
              ? toggleView(item.key, `Steps of ${item.name}`, parts)
              : foldable
                ? html`<span class="toggle-space"></span>`
                : nothing
          }
          <button
            class="case-head ${item.muted ? 'muted' : ''}"
            data-key=${item.key}
            tabindex=${item.key === entry ? 0 : -1}
            aria-pressed=${item.followed === undefined ? nothing : String(item.followed)}
            aria-disabled=${route || item.at !== undefined ? nothing : 'true'}
            data-tooltip=${[item.name, item.condition, ...item.facts].filter(Boolean).join('\n')}
            @click=${() => {
              if (route) {
                actions.route(endpoint, position);
              } else if (item.at !== undefined) {
                actions.open(item.at);
              }
            }}
          >
            ${signView(item.sign)}
            ${numbered && item.number !== undefined ? html`<span class="number">${item.number}</span>` : nothing}
            <span class="case-name">${item.name}</span>
            ${item.summary ? html`<span class="summary">${item.summary}</span>` : nothing}
            ${item.destination ? html`<span class="destination">→ ${item.destination}</span>` : nothing}
            ${
              item.facts.length ||
              (item.condition && item.condition !== item.summary)
                ? html`<span class="sr-only"
                    >.
                    ${[item.condition && item.condition !== item.summary ? `If ${item.condition}` : '', ...item.facts].filter(Boolean).join('. ')}</span
                  >`
                : nothing
            }
          </button>
        </div>
        ${item.steps.length && open ? stepsView(item.steps, parts) : nothing}
      </li>`;
    })}
  </ol>`;
}

function stepsView(
  steps: readonly FlowStep[],
  parts: Parts,
  hook?: FlowHookPoint,
): TemplateResult {
  const { entry, actions } = parts;
  return html`<ol class="steps">
    ${steps.map(
      step =>
        html`<li class="step">
          <button
            class="node ${step.condition ? 'conditional' : ''} ${step.muted ? 'muted' : ''}"
            data-key=${step.key}
            tabindex=${step.key === entry ? 0 : -1}
            data-tooltip=${[step.name, step.type, step.condition && `If ${step.condition}`, ...step.facts].filter(Boolean).join('\n')}
            @click=${() => actions.open(step.at, hook)}
          >
            ${signView(step.sign)}
            <span class="node-name">${step.name}</span>
            ${
              step.type
                ? html`<span class="sr-only">, ${step.type}</span
                    ><span class="type" aria-hidden="true">${step.type}</span>`
                : nothing
            }
            ${
              step.condition || step.facts.length
                ? html`<span class="sr-only"
                    >.
                    ${[step.condition && `If ${step.condition}`, ...step.facts].filter(Boolean).join('. ')}</span
                  >`
                : nothing
            }
          </button>
          ${
            step.condition
              ? html`<span class="step-condition" aria-hidden="true"
                  >if ${step.condition}</span
                >`
              : nothing
          }
        </li>`,
    )}
  </ol>`;
}

function signView(sign: FlowSign | undefined) {
  return sign ? statusIcon(signs[sign]) : nothing;
}

/**
 * Moves the focus within a band: up and down in run order, left and right to
 * the previous or next stage as the arrows point, Home and End to the ends.
 */
function moveInBand(event: KeyboardEvent): void {
  const list = event.currentTarget as HTMLElement;
  const items = [...list.querySelectorAll<HTMLElement>('[data-key]')];
  const current = items.indexOf(event.target as HTMLElement);
  if (current < 0) return;
  let next: HTMLElement | undefined;
  switch (event.key) {
    case 'ArrowDown':
      next = items[current + 1];
      break;
    case 'ArrowUp':
      next = items[current - 1];
      break;
    case 'Home':
      next = items[0];
      break;
    case 'End':
      next = items.at(-1);
      break;
    case 'ArrowLeft':
    case 'ArrowRight': {
      // The wide response band runs from right to left
      const mirrored =
        getComputedStyle(list).getPropertyValue('--mirrored').trim() === '1';
      const forward = (event.key === 'ArrowRight') !== mirrored;
      const stages = [...list.children];
      const stage = stages.findIndex(item => item.contains(items[current]));
      const following = forward
        ? stages.slice(stage + 1)
        : stages.slice(0, stage).reverse();
      next =
        following
          .map(item => item.querySelector<HTMLElement>('[data-key]'))
          .find(item => item !== null) ?? undefined;
      break;
    }
    default:
      return;
  }
  event.preventDefault();
  next?.focus();
}
