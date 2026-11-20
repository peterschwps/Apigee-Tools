import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { history } from '../scripts/test-org';
import { conditionSummary, flowModel, flowView } from '../src/flow';
import type {
  FlowCase,
  FlowItem,
  FlowMap,
  FlowSegment,
  FlowStep,
  Kind,
} from '../src/protocol';
import {
  compareBundles,
  fingerprints,
  readBundle,
  type BundleFiles,
} from '../src/revision';

const shop = path.join(__dirname, 'sample-shop', 'src', 'main', 'apigee');

/** Reads a bundle of the sample shop. */
async function shopModel(name: string, kind: Kind = 'apis') {
  const directory =
    kind === 'apis'
      ? path.join(shop, 'apiproxies', name, 'apiproxy')
      : path.join(shop, 'sharedflows', name, 'sharedflowbundle');
  return flowModel(await readBundle(directory, kind), kind);
}

/** Builds bundle files from text, keyed like a revision archive. */
function files(entries: Record<string, string>): BundleFiles {
  return new Map(
    Object.entries(entries).map(([file, text]) => [file, Buffer.from(text)]),
  );
}

/** A policy file of a type and name, with more attributes and content. */
function policy(type: string, name: string, attributes = '', content = '') {
  return {
    [`apiproxy/policies/${name}.xml`]: `<${type} name="${name}"${attributes}>${content}</${type}>`,
  };
}

const step = (name: string, condition?: string) =>
  `<Step><Name>${name}</Name>${condition ? `<Condition>${condition}</Condition>` : ''}</Step>`;

/** A proxy bundle from the body of its ProxyEndpoint and more files. */
function proxy(endpoint: string, ...more: Record<string, string>[]) {
  return flowModel(
    files(
      Object.assign(
        {
          'apiproxy/proxies/default.xml': `<ProxyEndpoint name="default">${endpoint}</ProxyEndpoint>`,
        },
        ...more,
      ),
    ),
    'apis',
  );
}

const target = (content: string) => ({
  'apiproxy/targets/default.xml': `<TargetEndpoint name="default">${content}</TargetEndpoint>`,
});

const defaultRoute =
  '<RouteRule name="default"><TargetEndpoint>default</TargetEndpoint></RouteRule>';

// Short text per item, so that a failing assertion points at the item
const sign = (value?: string) => (value ? ` !${value}` : '');
const stepText = (item: FlowStep) =>
  `${item.name}${item.type ? `:${item.type}` : ''}${item.condition ? ` if ${item.condition}` : ''}${sign(item.sign)}`;
const caseText = (item: FlowCase) =>
  [
    item.number,
    item.name,
    item.summary && `(${item.summary})`,
    item.destination && `→ ${item.destination}`,
    item.followed && '*',
    item.sign && `!${item.sign}`,
    item.steps.length && `{${item.steps.map(stepText).join(', ')}}`,
  ]
    .filter(Boolean)
    .join(' ');
const segmentText = (segment: FlowSegment) =>
  `[${segment.label}: ${
    'cases' in segment
      ? segment.cases.map(caseText).join('; ')
      : segment.steps.map(stepText).join(', ')
  }]`;
const itemText = (item: FlowItem): string => {
  switch (item.kind) {
    case 'client':
      return item.basePath ? `Client ${item.basePath}` : 'Client';
    case 'hook':
      return `${item.point} ${item.sharedFlow}${sign(item.sign)}`;
    case 'endpoint':
      return `${item.role} ${item.name}${sign(item.sign)} ${
        item.segments.map(segmentText).join(' ') || '–'
      }`;
    case 'routes':
      return `Routes [${item.cases.map(caseText).join('; ')}]`;
    case 'backend':
      return `Backend ${item.text}${sign(item.sign)}`;
  }
};
const bands = (map: FlowMap) =>
  map.bands.map(band => [band.kind, ...band.items.map(itemText)]);

/** Finds an item of a view by its key. */
function find<T>(value: unknown, key: string): T {
  const stack = [value];
  while (stack.length) {
    const next = stack.pop();
    if (next && typeof next === 'object') {
      if ((next as { key?: string }).key === key) return next as T;
      stack.push(...Object.values(next));
    }
  }
  throw new Error(`No item has the key ${key}`);
}

