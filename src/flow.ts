// The flows of an API proxy or shared flow bundle: what Apigee X runs, in
// which order, and under which conditions. Independent of VS Code, like the
// linter; it reads the files of a bundle from memory, so a local bundle and a
// deployed revision give the same model.
import { referencePattern } from './bundle';
import { classifyDocument } from './linter';
import type {
  FlowBand,
  FlowCase,
  FlowItem,
  FlowMap,
  FlowSegment,
  FlowStep,
  Kind,
  Note,
} from './protocol';
import type { BundleFiles } from './revision';
import { parseXml, type XmlNode } from './xml';

/** Where an element can be opened: a bundle file and an offset in it. */
export type Place = { file: string; offset: number };

/** A policy of the bundle, found by the name attribute of its root. */
export type Policy = {
  /** Its root element in the model's places. */
  at: number;
  /** The root element, such as AssignMessage. */
  type: string;
  displayName?: string;
  enabled: boolean;
  continueOnError: boolean;
  /** The shared flow a FlowCallout names; null for a name with a template. */
  calls?: string | null;
};

/** A step: the policy it runs, and the condition under which it does. */
export type Step = { policy: string; condition?: string; at: number };

/** A PreFlow, conditional Flow, or PostFlow with its request and response. */
export type Flow = {
  name?: string;
  condition?: string;
  description?: string;
  request: Step[];
  response: Step[];
  at: number;
};

export type FaultRule = {
  name?: string;
  condition?: string;
  steps: Step[];
  at: number;
};

/** Where a route rule sends a request. */
export type Destination =
  | { target: string }
  | { url: string }
  | { integration: string }
  | { none: true };

export type Route = {
  name?: string;
  condition?: string;
  to: Destination;
  at: number;
};

/** How a target endpoint reaches its backend. */
export type Connection =
  | {
      kind: 'http';
      at: number;
      url?: string;
      servers?: { name: string; fallback: boolean }[];
      algorithm?: string;
      /** Appended to the servers' addresses; Apigee ignores it without them. */
      path?: string;
      successCodes?: string;
    }
  | {
      kind: 'local';
      at: number;
      proxy?: string;
      proxyEndpoint?: string;
      path?: string;
    };

/** A proxy or target endpoint. */
export type Endpoint = {
  name: string;
  file: string;
  at: number;
  description?: string;
  basePath?: string;
  preFlow?: Flow;
  flows: Flow[];
  postFlow?: Flow;
  postClientFlow: Step[];
  /** The EventFlow that Apigee runs, the endpoint's last; absent without one. */
  eventFlow?: Step[];
  faultRules: FaultRule[];
  defaultFaultRule?: { steps: Step[]; alwaysEnforce: boolean; at: number };
  routes: Route[];
  connection?: Connection;
};

export type FlowModel = {
  kind: Kind;
  proxyEndpoints: Endpoint[];
  targetEndpoints: Endpoint[];
  sharedFlow?: { name: string; at: number; steps: Step[] };
  /** By name; a file named after its policy wins over copies. */
  policies: Map<string, Policy>;
  places: Place[];
  notes: Note[];
};

/** What the view needs besides the model. */
export type ViewContext = {
  /** The route rule to follow for each proxy endpoint, by position. */
  routes?: readonly (number | undefined)[];
};

/** Where a step runs, which decides what some of its policies do. */
type Stage = 'request' | 'response' | 'fault' | 'event' | 'after';

// ponytail: only the conditions that Apigee generates from an OpenAPI spec
// are shortened; others show as written
const generatedCondition =
  /^\(proxy\.pathsuffix MatchesPath "([^"]+)"\)(?: and \(request\.verb = "([A-Z]+)"\))?$/;

/**
 * Reads the flows of a bundle from its files, keyed like the entries of a
 * revision archive, such as `apiproxy/proxies/default.xml`.
 */
