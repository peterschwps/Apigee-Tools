// The flow view: one map per proxy endpoint, with bands of stages in the
// order Apigee runs them. The DOM keeps that order for keyboards and screen
// readers; only CSS lays it out as a rail or as Apigee's two bands.
import { html, nothing, type TemplateResult } from 'lit';
import type {
  FlowBand,
  FlowCase,
  FlowItem,
  FlowMap,
  FlowSegment,
  FlowSign,
  FlowStep,
  FlowView,
} from '../protocol';
import { kindLabels, none, signs, statusIcon } from './deployments';

/** How the flow view reports what the user does. */
export type FlowActions = {
  /** Opens a place of the model in the editor. */
  open(at: number): void;
  /** Follows another route rule of a proxy endpoint. */
  route(endpoint: number, route: number): void;
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
  actions: FlowActions,
): TemplateResult {
  return html`<div class="flow-maps">
    ${view.maps.map(
      map => html`
        <section class="flow-map">
          <h2>${map.title}</h2>
          ${map.bands.map(band => bandView(map, band, roving, actions))}
        </section>
      `,
    )}
  </div>`;
}

function bandView(
  map: FlowMap,
  band: FlowBand,
  roving: Readonly<Record<string, string>>,
  actions: FlowActions,
): TemplateResult {
  const key = `${map.key}/${band.kind}`;
  // One tab stop per band: the item focused last, or else the first
  const keys = band.items.flatMap(keysOf);
  const entry = keys.includes(roving[key]) ? roving[key] : keys[0];
  const item = (stage: FlowItem) => itemView(stage, entry, actions);
  return html`
    <section class="band ${band.kind}">
      <h3>${bandTitles[band.kind]}</h3>
      ${band.facts.map(fact => html`<p class="band-fact">${fact}</p>`)}
      <ol
        class="stages"
        @keydown=${moveInBand}
        @focusin=${(event: FocusEvent) => {
          const focused = (event.target as HTMLElement).dataset.key;
          if (focused) actions.rove(key, focused);
        }}
      >
        ${band.items.map(
          stage => html`<li class=${stageClass(stage)}>${item(stage)}</li>`,
        )}
      </ol>
    </section>
  `;
}

/** Classes that place a stage in its column of the wide layout. */
function stageClass(item: FlowItem): string {
  return item.kind === 'endpoint'
    ? `stage endpoint ${item.role}`
    : `stage ${item.kind}`;
}

/** The keys of the focusable parts of an item, in DOM order. */
function keysOf(item: FlowItem): string[] {
  const steps = (list: readonly FlowStep[]) => list.map(step => step.key);
  const cases = (list: readonly FlowCase[]) =>
    list.flatMap(item => [item.key, ...steps(item.steps)]);
  switch (item.kind) {
    case 'endpoint':
      return [
        item.key,
        ...item.segments.flatMap(segment =>
          'cases' in segment ? cases(segment.cases) : steps(segment.steps),
        ),
      ];
    case 'routes':
      return cases(item.cases);
    case 'backend':
      return item.at === undefined ? [] : [item.key];
    case 'client':
      return [];
  }
}

function itemView(
  item: FlowItem,
  entry: string | undefined,
  actions: FlowActions,
): TemplateResult {
  switch (item.kind) {
    case 'client':
      return html`<div class="terminal">
        <span class="terminal-name">Client</span>
        ${item.basePath ? html`<span class="muted">${item.basePath}</span>` : nothing}
      </div>`;
    case 'backend':
      return html`<div class="terminal">
        ${
          item.at === undefined
            ? html`<span class="terminal-name">Backend</span>`
            : html`<button
                class="link terminal-name"
                data-key=${item.key}
                tabindex=${item.key === entry ? 0 : -1}
                data-tooltip=${['Backend', ...item.facts].join('\n')}
                @click=${() => actions.open(item.at!)}
              >
                Backend<span class="sr-only">. ${item.facts.join('. ')}</span>
              </button>`
        }
        ${signView(item.sign)}
        <span class="muted">${item.text}</span>
      </div>`;
    case 'routes':
      return html`<div class="routes-group">
        <span class="segment-label">Route Rules</span>
        ${casesView(item.cases, 'Route Rules', entry, actions, item.endpoint)}
      </div>`;
    case 'endpoint':
      return html`<div class="card endpoint-card">
        <h4>
          <button
            class="link"
            data-key=${item.key}
            tabindex=${item.key === entry ? 0 : -1}
            data-tooltip=${[`${roleTitles[item.role]} ${item.name}`, ...item.facts].join('\n')}
            @click=${() => actions.open(item.at)}
          >
            ${roleTitles[item.role]} ${item.name}
          </button>
        </h4>
        ${
          item.segments.length
            ? html`<div class="segments">
                ${item.segments.map(segment =>
                  segmentView(segment, entry, actions),
                )}
              </div>`
            : html`<p class="no-steps">${none()}</p>`
        }
      </div>`;
  }
}

function segmentView(
  segment: FlowSegment,
  entry: string | undefined,
  actions: FlowActions,
): TemplateResult {
  return html`<div class="segment">
    <span
      class="segment-label"
      data-tooltip=${segment.facts.length ? segment.facts.join('\n') : nothing}
      >${segment.label}${
        segment.facts.length
          ? html`<span class="sr-only">. ${segment.facts.join('. ')}</span>`
          : nothing
      }</span
    >
    ${
      'cases' in segment
        ? casesView(segment.cases, segment.label, entry, actions)
        : stepsView(segment.steps, entry, actions)
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
  entry: string | undefined,
  actions: FlowActions,
  endpoint?: number,
): TemplateResult {
  return html`<ol class="cases" aria-label="${label}, the first match runs">
    ${cases.map(
      (item, position) =>
        html`<li class="case">
          <button
            class="case-head ${item.muted ? 'muted' : ''}"
            data-key=${item.key}
            tabindex=${item.key === entry ? 0 : -1}
            aria-pressed=${item.followed === undefined ? nothing : String(item.followed)}
            data-tooltip=${[item.name, item.condition, ...item.facts].filter(Boolean).join('\n')}
            @click=${() => {
              if (endpoint !== undefined && item.number !== undefined) {
                actions.route(endpoint, position);
              } else if (item.at !== undefined) {
                actions.open(item.at);
              }
            }}
          >
            ${signView(item.sign)}
            ${item.number === undefined ? nothing : html`<span class="number">${item.number}</span>`}
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
          ${item.steps.length ? stepsView(item.steps, entry, actions) : nothing}
        </li>`,
    )}
  </ol>`;
}

function stepsView(
  steps: readonly FlowStep[],
  entry: string | undefined,
  actions: FlowActions,
): TemplateResult {
  return html`<ol class="steps">
    ${steps.map(
      step =>
        html`<li class="step">
          <button
            class="node ${step.condition ? 'conditional' : ''} ${step.muted ? 'muted' : ''}"
            data-key=${step.key}
            tabindex=${step.key === entry ? 0 : -1}
            data-tooltip=${[step.name, step.type, step.condition && `If ${step.condition}`, ...step.facts].filter(Boolean).join('\n')}
            @click=${() => actions.open(step.at)}
          >
            ${signView(step.sign)}
            <span class="node-name">${step.name}</span>
            ${step.type ? html`<span class="type"><span class="sr-only">, </span>${step.type}</span>` : nothing}
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