/** The names of the steps in a band, in run order. */
function stepNames(map: FlowMap, kind: string): string[] {
  const band = map.bands.find(item => item.kind === kind);
  return (band?.items ?? []).flatMap(item =>
    item.kind === 'endpoint'
      ? item.segments.flatMap(segment =>
          ('cases' in segment
            ? segment.cases.flatMap(entry => entry.steps)
            : segment.steps
          ).map(entry => entry.name),
        )
      : [],
  );
}

test('a proxy runs its flows in the order Apigee runs them', async () => {
  const [map] = flowView(await shopModel('orders-v1')).maps;
  assert.equal(map.title, 'Proxy Endpoint default · /orders/v1');
  assert.deepEqual(bands(map), [
    [
      'request',
      'Client /orders/v1',
      'proxy default [PreFlow: OA-VerifyAccessToken:OAuthV2, FC-QuotaPerApp:FlowCallout] [Flows: 1 createOrder (POST /orders) {KVM-GetMaxItems:KeyValueMapOperations, JS-ValidateOrder:Javascript, RF-InvalidOrder:RaiseFault if order.valid = "false"}; 2 getOrder (GET /orders/*) {EV-OrderId:ExtractVariables}; 3 cancelOrder (DELETE /orders/*) {EV-OrderId:ExtractVariables}; No Match !none]',
      'Routes [1 default → default *]',
      'target default –',
      'Backend orders-backend · /v1',
    ],
    ['response', 'target default –', 'proxy default –', 'Client'],
  ]);
  assert.deepEqual(find<FlowStep>(map, 'p0/request/proxy/pre/1').facts, [
    'Calls quota-per-app',
  ]);
});

test('each endpoint runs PreFlow, Flows, and PostFlow; the response starts at the target', () => {
  const segment = (side: string, prefix: string) =>
    `<${side}>${step(`${prefix}`)}</${side}>`;
  const flows = (p: string) =>
    `<PreFlow>${segment('Request', `${p}PreReq`)}${segment('Response', `${p}PreRes`)}</PreFlow>
     <Flows><Flow name="f">${segment('Request', `${p}FlowReq`)}${segment('Response', `${p}FlowRes`)}<Condition>a = 1</Condition></Flow></Flows>
     <PostFlow>${segment('Request', `${p}PostReq`)}${segment('Response', `${p}PostRes`)}</PostFlow>`;
  const [map] = flowView(
    proxy(`${flows('P')}${defaultRoute}`, target(flows('T'))),
  ).maps;
  assert.deepEqual(stepNames(map, 'request'), [
    'PPreReq',
    'PFlowReq',
    'PPostReq',
    'TPreReq',
    'TFlowReq',
    'TPostReq',
  ]);
  assert.deepEqual(stepNames(map, 'response'), [
    'TPreRes',
    'TFlowRes',
    'TPostRes',
    'PPreRes',
    'PFlowRes',
    'PPostRes',
  ]);
});

test('a step opens at its policy, and a missing policy at the step', async () => {
  const directory = path.join(shop, 'apiproxies', 'orders-v1', 'apiproxy');
  const bundle = await readBundle(directory, 'apis');
  const model = flowModel(bundle, 'apis');
  const at = find<FlowStep>(
    flowView(model).maps[0],
    'p0/request/proxy/pre/0',
  ).at;
  const { file, offset } = model.places[at];
  assert.equal(file, 'apiproxy/policies/OA-VerifyAccessToken.xml');
  assert.match(bundle.get(file)!.toString().slice(offset), /^<OAuthV2 /);

  const reviews = await shopModel('reviews');
  const missing = find<FlowStep>(
    flowView(reviews).maps[0],
    'p0/request/proxy/flows/1/4',
  );
  assert.deepEqual(
    [missing.name, missing.type, missing.sign, missing.facts],
    ['JS-MaskProfanity', undefined, 'unknown', ['Not in this bundle']],
  );
  assert.equal(reviews.places[missing.at].file, 'apiproxy/proxies/default.xml');
});

