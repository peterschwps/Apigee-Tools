import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as vscode from 'vscode';

const source = 'Apigee Tools';
const gcloudLog = process.env.APIGEE_TOOLS_GCLOUD_LOG ?? '';
const revisionZip = process.env.APIGEE_TOOLS_REVISION_ZIP ?? '';
const bundlePath =
  '/v1/organizations/acme/apis/hello/revisions/1?format=bundle';
const statusPath =
  '/v1/organizations/acme/environments/dev/apis/hello/revisions/1/deployments';
// The shared flow attached to the Pre-Proxy flow hook of dev
const sharedFlowZip = revisionZip.replace(/revision\.zip$/, 'sharedflow.zip');
const sharedFlowPath =
  '/v1/organizations/acme/sharedflows/traffic-shared/revisions/1?format=bundle';

// Responses of a small fake organization, by path and query
const apigee: Record<string, unknown> = {
  '/v1/organizations': { organizations: [{ organization: 'acme' }] },
  '/v1/organizations/acme': {
    name: 'acme',
    projectId: 'acme',
    runtimeType: 'CLOUD',
    environments: ['dev'],
  },
  '/v1/organizations/acme/environments/dev': { name: 'dev', type: 'BASE' },
  '/v1/organizations/acme/envgroups': {
    environmentGroups: [{ name: 'public', hostnames: ['api.example.com'] }],
  },
  '/v1/organizations/acme/envgroups/public/attachments': {
    environmentGroupAttachments: [{ environment: 'dev' }],
  },
  '/v1/organizations/acme/apis': { proxies: [{ name: 'hello' }] },
  '/v1/organizations/acme/sharedflows': {
    sharedFlows: [{ name: 'traffic-shared' }],
  },
  '/v1/organizations/acme/deployments?sharedFlows=false': {
    deployments: [
      {
        environment: 'dev',
        apiProxy: 'hello',
        revision: '1',
        deployStartTime: '1700000000000',
      },
    ],
  },
  '/v1/organizations/acme/deployments?sharedFlows=true': {
    deployments: [
      {
        environment: 'dev',
        apiProxy: 'traffic-shared',
        revision: '1',
        deployStartTime: '1700000000000',
      },
    ],
  },
  [statusPath]: { state: 'READY' },
  '/v1/organizations/acme/environments/dev/sharedflows/traffic-shared/revisions/1/deployments':
    { state: 'READY' },
  // Only the Pre-Proxy flow hook of dev has a shared flow attached
  ...Object.fromEntries(
    [
      'PreProxyFlowHook',
      'PreTargetFlowHook',
      'PostTargetFlowHook',
      'PostProxyFlowHook',
    ].map(point => [
      `/v1/organizations/acme/environments/dev/flowhooks/${point}`,
      point === 'PreProxyFlowHook' ? { sharedFlow: 'traffic-shared' } : {},
    ]),
  ),
};

/** Returns the recorded calls of the fake gcloud, none if it never ran. */
function gcloudCalls(): string[] {
  return existsSync(gcloudLog)
    ? readFileSync(gcloudLog, 'utf8').trim().split('\n')
    : [];
}

function workspaceFile(...segments: string[]): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'expected an open workspace folder');
  return vscode.Uri.joinPath(folder.uri, ...segments);
}

function ruleOf(diagnostic: vscode.Diagnostic): string {
  return typeof diagnostic.code === 'object'
    ? String(diagnostic.code.value)
    : String(diagnostic.code);
}

function linterDiagnostic(
  uri: vscode.Uri,
  rule: string,
): vscode.Diagnostic | undefined {
  return vscode.languages
    .getDiagnostics(uri)
    .find(
      diagnostic => diagnostic.source === source && ruleOf(diagnostic) === rule,
    );
}