export function flowModel(files: BundleFiles, kind: Kind): FlowModel {
  const model: FlowModel = {
    kind,
    proxyEndpoints: [],
    targetEndpoints: [],
    policies: new Map(),
    places: [],
    notes: [],
  };
  const place = (file: string, offset: number) =>
    model.places.push({ file, offset }) - 1;
  // The file of each policy, so that the file named after it wins
  const policyFiles = new Map<string, string>();
  let sharedFlowFile: string | undefined;

  const stepsOf = (node: XmlNode | undefined, file: string): Step[] =>
    children(node, 'Step').map(step => {
      const name = child(step, 'Name');
      return {
        policy: textOf(name) ?? '',
        condition: textOf(child(step, 'Condition')),
        at: place(file, name?.text?.start ?? step.start),
      };
    });

  const flowOf = (node: XmlNode, file: string): Flow => ({
    name: attribute(node, 'name'),
    condition: textOf(child(node, 'Condition')),
    description: textOf(child(node, 'Description')),
    request: stepsOf(child(node, 'Request'), file),
    response: stepsOf(child(node, 'Response'), file),
    at: place(file, node.start),
  });

  const routeOf = (rule: XmlNode, file: string): Route => {
    const target = textOf(child(rule, 'TargetEndpoint'));
    const url = textOf(child(rule, 'URL'));
    const integration = textOf(child(rule, 'IntegrationEndpoint'));
    return {
      name: attribute(rule, 'name'),
      condition: textOf(child(rule, 'Condition')),
      to:
        target !== undefined
          ? { target }
          : url !== undefined
            ? { url }
            : integration !== undefined
              ? { integration }
              : { none: true },
      at: place(file, rule.start),
    };
  };

  const connectionOf = (
    root: XmlNode,
    file: string,
  ): Connection | undefined => {
    const http = child(root, 'HTTPTargetConnection');
    if (http) {
      const balancer = child(http, 'LoadBalancer');
      const properties = children(child(http, 'Properties'), 'Property');
      return {
        kind: 'http',
        at: place(file, http.start),
        url: textOf(child(http, 'URL')),
        servers:
          balancer &&
          children(balancer, 'Server').flatMap(server => {
            const name = attribute(server, 'name');
            const fallback = textOf(child(server, 'IsFallback')) === 'true';
            return name ? [{ name, fallback }] : [];
          }),
        algorithm: textOf(child(balancer, 'Algorithm')),
        path: balancer && textOf(child(http, 'Path')),
        successCodes: textOf(
          properties.find(
            property => attribute(property, 'name') === 'success.codes',
          ),
        ),
      };
    }
    const local = child(root, 'LocalTargetConnection');
    return (
      local && {
        kind: 'local',
        at: place(file, local.start),
        proxy: textOf(child(local, 'APIProxy')),
        proxyEndpoint: textOf(child(local, 'ProxyEndpoint')),
        path: textOf(child(local, 'Path')),
      }
    );
  };

  const endpointOf = (root: XmlNode, file: string): Endpoint => {
    const preFlow = child(root, 'PreFlow');
    const postFlow = child(root, 'PostFlow');
    // Apigee runs only the last EventFlow of an endpoint
    const eventFlow = children(root, 'EventFlow').at(-1);
    const defaultFaultRule = child(root, 'DefaultFaultRule');
    return {
      name: attribute(root, 'name') ?? stem(file),
      file,
      at: place(file, root.start),
      description: textOf(child(root, 'Description')),
      basePath: textOf(child(child(root, 'HTTPProxyConnection'), 'BasePath')),
      preFlow: preFlow && flowOf(preFlow, file),
      flows: children(child(root, 'Flows'), 'Flow').map(flow =>
        flowOf(flow, file),
      ),
      postFlow: postFlow && flowOf(postFlow, file),
      postClientFlow: stepsOf(
        child(child(root, 'PostClientFlow'), 'Response'),
        file,
      ),
      eventFlow: eventFlow && stepsOf(child(eventFlow, 'Response'), file),
      faultRules: children(child(root, 'FaultRules'), 'FaultRule').map(
        rule => ({
          name: attribute(rule, 'name'),
          condition: textOf(child(rule, 'Condition')),
          steps: stepsOf(rule, file),
          at: place(file, rule.start),
        }),
      ),
      defaultFaultRule: defaultFaultRule && {
        steps: stepsOf(defaultFaultRule, file),
        alwaysEnforce:
          textOf(child(defaultFaultRule, 'AlwaysEnforce')) === 'true',
        at: place(file, defaultFaultRule.start),
      },
      routes: children(root, 'RouteRule').map(rule => routeOf(rule, file)),
      connection: connectionOf(root, file),
    };
  };

  // Sorted, so that the order of a revision archive does not matter
  for (const file of [...files.keys()].sort()) {
    const documentKind = classifyDocument(file);
    if (
      documentKind !== 'policy' &&
      documentKind !== 'proxyEndpoint' &&
      documentKind !== 'targetEndpoint' &&
      documentKind !== 'sharedFlow'
    ) {
      continue;
    }
    const xml = files
      .get(file)!
      .toString('utf8')
      .replace(/^\uFEFF/, '');
    const document = parseXml(xml);
    const root = document.root;
    if (document.syntaxIssues.length) {
      model.notes.push({
        tone: 'warning',
        text: `The XML of ${file.slice(file.indexOf('/') + 1)} has errors, so the flow may be incomplete.`,
      });
    }

    if (documentKind === 'policy') {
      // A policy counts by the name of its root, as references do; a file
      // named after it wins over copies such as "AM-Set copy.xml"
      const name = root && attribute(root, 'name');
      const known = name && policyFiles.get(name);
      if (
        !root ||
        !name ||
        (known && (stem(known) === name || stem(file) !== name))
      ) {
        continue;
      }
      policyFiles.set(name, file);
      const called = textOf(child(root, 'SharedFlowBundle'));
      model.policies.set(name, {
        at: place(file, root.start),
        type: root.name,
        displayName: textOf(child(root, 'DisplayName')),
        enabled: attribute(root, 'enabled') !== 'false',
        continueOnError: attribute(root, 'continueOnError') === 'true',
        calls:
          root.name !== 'FlowCallout' || called === undefined
            ? undefined
            : referencePattern.test(called)
              ? called
              : null,
      });
    } else if (documentKind === 'proxyEndpoint') {
      if (root?.name === 'ProxyEndpoint') {
        model.proxyEndpoints.push(endpointOf(root, file));
      }
    } else if (documentKind === 'targetEndpoint') {
      if (root?.name === 'TargetEndpoint') {
        model.targetEndpoints.push(endpointOf(root, file));
      }
    } else if (root?.name === 'SharedFlow') {
      // A bundle holds one shared flow; the file named after it wins
      const name = attribute(root, 'name') ?? stem(file);
      if (
        sharedFlowFile &&
        model.sharedFlow &&
        (stem(sharedFlowFile) === model.sharedFlow.name || stem(file) !== name)
      ) {
        continue;
      }
      sharedFlowFile = file;
      model.sharedFlow = {
        name,
        at: place(file, root.start),
        steps: stepsOf(root, file),
      };
    }
  }

  if (kind === 'apis' && !model.proxyEndpoints.length) {
    model.notes.push({
      tone: 'warning',
      text: 'This bundle has no proxy endpoint, so there is no flow to show.',
    });
  }
  if (kind === 'sharedflows' && !model.sharedFlow) {
    model.notes.push({
      tone: 'warning',
      text: 'This bundle has no shared flow, so there is no flow to show.',
    });
  }
  return model;
}