test('route rules are a first-match group, and the followed one draws the target', async () => {
  const model = await shopModel('shipping');
  const [map] = flowView(model).maps;
  assert.equal(
    itemText(find(map, 'p0/routes')),
    'Routes [1 ratesFromCarrier (/rates) → No Target !none; 2 default → default *]',
  );
  // Following the null route leaves out the target endpoint and the backend
  const [nullRoute] = flowView(model, { routes: [0] }).maps;
  assert.deepEqual(
    nullRoute.bands.map(band => band.items.map(item => item.kind)),
    [
      ['client', 'endpoint', 'routes'],
      ['endpoint', 'client'],
    ],
  );
  // A choice that is no index falls back to the default route
  for (const chosen of [1.5, -1, 7]) {
    const [fallback] = flowView(model, { routes: [chosen] }).maps;
    assert.equal(find<FlowCase>(fallback, 'p0/routes/1').followed, true);
  }
  // The response repeats every case, since getRates has response steps
  assert.equal(
    bands(map)[1][2],
    'proxy default [Flows: 1 getRates (GET /rates) {AM-RatesResponse:AssignMessage if (responsecache.RC-ShippingRates.cachehit = false), RC-ShippingRates:ResponseCache}; 2 createShipment (POST /shipments); 3 trackShipment (GET /shipments/*/tracking); 4 unknownResource (Every other request)]',
  );
  assert.deepEqual(find<FlowStep>(map, 'p0/request/proxy/flows/0/1').facts, [
    'On a cache hit, the rest of the request and the backend call are skipped',
  ]);
  assert.deepEqual(
    find<FlowStep>(map, 'p0/response/proxy/flows/0/1').facts,
    [],
  );
});

test('a null route without target endpoints ends the request at the route rules', async () => {
  const [map] = flowView(await shopModel('status')).maps;
  assert.deepEqual(bands(map)[0].slice(-1), [
    'Routes [1 noTarget → No Target * !none]',
  ]);
  assert.deepEqual(bands(map)[1], [
    'response',
    'proxy default [Flows: 1 getHealth (GET /health) {AM-HealthResponse:AssignMessage}; 2 unknownResource (Every other request)]',
    'Client',
  ]);
});

test('fault rules of the sample shop show with the endpoint that has them', async () => {
  const [legacy] = flowView(await shopModel('LegacyStorefront')).maps;
  assert.deepEqual(bands(legacy)[2], [
    'error',
    'target default [FaultRules: 1 backendUnavailable ((fault.name = "ServiceUnavailable") or (fault.name = "NoActiveTargets") or (fault.name = "GatewayTimeout")) {AM-BackendUnavailable:AssignMessage}]',
  ]);
  const backend = find<FlowItem & { kind: 'backend' }>(legacy, 'p0/backend');
  assert.deepEqual(
    [backend.text, backend.facts],
    [
      'legacy-soap, legacy-soap-standby (fallback) · /storefront',
      [
        'Load balancing: RoundRobin',
        'Responses with status 4xx or 5xx start the error flow',
      ],
    ],
  );

  const [customers] = flowView(await shopModel('customers')).maps;
  assert.deepEqual(bands(customers)[2], [
    'error',
    'proxy default [FaultRules: 1 insufficientScope ((fault.name = "InsufficientScope")) {AM-InsufficientScope:AssignMessage}]',
  ]);
});

test('a route to a target endpoint that does not exist is an error', async () => {
  const [map] = flowView(await shopModel('partner-gateway')).maps;
  const orders = find<FlowCase>(map, 'p0/routes/0');
  assert.deepEqual(
    [orders.destination, orders.sign, orders.followed, orders.facts],
    [
      'orders',
      'error',
      false,
      ['This bundle has no target endpoint named orders'],
    ],
  );
});

test('flows that share a name stay apart', async () => {
  const [map] = flowView(await shopModel('cart')).maps;
  const second = find<FlowCase>(map, 'p0/request/proxy/flows/1');
  const third = find<FlowCase>(map, 'p0/request/proxy/flows/2');
  assert.deepEqual(
    [second.number, second.name, third.number, third.name],
    [2, 'addItem', 3, 'addItem'],
  );
  assert.notEqual(second.at, third.at);
});

test('a shared flow lists its steps', async () => {
  const [baseline] = flowView(
    await shopModel('security-baseline', 'sharedflows'),
  ).maps;
  assert.deepEqual(bands(baseline), [
    [
      'steps',
      'shared default [Steps: VAK-ApiKey:VerifyAPIKey, SA-PerApp:SpikeArrest, JTP-Request:JSONThreatProtection if request.header.content-type =| "application/json"]',
    ],
  ]);
  const [draft] = flowView(await shopModel('audit-draft', 'sharedflows')).maps;
  assert.deepEqual(bands(draft), [
    [
      'steps',
      'shared default [Steps: AM-AuditRecord:AssignMessage, ML-AuditTrail !unknown]',
    ],
  ]);
});