async function waitFor<T>(
  label: string,
  probe: () => T | undefined | false,
): Promise<T> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const value = probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${label}.`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function open(...segments: string[]): Promise<vscode.TextDocument> {
  const document = await vscode.workspace.openTextDocument(
    workspaceFile(...segments),
  );
  await vscode.window.showTextDocument(document);
  return document;
}

async function quickFix(
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic,
  title: string,
): Promise<vscode.CodeAction> {
  const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
    'vscode.executeCodeActionProvider',
    document.uri,
    diagnostic.range,
  );
  const action = actions.find(item => item.title === title);
  assert.ok(
    action?.edit,
    `expected quick fix "${title}" among: ${actions.map(item => item.title).join(', ')}`,
  );
  return action;
}

const tests: [string, () => Promise<void>][] = [
  [
    'reports AX105 as an error with a documentation link',
    async () => {
      const document = await open('apiproxy', 'policies', 'FC-Typo.xml');
      const diagnostic = await waitFor('AX105', () =>
        linterDiagnostic(document.uri, 'AX105'),
      );
      assert.equal(diagnostic.severity, vscode.DiagnosticSeverity.Error);
      assert.equal(document.getText(diagnostic.range), 'flase');
      assert.match(diagnostic.message, /Did you mean "false"\?/);
      const target =
        typeof diagnostic.code === 'object'
          ? diagnostic.code.target.toString()
          : '';
      assert.match(target, /^https:\/\/docs\.cloud\.google\.com\/apigee\//);
    },
  ],
  [
    'quick fix replaces a mistyped enum value',
    async () => {
      const document = await open('apiproxy', 'policies', 'FC-Typo.xml');
      const diagnostic = await waitFor('AX105', () =>
        linterDiagnostic(document.uri, 'AX105'),
      );
      const action = await quickFix(document, diagnostic, 'Change to "false"');
      assert.ok(await vscode.workspace.applyEdit(action.edit!));
      assert.match(document.getText(), /enabled="false"/);
      await waitFor(
        'AX105 to clear',
        () => !linterDiagnostic(document.uri, 'AX105') && true,
      );
    },
  ],
  [
    'quick fix inserts a disable comment that suppresses the diagnostic',
    async () => {
      const document = await open('apiproxy', 'policies', 'FC-Disable.xml');
      const diagnostic = await waitFor('AX101', () =>
        linterDiagnostic(document.uri, 'AX101'),
      );
      const action = await quickFix(
        document,
        diagnostic,
        'Disable AX101 for this line',
      );
      assert.ok(await vscode.workspace.applyEdit(action.edit!));
      assert.match(
        document.getText(),
        /\n {2}<!-- apigee-tools disable=AX101 -->\n {2}<Bogus\/>/,
      );
      await waitFor(
        'AX101 to clear',
        () => !linterDiagnostic(document.uri, 'AX101') && true,
      );
    },
  ],
  [
    'completes bundle policy names inside Step/Name',
    async () => {
      const document = await open('apiproxy', 'proxies', 'default.xml');
      const position = document.positionAt(
        document.getText().indexOf('<Name>') + '<Name>'.length,
      );
      const list = await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        position,
      );
      const labels = list.items.map(item =>
        typeof item.label === 'string' ? item.label : item.label.label,
      );
      assert.ok(
        labels.includes('FC-Typo') && labels.includes('FC-Disable'),
        `unexpected completions: ${labels.join(', ')}`,
      );
    },
  ],
  [
    'activation runs no gcloud command',
    async () => {
      assert.deepEqual(gcloudCalls(), []);
    },
  ],
  [
    'Show Flow opens the flow as a tab of the editor group without gcloud or the network',
    async () => {
      // Before the dashboard ran, so no session exists that it could reuse
      const requests: string[] = [];
      const original = globalThis.fetch;
      globalThis.fetch = async input => {
        requests.push(String(input));
        return new Response('{}', { status: 404 });
      };
      try {
        const document = await open(
          'hello',
          'apiproxy',
          'proxies',
          'default.xml',
        );
        const column = vscode.window.activeTextEditor?.viewColumn;
        await vscode.commands.executeCommand(
          'apigeeTools.showFlow',
          document.uri,
        );
        const tab = await waitFor('the flow tab', () =>
          vscode.window.tabGroups.all
            .flatMap(group => group.tabs)
            .find(
              item =>
                item.input instanceof vscode.TabInputWebview &&
                item.input.viewType.endsWith('apigeeTools.flow'),
            ),
        );
        assert.equal(tab.label, 'Flow · hello');
        // In the editor's group, in front, so that files open beside it
        assert.equal(tab.group.viewColumn, column);
        assert.ok(tab.isActive);
        assert.deepEqual(gcloudCalls(), []);
        assert.deepEqual(requests, []);
      } finally {
        globalThis.fetch = original;
      }
    },
  ],
  [
    'the dashboard loads deployments through gcloud and the Apigee API',
    async () => {
      // The fake gcloud is a shell script, which Windows cannot run
      if (process.platform === 'win32') {
        console.log('  skipped on Windows: the fake gcloud is a shell script');
        return;
      }
      // The extension shares the global fetch of the extension host
      const requests: { path: string; authorization?: string }[] = [];
      const original = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        const path = `${url.pathname}${url.search}`;
        const headers = init?.headers as Record<string, string> | undefined;
        requests.push({ path, authorization: headers?.authorization });
        if (path === bundlePath) return new Response(readFileSync(revisionZip));
        const body = apigee[path];
        return new Response(JSON.stringify(body ?? {}), {
          status: body ? 200 : 404,
          headers: { 'content-type': 'application/json' },
        });
      };
      try {
        await vscode.commands.executeCommand('apigeeTools.openDashboard');
        const paths = () => requests.map(request => request.path);
        await waitFor('the deployment status', () =>
          paths().includes(statusPath),
        );
        await waitFor('the revision bundle', () =>
          paths().includes(bundlePath),
        );
        const tab = vscode.window.tabGroups.all
          .flatMap(group => group.tabs)
          .find(
            item =>
              item.input instanceof vscode.TabInputWebview &&
              item.input.viewType.endsWith('apigeeTools.dashboard'),
          );
        assert.ok(tab, 'expected the dashboard tab');
        assert.ok(
          requests.every(
            request => request.authorization === 'Bearer ya29.integration',
          ),
          'expected every request to carry the gcloud token',
        );
        // The Relationships tab reads its lists only once it is opened
        const relationshipPaths = paths().filter(path =>
          /\/(apiproducts|developers|apps|appgroups)(\?|$)|\/flowhooks\//.test(
            path,
          ),
        );
        assert.deepEqual(relationshipPaths, []);
        assert.deepEqual(
          gcloudCalls()
            .map(call => call.split(' ').slice(0, 2).join(' '))
            .sort(),
          ['auth print-access-token', 'config list'],
        );
      } finally {
        globalThis.fetch = original;
      }
    },
  ],
  [
    'the flow of an environment reads its flow hooks and their shared flows',
    async () => {
      // The dashboard test before loaded the organization through the fake gcloud
      if (process.platform === 'win32') {
        console.log('  skipped on Windows: the fake gcloud is a shell script');
        return;
      }
      const calls = gcloudCalls().length;
      const requests: string[] = [];
      const original = globalThis.fetch;
      globalThis.fetch = async input => {
        const url = new URL(String(input));
        const path = `${url.pathname}${url.search}`;
        requests.push(path);
        if (path === sharedFlowPath) {
          return new Response(readFileSync(sharedFlowZip));
        }
        const body = apigee[path];
        return new Response(JSON.stringify(body ?? {}), {
          status: body ? 200 : 404,
          headers: { 'content-type': 'application/json' },
        });
      };
      try {
        await vscode.commands.executeCommand('apigeeTools.showFlow', {
          kind: 'apis',
          name: 'hello',
          environment: 'dev',
        });
        const hooks = Object.keys(apigee).filter(path =>
          path.includes('/flowhooks/'),
        );
        await waitFor('the flow hooks and the shared flow', () =>
          [...hooks, sharedFlowPath].every(path => requests.includes(path)),
        );
        // The proxy's revision is still in memory from the dashboard's comparison
        assert.deepEqual(
          [...requests].sort(),
          [...hooks, sharedFlowPath].sort(),
        );
        assert.equal(gcloudCalls().length, calls);
      } finally {
        globalThis.fetch = original;
      }
    },
  ],
];

export async function run(): Promise<void> {
  const failures: string[] = [];
  for (const [name, body] of tests) {
    try {
      await body();
      console.log(`✔ ${name}`);
    } catch (error) {
      failures.push(name);
      console.error(`✖ ${name}\n`, error);
    }
  }
  if (failures.length)
    throw new Error(
      `${failures.length} of ${tests.length} integration tests failed.`,
    );
}