/**
 * Arranges a model for display: one map per proxy endpoint with its bands in
 * run order, first-match groups in evaluation order, and the facts and signs
 * of each item.
 */
export function flowView(
  model: FlowModel,
  context: ViewContext = {},
): { maps: FlowMap[]; notes: Note[] } {
  const maps =
    model.kind === 'sharedflows'
      ? model.sharedFlow
        ? [sharedFlowMap(model, model.sharedFlow)]
        : []
      : model.proxyEndpoints.map((endpoint, index) =>
          proxyMap(model, endpoint, index, context.routes?.[index]),
        );
  return { maps, notes: model.notes };
}

/**
 * Shortens a condition that Apigee generates from an OpenAPI spec, such as
 * `(proxy.pathsuffix MatchesPath "/orders") and (request.verb = "POST")`, to
 * "POST /orders". Other conditions stay as written.
 */
export function conditionSummary(
  condition: string | undefined,
): string | undefined {
  const match = condition?.trim().match(generatedCondition);
  if (!match) return condition;
  const [, path, verb] = match;
  return verb ? `${verb} ${path}` : path;
}

/** Arranges a proxy endpoint, following the chosen route to its target. */
function proxyMap(
  model: FlowModel,
  proxy: Endpoint,
  index: number,
  chosen: number | undefined,
): FlowMap {
  const key = `p${index}`;
  const { item: routes, route } = routeItem(model, proxy, index, chosen, key);
  const target =
    route && 'target' in route.to
      ? targetNamed(model, route.to.target)
      : undefined;
  const backend = route && backendItem(route, target, `${key}/backend`);
  const bands: FlowBand[] = [
    {
      kind: 'request',
      facts: [],
      items: [
        {
          kind: 'client',
          key: `${key}/request/client`,
          basePath: proxy.basePath,
        },
        endpointItem(model, proxy, 'proxy', 'request', `${key}/request/proxy`),
        routes,
        ...(target
          ? [
              endpointItem(
                model,
                target,
                'target',
                'request',
                `${key}/request/target`,
              ),
            ]
          : []),
        ...(backend ? [backend] : []),
      ],
    },
    {
      kind: 'response',
      facts: [],
      items: [
        ...(target
          ? [
              endpointItem(
                model,
                target,
                'target',
                'response',
                `${key}/response/target`,
              ),
            ]
          : []),
        endpointItem(
          model,
          proxy,
          'proxy',
          'response',
          `${key}/response/proxy`,
        ),
        { kind: 'client', key: `${key}/response/client` },
      ],
    },
  ];

  // The target endpoint's EventFlow runs if it has one, else the proxy's
  const events = target?.eventFlow ? target : proxy;
  if (events.eventFlow?.length) {
    bands.push({
      kind: 'event',
      facts: [
        "Runs for each server-sent event; Google's documentation does not say how it is ordered with the response flows.",
      ],
      items: [
        card(events, events === proxy ? 'proxy' : 'target', `${key}/event`, [
          {
            label: 'EventFlow',
            facts: [],
            steps: stepsView(model, events.eventFlow, `${key}/event`, 'event'),
          },
        ]),
      ],
    });
  }

  // Each endpoint handles only the faults that occur in it
  const errors = [
    errorItem(model, proxy, 'proxy', `${key}/error/proxy`),
    target && errorItem(model, target, 'target', `${key}/error/target`),
  ].filter(item => item !== undefined);
  if (errors.length) {
    bands.push({
      kind: 'error',
      facts: [
        'Only the fault rules of the endpoint where the error occurs run.',
      ],
      items: errors,
    });
  }

  if (proxy.postClientFlow.length) {
    bands.push({
      kind: 'after',
      facts: ['Runs after the response is sent, also after errors.'],
      items: [
        card(proxy, 'proxy', `${key}/after`, [
          {
            label: 'PostClientFlow',
            facts: [],
            steps: stepsView(
              model,
              proxy.postClientFlow,
              `${key}/after`,
              'after',
            ),
          },
        ]),
      ],
    });
  }

  return {
    key,
    title: [`Proxy Endpoint ${proxy.name}`, proxy.basePath]
      .filter(Boolean)
      .join(' · '),
    bands,
  };
}