test('flows after a flow without a condition never run', () => {
  const model = proxy(
    `<Flows>
      <Flow name="a"><Request>${step('A')}</Request><Condition>request.verb = "GET"</Condition></Flow>
      <Flow name="other"><Request>${step('A')}</Request></Flow>
      <Flow name="late"><Request>${step('A')}</Request><Condition>request.verb = "PUT"</Condition></Flow>
    </Flows>${defaultRoute}`,
    policy('AssignMessage', 'A'),
    target(''),
  );
  const [map] = flowView(model).maps;
  const late = find<FlowCase>(map, 'p0/request/proxy/flows/2');
  assert.deepEqual(
    [late.sign, late.muted, late.facts],
    ['warning', true, ['Never runs: other has no condition and matches first']],
  );
  // The flow without a condition catches the rest, so there is no No Match
  assert.equal(
    bands(map)[0][2],
    'proxy default [Flows: 1 a (request.verb = "GET") {A:AssignMessage}; 2 other (Every other request) {A:AssignMessage}; 3 late (request.verb = "PUT") !warning {A:AssignMessage}]',
  );
});

test('fault rules count in evaluation order, and DefaultFaultRule follows them', () => {
  const rules = `<FaultRules>
    <FaultRule name="first">${step('A')}<Condition>fault.name = "One"</Condition></FaultRule>
    <FaultRule name="catchAll">${step('A')}</FaultRule>
    <FaultRule name="last">${step('A')}<Condition>fault.name = "Two"</Condition></FaultRule>
  </FaultRules>`;
  const fallback = (always: boolean) =>
    `<DefaultFaultRule>${step('A')}<AlwaysEnforce>${always}</AlwaysEnforce><Condition>ignored</Condition></DefaultFaultRule>`;

  // A proxy endpoint checks its fault rules from the bottom up
  const [map] = flowView(
    proxy(
      `${rules}${fallback(false)}${defaultRoute}`,
      policy('AssignMessage', 'A'),
      target(`${rules}${fallback(true)}`),
    ),
  ).maps;
  assert.deepEqual(bands(map)[2], [
    'error',
    'proxy default [FaultRules: 1 last (fault.name = "Two") {A:AssignMessage}; 2 catchAll (Every fault) {A:AssignMessage}; 3 first (fault.name = "One") !warning {A:AssignMessage}; DefaultFaultRule (Otherwise) !warning {A:AssignMessage}]',
    'target default [FaultRules: 1 first (fault.name = "One") {A:AssignMessage}; 2 catchAll (Every fault) {A:AssignMessage}; 3 last (fault.name = "Two") !warning {A:AssignMessage}] [DefaultFaultRule: A:AssignMessage]',
  ]);
  assert.deepEqual(
    find<FlowItem & { kind: 'endpoint' }>(map, 'p0/error/target').segments[1]
      .facts,
    [
      'Also runs after a fault rule, unless that rule raised a fault with RaiseFault',
    ],
  );
  // Apigee ignores the condition of a DefaultFaultRule, so it never shows
  assert.doesNotMatch(JSON.stringify(map), /ignored/);

  // With only conditional fault rules, DefaultFaultRule catches the rest
  const [conditional] = flowView(
    proxy(
      `<FaultRules><FaultRule name="one">${step('A')}<Condition>a = 1</Condition></FaultRule></FaultRules>${fallback(false)}`,
      policy('AssignMessage', 'A'),
    ),
  ).maps;
  const otherwise = find<FlowCase>(
    conditional,
    'p0/error/proxy/rules/otherwise',
  );
  assert.deepEqual(
    [otherwise.sign, otherwise.facts],
    [undefined, ['Runs when no fault rule ran']],
  );

  // Without fault rules, the DefaultFaultRule runs for every fault
  const [plain] = flowView(
    proxy(`${fallback(false)}${defaultRoute}`, policy('AssignMessage', 'A')),
  ).maps;
  assert.deepEqual(bands(plain)[2], [
    'error',
    'proxy default [DefaultFaultRule: A:AssignMessage]',
  ]);
});

test('PostClientFlow and EventFlow get bands of their own', () => {
  const model = proxy(
    `<PostClientFlow><Response>${step('ML')}</Response></PostClientFlow>${defaultRoute}`,
    policy('MessageLogging', 'ML'),
    policy('Javascript', 'JS1'),
    policy('Javascript', 'JS2'),
    // Apigee runs the last EventFlow of an endpoint
    target(
      `<EventFlow name="first" content-type="text/event-stream"><Response>${step('JS1')}</Response></EventFlow>
       <EventFlow name="last" content-type="text/event-stream"><Response>${step('JS2')}</Response></EventFlow>`,
    ),
  );
  const [map] = flowView(model).maps;
  assert.deepEqual(bands(map).slice(2), [
    ['event', 'target default [EventFlow: JS2:Javascript]'],
    ['after', 'proxy default [PostClientFlow: ML:MessageLogging]'],
  ]);

  // When both endpoints have one, the target endpoint's runs, even empty
  const [both] = flowView(
    proxy(
      `<EventFlow content-type="text/event-stream"><Response>${step('JS1')}</Response></EventFlow>${defaultRoute}`,
      policy('Javascript', 'JS1'),
      target(
        '<EventFlow content-type="text/event-stream"><Response/></EventFlow>',
      ),
    ),
  ).maps;
  assert.deepEqual(
    both.bands.map(band => band.kind),
    ['request', 'response'],
  );
});

test('steps tell what their policy does where it runs', () => {
  const model = proxy(
    `<PreFlow><Request>${step('Off')}${step('Soft')}${step('Called')}${step('Raise')}${step('')}</Request></PreFlow>
     <FaultRules><FaultRule name="f">${step('Raise')}${step('Cache')}</FaultRule></FaultRules>${defaultRoute}`,
    policy('RaiseFault', 'Off', ' enabled="false"'),
    policy(
      'MessageLogging',
      'Soft',
      ' continueOnError="true"',
      '<DisplayName>Soft logging</DisplayName>',
    ),
    policy(
      'FlowCallout',
      'Called',
      '',
      '<SharedFlowBundle>{flow.name}</SharedFlowBundle>',
    ),
    policy('RaiseFault', 'Raise'),
    policy('ResponseCache', 'Cache'),
    target(''),
  );
  const [map] = flowView(model).maps;
  const facts = (key: string) => {
    const item = find<FlowStep>(map, key);
    return [item.sign, ...item.facts];
  };
  // A disabled policy does nothing else
  assert.deepEqual(facts('p0/request/proxy/pre/0'), [
    'none',
    'Disabled: Apigee skips this step',
  ]);
  assert.deepEqual(facts('p0/request/proxy/pre/1'), [
    undefined,
    'Display name: Soft logging',
    'Continues on error',
  ]);
  assert.deepEqual(facts('p0/request/proxy/pre/2'), [
    'unknown',
    "Names its shared flow with a template; Google's documentation describes only a literal name",
  ]);
  assert.deepEqual(facts('p0/request/proxy/pre/3'), [
    undefined,
    'Raises a fault, which ends the normal flow',
  ]);
  assert.deepEqual(facts('p0/request/proxy/pre/4'), [
    'unknown',
    'Names no policy',
  ]);
  // In a fault rule, RaiseFault stops the rule, and caching has no request
  assert.deepEqual(facts('p0/error/proxy/rules/0/0'), [
    undefined,
    'Stops this fault rule; an AlwaysEnforce DefaultFaultRule then does not run',
  ]);
  assert.deepEqual(facts('p0/error/proxy/rules/0/1'), [undefined]);
});

test('routes without a target endpoint lead to their destination', () => {
  const routes = `<RouteRule name="direct"><Condition>a = 1</Condition><URL>https://example.com</URL></RouteRule>
    <RouteRule name="integration"><Condition>a = 2</Condition><IntegrationEndpoint>default</IntegrationEndpoint></RouteRule>
    <RouteRule name="dynamic"><Condition>a = 3</Condition><TargetEndpoint>{target.name}</TargetEndpoint></RouteRule>`;
  const model = proxy(routes, target(''));
  const routesOf = (map: FlowMap) => itemText(find(map, 'p0/routes'));
  const ends = (map: FlowMap) => bands(map)[0].slice(-2);
  const [direct] = flowView(model).maps;
  // Only conditional routes: a request that matches none fails
  assert.equal(
    routesOf(direct),
    'Routes [1 direct (a = 1) → https://example.com *; 2 integration (a = 2) → Integration Endpoint default; 3 dynamic (a = 3) → {target.name} !error; No Match !error]',
  );
  assert.deepEqual(ends(direct), [
    routesOf(direct),
    'Backend https://example.com',
  ]);
  const [integration] = flowView(model, { routes: [1] }).maps;
  assert.deepEqual(ends(integration).slice(-1), [
    'Backend Integration Endpoint default',
  ]);
  const [dynamic] = flowView(model, { routes: [2] }).maps;
  assert.equal(bands(dynamic)[0].at(-1), routesOf(dynamic));

  // Without route rules, every request fails as with no match
  const [none] = flowView(proxy('')).maps;
  assert.equal(routesOf(none), 'Routes [No Match !error]');
});