/** Arranges the steps of a shared flow. */
function sharedFlowMap(
  model: FlowModel,
  flow: NonNullable<FlowModel['sharedFlow']>,
): FlowMap {
  // A shared flow runs where a proxy calls it, so its steps follow that flow
  const steps = stepsView(model, flow.steps, 's/steps', 'request');
  return {
    key: 's',
    title: `Shared Flow ${flow.name}`,
    bands: [
      {
        kind: 'steps',
        facts: [],
        items: [
          card(
            flow,
            'shared',
            's/steps',
            steps.length ? [{ label: 'Steps', facts: [], steps }] : [],
          ),
        ],
      },
    ],
  };
}

/** Lists what runs in an endpoint in one direction; empty parts drop out. */
function endpointItem(
  model: FlowModel,
  endpoint: Endpoint,
  role: 'proxy' | 'target',
  direction: 'request' | 'response',
  key: string,
): FlowItem {
  const segments: FlowSegment[] = [];
  const pre = endpoint.preFlow?.[direction] ?? [];
  if (pre.length) {
    segments.push({
      label: 'PreFlow',
      facts: [],
      steps: stepsView(model, pre, `${key}/pre`, direction),
    });
  }
  if (endpoint.flows.some(flow => flow[direction].length)) {
    segments.push({
      label: 'Flows',
      facts:
        direction === 'response'
          ? ['Apigee checks the conditions again for the response']
          : [],
      cases: flowCases(model, endpoint.flows, direction, `${key}/flows`),
    });
  }
  const post = endpoint.postFlow?.[direction] ?? [];
  if (post.length) {
    segments.push({
      label: 'PostFlow',
      facts: [],
      steps: stepsView(model, post, `${key}/post`, direction),
    });
  }
  return card(
    endpoint,
    role,
    key,
    segments,
    endpoint.description ? [endpoint.description] : [],
  );
}