test('backends show where requests go and which statuses count as success', () => {
  const backend = (connection: string) =>
    itemText(
      find(
        flowView(proxy(defaultRoute, target(connection))).maps[0],
        'p0/backend',
      ),
    );
  assert.equal(
    backend(
      '<LocalTargetConnection><APIProxy>inner</APIProxy><ProxyEndpoint>default</ProxyEndpoint></LocalTargetConnection>',
    ),
    'Backend Proxy inner · default',
  );
  assert.equal(
    backend(
      '<LocalTargetConnection><Path>/inner</Path></LocalTargetConnection>',
    ),
    'Backend Path /inner',
  );
  // Apigee appends a Path only to the servers of a load balancer
  assert.equal(
    backend(
      '<HTTPTargetConnection><URL>https://example.com</URL><Path>/ignored</Path></HTTPTargetConnection>',
    ),
    'Backend https://example.com',
  );
  assert.equal(
    backend(
      '<HTTPTargetConnection><LoadBalancer><Server name=""/></LoadBalancer></HTTPTargetConnection>',
    ),
    'Backend No URL !unknown',
  );
  const [codes] = flowView(
    proxy(
      defaultRoute,
      target(
        '<HTTPTargetConnection><Properties><Property name="success.codes">1xx,2xx,3xx,400</Property></Properties><URL>https://example.com</URL></HTTPTargetConnection>',
      ),
    ),
  ).maps;
  assert.deepEqual(
    find<FlowItem & { kind: 'backend' }>(codes, 'p0/backend').facts,
    [
      'Statuses that count as success: 1xx,2xx,3xx,400; all others start the error flow',
    ],
  );
});

test('each proxy endpoint gets a map, and a route may name a target by its file', () => {
  const model = flowModel(
    files({
      'apiproxy/proxies/a.xml':
        '<ProxyEndpoint name="a"><RouteRule name="r"><TargetEndpoint>backend</TargetEndpoint></RouteRule></ProxyEndpoint>',
      'apiproxy/proxies/b.xml': '<ProxyEndpoint name=""/>',
      'apiproxy/targets/backend.xml':
        '<TargetEndpoint name="renamed"><HTTPTargetConnection><URL>https://example.com</URL></HTTPTargetConnection></TargetEndpoint>',
    }),
    'apis',
  );
  const maps = flowView(model).maps;
  // An empty name counts as none, so the file names the endpoint
  assert.deepEqual(
    maps.map(map => map.title),
    ['Proxy Endpoint a', 'Proxy Endpoint b'],
  );
  assert.deepEqual(bands(maps[0])[0].slice(-2), [
    'target renamed –',
    'Backend https://example.com',
  ]);
});

test('a file named after its policy wins over a copy', () => {
  const model = proxy(
    `<PreFlow><Request>${step('AM-Set')}</Request></PreFlow>`,
    {
      'apiproxy/policies/AM-Set copy.xml': '<RaiseFault name="AM-Set"/>',
      'apiproxy/policies/AM-Set.xml': '<AssignMessage name="AM-Set"/>',
    },
  );
  assert.equal(model.policies.get('AM-Set')?.type, 'AssignMessage');
});