/** An endpoint or shared flow card with the segments that run in it. */
function card(
  owner: { name: string; at: number },
  role: 'proxy' | 'target' | 'shared',
  key: string,
  segments: FlowSegment[],
  facts: string[] = [],
): FlowItem {
  return {
    kind: 'endpoint',
    key,
    at: owner.at,
    role,
    name: owner.name,
    facts,
    segments,
  };
}

/**
 * Finds the first case without a condition. It always matches, so the cases
 * after it never run.
 */
function firstMatch(
  cases: readonly { name?: string; condition?: string }[],
  noun: string,
) {
  const open = cases.findIndex(item => !item.condition);
  const nameOf = (index: number) => cases[index].name ?? `${noun} ${index + 1}`;
  return {
    open,
    nameOf,
    /** Why a case never runs; nothing when it may. */
    shadowed: (index: number) =>
      open >= 0 && index > open
        ? `Never runs: ${nameOf(open)} has no condition and matches first`
        : undefined,
  };
}

/** Lists conditional flows as a first-match group. */
function flowCases(
  model: FlowModel,
  flows: readonly Flow[],
  direction: 'request' | 'response',
  key: string,
): FlowCase[] {
  const match = firstMatch(flows, 'Flow');
  const cases = flows.map((flow, index): FlowCase => {
    const shadowed = match.shadowed(index);
    return {
      key: `${key}/${index}`,
      at: flow.at,
      number: index + 1,
      name: match.nameOf(index),
      summary: conditionSummary(flow.condition) ?? 'Every other request',
      condition: flow.condition,
      ...(shadowed && { sign: 'warning', muted: true }),
      facts: [shadowed, flow.description].filter(fact => fact !== undefined),
      steps: stepsView(model, flow[direction], `${key}/${index}`, direction),
    };
  });
  if (match.open < 0) {
    cases.push({
      key: `${key}/none`,
      name: 'No Match',
      sign: 'none',
      facts: ['A request that matches no condition runs no conditional flow'],
      steps: [],
    });
  }
  return cases;
}

/**
 * Lists route rules as a first-match group and picks the route to follow: the
 * chosen one, else the first without a condition, else the first.
 */
function routeItem(
  model: FlowModel,
  proxy: Endpoint,
  index: number,
  chosen: number | undefined,
  mapKey: string,
): { item: FlowItem; route?: Route } {
  const key = `${mapKey}/routes`;
  const routes = proxy.routes;
  const match = firstMatch(routes, 'RouteRule');
  const followed =
    chosen !== undefined &&
    Number.isInteger(chosen) &&
    chosen >= 0 &&
    chosen < routes.length
      ? chosen
      : Math.max(match.open, 0);
  const cases = routes.map((route, position): FlowCase => {
    const shadowed = match.shadowed(position);
    const { destination, sign, facts } = describeRoute(model, route.to);
    return {
      key: `${key}/${position}`,
      at: route.at,
      number: position + 1,
      name: match.nameOf(position),
      summary: conditionSummary(route.condition),
      condition: route.condition,
      destination,
      ...(shadowed ? { sign: 'warning', muted: true } : sign && { sign }),
      followed: position === followed,
      facts: shadowed ? [shadowed, ...facts] : facts,
      steps: [],
    };
  });
  if (match.open < 0) {
    cases.push({
      key: `${key}/none`,
      name: 'No Match',
      sign: 'error',
      facts: [
        'A request that matches no route rule fails with messaging.runtime.RouteFailed (500)',
      ],
      steps: [],
    });
  }
  return {
    item: { kind: 'routes', key, endpoint: index, cases },
    route: routes[followed],
  };
}