test('places point into the text without a byte order mark, also with CRLF', async () => {
  const xml =
    '<?xml version="1.0"?>\r\n<!-- a comment -->\r\n<AssignMessage name="AM-Bom"/>\r\n';
  const model = proxy(
    `<PreFlow><Request>${step('AM-Bom')}</Request></PreFlow>`,
    {
      'apiproxy/policies/AM-Bom.xml': `\uFEFF${xml}`,
    },
  );
  const { offset } = model.places[model.policies.get('AM-Bom')!.at];
  assert.equal(xml.slice(offset, offset + 14), '<AssignMessage');

  // inventory-soap has a policy with a byte order mark and CRLF line ends
  const directory = path.join(shop, 'apiproxies', 'inventory-soap', 'apiproxy');
  const bundle = await readBundle(directory, 'apis');
  const inventory = flowModel(bundle, 'apis');
  const marked = [...inventory.policies.values()].find(
    item => bundle.get(inventory.places[item.at].file)?.[0] === 0xef,
  );
  assert.ok(marked, 'expected a policy with a byte order mark');
  const place = inventory.places[marked.at];
  const text = bundle
    .get(place.file)!
    .toString('utf8')
    .replace(/^\uFEFF/, '');
  assert.ok(text.includes('\r\n'));
  assert.ok(text.slice(place.offset).startsWith(`<${marked.type}`));
});

test('the model notes what it cannot read', () => {
  const broken = flowModel(
    files({
      'apiproxy/proxies/default.xml':
        '<ProxyEndpoint name="default"><PreFlow><Request>',
      'apiproxy/policies/A.xml': '<AssignMessage name="A"',
    }),
    'apis',
  );
  assert.deepEqual(
    broken.notes.map(note => note.text),
    [
      'The XML of policies/A.xml has errors, so the flow may be incomplete.',
      'The XML of proxies/default.xml has errors, so the flow may be incomplete.',
    ],
  );
  assert.deepEqual(flowModel(files({}), 'sharedflows').notes, [
    {
      tone: 'warning',
      text: 'This bundle has no shared flow, so there is no flow to show.',
    },
  ]);
});

test('generated conditions are shortened, others stay as written', () => {
  assert.equal(
    conditionSummary(
      '(proxy.pathsuffix MatchesPath "/orders") and (request.verb = "POST")',
    ),
    'POST /orders',
  );
  assert.equal(
    conditionSummary('(proxy.pathsuffix MatchesPath "/rates")'),
    '/rates',
  );
  for (const condition of [
    '(request.verb = "POST") and (proxy.pathsuffix MatchesPath "/orders")',
    '(proxy.pathsuffix MatchesPath "/orders") and (request.verb = "POST") and (a = 1)',
    'proxy.pathsuffix MatchesPath "/orders"',
  ]) {
    assert.equal(conditionSummary(condition), condition);
  }
  assert.equal(conditionSummary(undefined), undefined);
});

/** A revision of a sample-shop proxy: its local files with a history edit. */
async function revisionOf(name: string, revision: number) {
  const directory = path.join(shop, 'apiproxies', name, 'apiproxy');
  const local = await readBundle(directory, 'apis');
  const files = new Map(local);
  history[name][revision - 1](files);
  return {
    files,
    changes: compareBundles(fingerprints(files), fingerprints(local)),
  };
}

test('an environment marks what differs from the workspace, file by file', async () => {
  // In test, orders-v1 runs revision 1, where a header policy stood instead
  const orders = await revisionOf('orders-v1', 1);
  const [map] = flowView(flowModel(orders.files, 'apis'), {
    environment: 'test',
    changes: orders.changes,
  }).maps;
  const card = find<FlowItem & { kind: 'endpoint' }>(map, 'p0/request/proxy');
  assert.equal(card.sign, 'differs');
  assert.deepEqual(card.facts, [
    'Its steps, conditions, or routes differ from the workspace',
  ]);
  assert.deepEqual(
    ['0', '1'].map(index => {
      const item = find<FlowStep>(map, `p0/request/proxy/flows/0/${index}`);
      return [item.name, item.sign, item.facts];
    }),
    [
      ['KVM-GetMaxItems', undefined, []],
      ['AM-LegacyOrderHeader', 'differs', ['Not in the workspace']],
    ],
  );
  const { changed, added, removed } = orders.changes;
  assert.equal(changed.length + added.length + removed.length, 3);

  // catalog-v2 revision 2 has the flow of the workspace, with other policies
  const catalog = await revisionOf('catalog-v2', 2);
  const [other] = flowView(flowModel(catalog.files, 'apis'), {
    environment: 'test',
    changes: catalog.changes,
  }).maps;
  assert.deepEqual(
    [
      'p0/response/proxy/post/0',
      'p0/response/proxy/flows/0/0',
      'p0/request/proxy/flows/0/0',
    ].map(key => {
      const item = find<FlowStep>(other, key);
      return [item.name, item.sign, item.facts];
    }),
    [
      ['AM-CatalogVersion', 'differs', ['Differs from the workspace']],
      [
        'JS-PageLinks',
        'differs',
        ['Its resource page-links.js differs from the workspace'],
      ],
      ['OAS-ValidateRequest', undefined, []],
    ],
  );
  assert.equal(
    find<FlowItem & { kind: 'endpoint' }>(other, 'p0/request/proxy').sign,
    undefined,
  );

  // A revision that equals the workspace, apart from formatting, has no marks
  const directory = path.join(shop, 'apiproxies', 'catalog-v2', 'apiproxy');
  const local = await readBundle(directory, 'apis');
  const same = compareBundles(fingerprints(local), fingerprints(local));
  const [plain] = flowView(flowModel(local, 'apis'), {
    environment: 'eval',
    changes: same,
  }).maps;
  assert.doesNotMatch(JSON.stringify(plain), /differs/);
});