/** Describes where a route rule sends a request. */
function describeRoute(
  model: FlowModel,
  to: Destination,
): { destination: string; sign?: FlowCase['sign']; facts: string[] } {
  if ('target' in to) {
    return targetNamed(model, to.target)
      ? { destination: to.target, facts: [] }
      : {
          destination: to.target,
          sign: 'error',
          facts: [`This bundle has no target endpoint named ${to.target}`],
        };
  }
  if ('url' in to) {
    return {
      destination: to.url,
      facts: ['Calls the URL directly, so no TargetEndpoint flows run'],
    };
  }
  if ('integration' in to) {
    return {
      destination: `Integration Endpoint ${to.integration}`,
      facts: [
        'Runs the integration that a SetIntegrationRequest policy names, so no TargetEndpoint flows run',
      ],
    };
  }
  return {
    destination: 'No Target',
    sign: 'none',
    facts: [
      'A null route: nothing is forwarded, and the proxy endpoint builds the response',
    ],
  };
}

/**
 * Finds a target endpoint by its name, preferring the file named after it,
 * or else by its file name.
 */
function targetNamed(model: FlowModel, name: string): Endpoint | undefined {
  const named = model.targetEndpoints.filter(target => target.name === name);
  return (
    named.find(target => stem(target.file) === name) ??
    named[0] ??
    model.targetEndpoints.find(target => stem(target.file) === name)
  );
}

/** Describes the backend at the end of a route. */
function backendItem(
  route: Route,
  target: Endpoint | undefined,
  key: string,
): FlowItem | undefined {
  const errorFlow = 'Responses with status 4xx or 5xx start the error flow';
  if ('url' in route.to) {
    return {
      kind: 'backend',
      key,
      at: route.at,
      text: route.to.url,
      facts: [errorFlow],
    };
  }
  if ('integration' in route.to) {
    return {
      kind: 'backend',
      key,
      at: route.at,
      text: `Integration Endpoint ${route.to.integration}`,
      facts: [],
    };
  }
  if (!target) return undefined;
  const connection = target.connection;
  if (!connection) {
    return {
      kind: 'backend',
      key,
      at: target.at,
      text: 'No Connection',
      sign: 'unknown',
      facts: ['The target endpoint names no HTTP or local target connection'],
    };
  }
  if (connection.kind === 'local') {
    const text = connection.proxy
      ? [`Proxy ${connection.proxy}`, connection.proxyEndpoint]
          .filter(Boolean)
          .join(' · ')
      : connection.path && `Path ${connection.path}`;
    return {
      kind: 'backend',
      key,
      at: connection.at,
      text: text || 'No Proxy',
      ...(!text && { sign: 'unknown' }),
      facts: [
        text
          ? 'Proxy chaining: calls an API proxy of the same environment without the network'
          : 'The local target connection names no API proxy or path',
      ],
    };
  }
  const servers = connection.servers
    ?.map(server =>
      server.fallback ? `${server.name} (fallback)` : server.name,
    )
    .join(', ');
  const text = [connection.url ?? servers, connection.path]
    .filter(Boolean)
    .join(' · ');
  return {
    kind: 'backend',
    key,
    at: connection.at,
    text: text || 'No URL',
    ...(!text && { sign: 'unknown' }),
    facts: [
      ...(text ? [] : ['The target connection names no URL or server']),
      ...(connection.algorithm
        ? [`Load balancing: ${connection.algorithm}`]
        : []),
      connection.successCodes
        ? `Statuses that count as success: ${connection.successCodes}; all others start the error flow`
        : errorFlow,
    ],
  };
}

/**
 * Lists the fault handling of an endpoint: its fault rules in evaluation
 * order (bottom up in a proxy endpoint, top down in a target endpoint), and
 * its DefaultFaultRule. Nothing when the endpoint handles no faults.
 */