test('an environment draws the shared flows of its flow hooks where they run', async () => {
  const deployed = new Map([
    ['security-baseline', { revision: '2' }],
    ['logging', { revision: '1', differs: true }],
  ]);
  const environment = {
    environment: 'eval',
    hooks: {
      PreProxyFlowHook: {
        sharedFlow: 'security-baseline',
        continueOnError: false,
      },
      PostProxyFlowHook: { sharedFlow: 'logging', continueOnError: true },
    },
    sharedFlow: (name: string) => deployed.get(name),
  };
  const [map] = flowView(await shopModel('orders-v1'), environment).maps;
  assert.deepEqual(
    map.bands.map(band => band.items.map(item => item.kind)),
    [
      ['client', 'hook', 'endpoint', 'routes', 'endpoint', 'backend'],
      ['endpoint', 'endpoint', 'hook', 'client'],
    ],
  );
  const pre = find<FlowItem & { kind: 'hook' }>(
    map,
    'p0/request/PreProxyFlowHook',
  );
  const post = find<FlowItem & { kind: 'hook' }>(
    map,
    'p0/response/PostProxyFlowHook',
  );
  assert.deepEqual(
    [pre.sharedFlow, pre.revision, pre.sign, pre.facts],
    ['security-baseline', '2', undefined, ['Runs for every API proxy in eval']],
  );
  assert.deepEqual(
    [post.sharedFlow, post.revision, post.sign, post.facts],
    [
      'logging',
      '1',
      'differs',
      [
        'Runs for every API proxy in eval',
        'Continues on error',
        'Differs from the workspace',
      ],
    ],
  );

  // A FlowCallout names the revision the environment runs, or fails without one
  assert.deepEqual(find<FlowStep>(map, 'p0/request/proxy/pre/1').facts, [
    'Calls quota-per-app, which is not deployed in eval, so the call fails with flow.SharedFlowNotFound (500)',
  ]);
  deployed.set('quota-per-app', { revision: '1' });
  const [called] = flowView(await shopModel('orders-v1'), environment).maps;
  assert.deepEqual(find<FlowStep>(called, 'p0/request/proxy/pre/1').facts, [
    'Calls quota-per-app, revision 1 in eval',
  ]);

  // A target hook on a path without a target endpoint may not run
  const [status] = flowView(await shopModel('status'), {
    ...environment,
    hooks: { PreTargetFlowHook: { sharedFlow: 'security-baseline' } },
  }).maps;
  const target = find<FlowItem & { kind: 'hook' }>(
    status,
    'p0/request/PreTargetFlowHook',
  );
  assert.equal(target.sign, 'unknown');

  // The workspace has no environment, so no flow hooks
  const [local] = flowView(await shopModel('orders-v1'), {
    ...environment,
    environment: undefined,
  }).maps;
  assert.doesNotMatch(JSON.stringify(local), /"hook"/);
});

test('policies list the resources they name, outside comments and templates', () => {
  const model = proxy(
    '',
    policy(
      'Javascript',
      'JS',
      '',
      '<!-- <ResourceURL>jsc://old.js</ResourceURL> --><ResourceURL>jsc://links.js</ResourceURL><IncludeURL>jsc://helpers.js</IncludeURL><IncludeURL>jsc://links.js</IncludeURL><IncludeURL>jsc://{name}.js</IncludeURL>',
    ),
  );
  assert.deepEqual(model.policies.get('JS')?.resources, [
    'apiproxy/resources/jsc/links.js',
    'apiproxy/resources/jsc/helpers.js',
  ]);
});