function errorItem(
  model: FlowModel,
  endpoint: Endpoint,
  role: 'proxy' | 'target',
  key: string,
): FlowItem | undefined {
  const rules =
    role === 'proxy' ? [...endpoint.faultRules].reverse() : endpoint.faultRules;
  const fallback = endpoint.defaultFaultRule;
  const segments: FlowSegment[] = [];
  if (rules.length) {
    const match = firstMatch(rules, 'FaultRule');
    const cases = rules.map((rule, position): FlowCase => {
      const shadowed = match.shadowed(position);
      return {
        key: `${key}/rules/${position}`,
        at: rule.at,
        number: position + 1,
        name: match.nameOf(position),
        summary: conditionSummary(rule.condition) ?? 'Every fault',
        condition: rule.condition,
        ...(shadowed && { sign: 'warning', muted: true }),
        facts: shadowed ? [shadowed] : [],
        steps: stepsView(
          model,
          rule.steps,
          `${key}/rules/${position}`,
          'fault',
        ),
      };
    });
    if (fallback && !fallback.alwaysEnforce) {
      const shadowed = match.shadowed(rules.length);
      cases.push({
        key: `${key}/rules/otherwise`,
        at: fallback.at,
        name: 'DefaultFaultRule',
        summary: 'Otherwise',
        ...(shadowed && { sign: 'warning', muted: true }),
        facts: [shadowed ?? 'Runs when no fault rule ran'],
        steps: stepsView(
          model,
          fallback.steps,
          `${key}/rules/otherwise`,
          'fault',
        ),
      });
    }
    segments.push({
      label: 'FaultRules',
      facts: [
        role === 'proxy'
          ? 'Checked from the bottom up; the first match runs'
          : 'Checked from the top down; the first match runs',
      ],
      cases,
    });
  }
  if (fallback && (fallback.alwaysEnforce || !rules.length)) {
    segments.push({
      label: 'DefaultFaultRule',
      facts: [
        fallback.alwaysEnforce
          ? 'Also runs after a fault rule, unless that rule raised a fault with RaiseFault'
          : 'Runs for every fault, since there are no fault rules',
      ],
      steps: stepsView(model, fallback.steps, `${key}/default`, 'fault'),
    });
  }
  return segments.length ? card(endpoint, role, key, segments) : undefined;
}

// What a RaiseFault does where it runs
const raisedFault: Readonly<Record<Stage, string | undefined>> = {
  request: 'Raises a fault, which ends the normal flow',
  response: 'Raises a fault, which ends the normal flow',
  fault:
    'Stops this fault rule; an AlwaysEnforce DefaultFaultRule then does not run',
  event: 'Raises a fault, which ends the event stream',
  after: undefined,
};

/** Shows steps with what the bundle says about their policies. */
function stepsView(
  model: FlowModel,
  steps: readonly Step[],
  key: string,
  stage: Stage,
): FlowStep[] {
  return steps.map((step, index): FlowStep => {
    const policy = model.policies.get(step.policy);
    const base = {
      key: `${key}/${index}`,
      name: step.policy || 'Step',
      ...(step.condition && { condition: step.condition }),
    };
    if (!policy) {
      return {
        ...base,
        at: step.at,
        sign: 'unknown',
        facts: [step.policy ? 'Not in this bundle' : 'Names no policy'],
      };
    }
    const facts: string[] = [];
    let sign: FlowStep['sign'];
    if (policy.displayName && policy.displayName !== step.policy) {
      facts.push(`Display name: ${policy.displayName}`);
    }
    // A disabled policy does nothing else
    if (!policy.enabled) {
      facts.push('Disabled: Apigee skips this step');
      sign = 'none';
    } else {
      if (policy.continueOnError) facts.push('Continues on error');
      if (policy.calls) facts.push(`Calls ${policy.calls}`);
      if (policy.calls === null) {
        facts.push(
          "Names its shared flow with a template; Google's documentation describes only a literal name",
        );
        sign = 'unknown';
      }
      const raised = policy.type === 'RaiseFault' && raisedFault[stage];
      if (raised) facts.push(raised);
      if (policy.type === 'ResponseCache' && stage === 'request') {
        facts.push(
          'On a cache hit, the rest of the request and the backend call are skipped',
        );
      }
    }
    return {
      ...base,
      at: policy.at,
      type: policy.type,
      ...(sign && { sign }),
      ...(!policy.enabled && { muted: true }),
      facts,
    };
  });
}

function child(node: XmlNode | undefined, name: string): XmlNode | undefined {
  return node?.children.find(element => element.name === name);
}

function children(node: XmlNode | undefined, name: string): XmlNode[] {
  return node?.children.filter(element => element.name === name) ?? [];
}

function textOf(node: XmlNode | undefined): string | undefined {
  return node?.text?.value;
}

/** Returns an attribute's value; an empty value counts as none. */
function attribute(node: XmlNode, name: string): string | undefined {
  return node.attributes.find(item => item.name === name)?.value || undefined;
}

/** The file name without directory and extension. */
function stem(file: string): string {
  return file.slice(file.lastIndexOf('/') + 1).replace(/\.xml$/i, '');
}
