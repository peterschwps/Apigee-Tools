import { randomBytes } from 'node:crypto';
import path from 'node:path';
import * as vscode from 'vscode';
import {
  apiBase,
  ApigeeError,
  apigeeClient,
  applyStatus,
  loadOverview,
  loadRows,
  statusTargets,
  type ApigeeClient,
} from './apigee';
import {
  gcloudConfig,
  GcloudError,
  gcloudRunner,
  isConfigurationName,
  tokenSource,
  type TokenSource,
} from './gcloud';
import type {
  HostMessage,
  Kind,
  LocalBundle,
  Problem,
  Row,
  Snapshot,
  WebviewMessage,
} from './protocol';
import {
  bundleDirectory,
  compareBundles,
  differs,
  fingerprints,
  readBundle,
  unzip,
  type BundleFiles,
} from './revision';

/** A bundle in the workspace, with the findings of the linter. */
export type WorkspaceBundle = Omit<LocalBundle, 'path'> & {
  /** Absolute path of the `apiproxy` or `sharedflowbundle` directory. */
  directory: string;
  /** Absolute path of the top-level descriptor, if the bundle has one. */
  descriptor?: string;
};

/** What the dashboard needs from the rest of the extension. */
export type DashboardHost = {
  log: vscode.LogOutputChannel;
  /** Finds the bundles in the workspace and lints them. */
  scanWorkspace(): Promise<WorkspaceBundle[]>;
};

/** gcloud access, set up again on refresh and when settings change. */
type Session = {
  account?: string;
  project?: string;
  base: string;
  tokens: TokenSource;
};

const viewType = 'apigeeTools.dashboard';
const revisionScheme = 'apigee-revision';
const organizationKey = 'apigeeTools.organization';

// Status requests per load, a small share of the 6,000 management API calls
// per minute that an organization's users and pipelines share
const statusLimit = 200;

// Revisions whose files stay in memory for the comparison editors
const keptRevisions = 10;

/**
 * Registers the dashboard: its command, the restore after a restart, the
 * status bar entry, and the documents of deployed revisions.
 */
export function registerDashboard(
  context: vscode.ExtensionContext,
  host: DashboardHost,
): void {
  const webviewRoot = vscode.Uri.joinPath(
    context.extensionUri,
    'dist',
    'webview',
  );
  let panel: vscode.WebviewPanel | undefined;
  let ready = false;
  let snapshot: Snapshot = {
    trusted: vscode.workspace.isTrusted,
    requested: false,
    loading: false,
    organizations: [],
  };
  let bundles: WorkspaceBundle[] = [];
  let session: Session | undefined;
  let loading: AbortController | undefined;
  let postTimer: ReturnType<typeof setTimeout> | undefined;

  // Deployed revisions never change: files are kept for the last few, their
  // fingerprints for the whole session
  const revisions = new Map<string, Promise<BundleFiles>>();
  const prints = new Map<string, Promise<Map<string, string>>>();

  const statusItem = vscode.window.createStatusBarItem(
    viewType,
    vscode.StatusBarAlignment.Left,
  );
  statusItem.name = 'Apigee Tools Dashboard';
  statusItem.text = '$(dashboard) Apigee';
  statusItem.tooltip = 'Open the Apigee Tools dashboard';
  statusItem.command = 'apigeeTools.openDashboard';

  // Show the entry only where it is useful: in workspaces with bundles
  void vscode.workspace
    .findFiles('**/{apiproxy,sharedflowbundle}/*.xml', '**/node_modules/**', 1)
    .then(found => found.length && statusItem.show());

  context.subscriptions.push(
    statusItem,
    vscode.commands.registerCommand('apigeeTools.openDashboard', open),
    vscode.window.registerWebviewPanelSerializer(viewType, {
      // A restored panel waits for the user, so starting up stays offline
      deserializeWebviewPanel: async restored => {
        if (panel) restored.dispose();
        else attach(restored);
      },
    }),
    vscode.workspace.registerTextDocumentContentProvider(revisionScheme, {
      provideTextDocumentContent: revisionContent,
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      snapshot = { ...snapshot, trusted: true };
      post();
      if (snapshot.requested) void load();
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('apigeeTools')) session = undefined;
    }),
    { dispose: () => loading?.abort() },
  );

  /** Opens or reveals the dashboard and asks for data. */
  function open(): void {
    if (panel) panel.reveal();
    else {
      attach(
        vscode.window.createWebviewPanel(
          viewType,
          'Apigee Tools',
          vscode.ViewColumn.Active,
        ),
      );
    }
    if (snapshot.requested) return;
    snapshot = { ...snapshot, requested: true };
    // A new webview starts loading once its script reports ready
    if (ready) void load();
  }

  function attach(webviewPanel: vscode.WebviewPanel): void {
    panel = webviewPanel;
    ready = false;
    panel.iconPath = vscode.Uri.joinPath(
      context.extensionUri,
      'images',
      'icon.png',
    );
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [webviewRoot],
    };
    panel.webview.html = pageHtml(panel.webview, webviewRoot);
    const listener = panel.webview.onDidReceiveMessage(handle);
    panel.onDidDispose(() => {
      listener.dispose();
      loading?.abort();
      panel = undefined;
      ready = false;
      // Opening the dashboard again loads fresh data
      snapshot = {
        trusted: vscode.workspace.isTrusted,
        requested: false,
        loading: false,
        organizations: [],
      };
    });
  }

  /** Handles a message from the webview, which counts as untrusted input. */
  async function handle(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        ready = true;
        post();
        if (!snapshot.trusted) await scan();
        else if (
          snapshot.requested &&
          !snapshot.loading &&
          !snapshot.overview &&
          !snapshot.problem
        ) {
          await load();
        }
        break;
      case 'refresh':
        snapshot = { ...snapshot, requested: true };
        session = undefined;
        await load();
        break;
      case 'organization':
        if (
          snapshot.organizations.includes(message.name) &&
          message.name !== snapshot.organization
        ) {
          await context.workspaceState.update(organizationKey, message.name);
          snapshot = { ...snapshot, overview: undefined, rows: undefined };
          await load();
        }
        break;
      case 'compare':
        await compare(message.kind, message.name, message.environment);
        break;
      case 'openBundle': {
        const bundle = bundles.find(item => relative(item) === message.path);
        if (bundle) {
          await vscode.window.showTextDocument(
            vscode.Uri.file(bundle.descriptor ?? bundle.directory),
          );
        }
        break;
      }
      case 'signIn':
        signIn();
        break;
      case 'settings':
        await vscode.commands.executeCommand(
          'workbench.action.openSettings',
          'apigeeTools.gcloud',
        );
        break;
      case 'trust':
        await vscode.commands.executeCommand('workbench.trust.manage');
        break;
    }
  }

  /** Lints the workspace bundles for the restricted view. */
  async function scan(): Promise<void> {
    bundles = await host.scanWorkspace();
    snapshot = { ...snapshot, bundles: bundles.map(toLocalBundle) };
    post();
  }

  /**
   * Loads the organization, its deployments, and the workspace bundles, then
   * the deployment status and the differences from the local bundles.
   */
  async function load(): Promise<void> {
    if (!vscode.workspace.isTrusted) return;
    loading?.abort();
    const controller = new AbortController();
    loading = controller;
    snapshot = {
      ...snapshot,
      loading: true,
      problem: undefined,
      note: undefined,
    };
    post();
    try {
      session ??= await startSession();
      const client = apigeeClient(session.tokens, session.base, {
        signal: controller.signal,
      });
      const organizations: string[] = await client
        .organizations()
        .catch(error => {
          // Without permission to list organizations, the project may still work
          if (error instanceof ApigeeError && error.status === 403) return [];
          throw error;
        });
      const organization = chooseOrganization(organizations, session.project);
      if (!organization) {
        snapshot = {
          ...snapshot,
          account: session.account,
          problem: {
            reason: 'noOrganization',
            message: 'No Apigee organization was found for this account.',
            hint: 'Select the project of an Apigee organization with gcloud config set project, or ask for access to one.',
          },
        };
        return;
      }
      const [overview, rows, scanned] = await Promise.all([
        loadOverview(client, organization),
        loadRows(client, organization),
        host.scanWorkspace(),
      ]);
      if (controller.signal.aborted) return;
      bundles = scanned;
      for (const row of rows) row.local = Boolean(localBundle(row));
      snapshot = {
        ...snapshot,
        account: session.account,
        organizations: organizations.includes(organization)
          ? organizations
          : [organization, ...organizations],
        organization,
        overview,
        rows,
        bundles: bundles.map(toLocalBundle),
      };
      post();
      await Promise.all([
        checkStatus(client, organization, rows, controller),
        checkDrift(client, organization, rows, controller.signal),
      ]);
    } catch (error) {
      if (controller.signal.aborted) return;
      host.log.warn('Loading the dashboard failed:', messageOf(error));
      snapshot = { ...snapshot, problem: problemOf(error) };
    } finally {
      if (loading === controller) {
        loading = undefined;
        snapshot = { ...snapshot, loading: false };
        post();
      }
    }
  }

  async function startSession(): Promise<Session> {
    const settings = vscode.workspace.getConfiguration('apigeeTools');
    const gcloud = gcloudRunner(
      settings.get<string>('gcloudPath') || 'gcloud',
      settings.get<string>('gcloudConfiguration', ''),
    );
    const tokens = tokenSource(gcloud);
    // Reading the configuration and the token at once saves a second
    const [config] = await Promise.all([gcloudConfig(gcloud), tokens.token()]);
    return {
      account: config.account,
      project: config.project,
      base: apiBase(config.endpoint),
      tokens,
    };
  }

  /** Picks the last chosen organization, the gcloud project, or the first. */
  function chooseOrganization(
    organizations: string[],
    project?: string,
  ): string | undefined {
    const candidates = [
      context.workspaceState.get<string>(organizationKey),
      project,
    ];
    return (
      candidates.find(
        name => name && (!organizations.length || organizations.includes(name)),
      ) ?? organizations[0]
    );
  }

  /**
   * Loads the status of the deployments, local bundles and recent ones first.
   * An exhausted quota ends the load, so other users of the API keep theirs.
   */
  async function checkStatus(
    client: ApigeeClient,
    organization: string,
    rows: Row[],
    controller: AbortController,
  ): Promise<void> {
    const total = rows.reduce(
      (sum, row) => sum + Object.keys(row.cells).length,
      0,
    );
    const targets = statusTargets(rows, statusLimit);
    if (targets.length < total) {
      snapshot.note = `Status was checked for ${targets.length} of ${total} deployments, local bundles and recent deployments first, to spare the API quota.`;
    }
    await Promise.all(
      targets.map(async ({ row, environment }) => {
        const cell = row.cells[environment];
        try {
          applyStatus(
            cell,
            await client.deploymentStatus(
              organization,
              environment,
              row.kind,
              row.name,
              cell.revision,
            ),
          );
          schedulePost();
        } catch (error) {
          if (controller.signal.aborted) return;
          if (error instanceof ApigeeError && error.status === 429) {
            snapshot.note = `${error.message} ${error.hint ?? ''}`.trim();
            controller.abort();
            return;
          }
          host.log.warn(
            `Status of ${row.name} in ${environment}:`,
            messageOf(error),
          );
        }
      }),
    );
  }

  /** Marks the deployments that differ from the bundle in the workspace. */
  async function checkDrift(
    client: ApigeeClient,
    organization: string,
    rows: Row[],
    signal: AbortSignal,
  ): Promise<void> {
    await Promise.all(
      rows
        .filter(row => row.local)
        .map(async row => {
          const bundle = localBundle(row)!;
          try {
            const local = fingerprints(
              await readBundle(bundle.directory, row.kind),
            );
            await Promise.all(
              Object.values(row.cells).map(async cell => {
                const remote = await revisionPrints(
                  client,
                  organization,
                  row,
                  cell.revision,
                );
                cell.drift = differs(remote, local);
                schedulePost();
              }),
            );
          } catch (error) {
            if (!signal.aborted) {
              host.log.warn(
                `Comparing ${row.name} with the local bundle:`,
                messageOf(error),
              );
            }
          }
        }),
    );
  }

  /** Downloads a revision once; the last few stay for comparisons. */
  function revisionFiles(
    client: ApigeeClient,
    organization: string,
    row: Pick<Row, 'kind' | 'name'>,
    revision: string,
  ): Promise<BundleFiles> {
    const key = revisionKey(organization, row.kind, row.name, revision);
    let files = revisions.get(key);
    if (!files) {
      files = client
        .bundle(organization, row.kind, row.name, revision)
        .then(unzip);
      files.catch(() => revisions.delete(key));
    }

    // Keep the most recently used revisions last, and only a few of them
    revisions.delete(key);
    revisions.set(key, files);
    for (const oldest of revisions.keys()) {
      if (revisions.size <= keptRevisions) break;
      revisions.delete(oldest);
    }
    return files;
  }

  function revisionPrints(
    client: ApigeeClient,
    organization: string,
    row: Row,
    revision: string,
  ): Promise<Map<string, string>> {
    const key = revisionKey(organization, row.kind, row.name, revision);
    let result = prints.get(key);
    if (!result) {
      result = revisionFiles(client, organization, row, revision).then(
        fingerprints,
      );
      prints.set(key, result);
      result.catch(() => prints.delete(key));
    }
    return result;
  }

  /** Opens the files that differ between a deployment and the local bundle. */
  async function compare(
    kind: Kind,
    name: string,
    environment: string,
  ): Promise<void> {
    const row = snapshot.rows?.find(
      item => item.kind === kind && item.name === name,
    );
    const cell = row?.cells[environment];
    const bundle = row && localBundle(row);
    const organization = snapshot.organization;
    if (!row || !cell || !bundle || !session || !organization) return;
    try {
      const client = apigeeClient(session.tokens, session.base);
      const remote = await revisionFiles(
        client,
        organization,
        row,
        cell.revision,
      );
      const local = await readBundle(bundle.directory, kind);
      const { changed, added, removed } = compareBundles(
        fingerprints(remote),
        fingerprints(local),
      );
      if (!changed.length && !added.length && !removed.length) {
        void vscode.window.showInformationMessage(
          `Revision ${cell.revision} of ${name} in ${environment} matches the local bundle.`,
        );
        return;
      }
      const remoteUri = (file: string) =>
        vscode.Uri.from({
          scheme: revisionScheme,
          path: `/${revisionKey(organization, kind, name, cell.revision)}/${file}`,
        });
      const localUri = (file: string) =>
        vscode.Uri.file(
          path.join(
            bundle.directory,
            file.slice(bundleDirectory(kind).length + 1),
          ),
        );
      await vscode.commands.executeCommand(
        'vscode.changes',
        `${name}: revision ${cell.revision} in ${environment} ↔ local`,
        [
          ...changed.map(file => [
            localUri(file),
            remoteUri(file),
            localUri(file),
          ]),
          ...added.map(file => [localUri(file), undefined, localUri(file)]),
          ...removed.map(file => [remoteUri(file), remoteUri(file), undefined]),
        ],
      );
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Comparing ${name} with the local bundle failed: ${messageOf(error)}`,
      );
    }
  }

  /** Serves a file of a deployed revision from memory. */
  async function revisionContent(uri: vscode.Uri): Promise<string> {
    const [organization, kind, name, revision, ...file] = uri.path
      .slice(1)
      .split('/');
    const files = await revisions
      .get(revisionKey(organization, kind as Kind, name, revision))
      ?.catch(() => undefined);
    return (
      files?.get(file.join('/'))?.toString('utf8') ??
      'This revision is no longer in memory. Use "Compare with local" in the Apigee Tools dashboard again.'
    );
  }

  /** Starts `gcloud auth login` in a terminal, where it can open a browser. */
  function signIn(): void {
    const settings = vscode.workspace.getConfiguration('apigeeTools');
    const gcloud = settings.get<string>('gcloudPath') || 'gcloud';
    const configuration = settings.get<string>('gcloudConfiguration', '');
    // ponytail: quotes suit bash, zsh, and PowerShell; cmd.exe users type it
    const command =
      gcloud === 'gcloud'
        ? 'gcloud'
        : process.platform === 'win32'
          ? `& "${gcloud}"`
          : `"${gcloud}"`;
    const flag = isConfigurationName(configuration)
      ? ` --configuration=${configuration}`
      : '';
    const terminal = vscode.window.createTerminal('gcloud auth login');
    terminal.show();
    terminal.sendText(`${command} auth login${flag}`);
  }

  function localBundle(row: Pick<Row, 'kind' | 'name'>) {
    return bundles.find(
      bundle => bundle.kind === row.kind && bundle.name === row.name,
    );
  }

  function post(): void {
    clearTimeout(postTimer);
    postTimer = undefined;
    if (!panel || !ready) return;
    const message: HostMessage = { type: 'snapshot', snapshot };
    void panel.webview.postMessage(message);
  }

  /** Posts at most every 100 ms while statuses and differences arrive. */
  function schedulePost(): void {
    postTimer ??= setTimeout(post, 100);
  }
}

/** Returns the page with a strict content security policy. */
function pageHtml(webview: vscode.Webview, root: vscode.Uri): string {
  const nonce = randomBytes(16).toString('base64');
  const asset = (file: string) =>
    webview.asWebviewUri(vscode.Uri.joinPath(root, file)).toString();
  const policy = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
  ].join('; ');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="${policy}">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" id="vscode-codicon-stylesheet" href="${asset('codicon.css')}">
    <link rel="stylesheet" href="${asset('main.css')}">
    <title>Apigee Tools</title>
  </head>
  <body>
    <apigee-dashboard></apigee-dashboard>
    <script nonce="${nonce}" src="${asset('main.js')}"></script>
  </body>
</html>`;
}

function revisionKey(
  organization: string,
  kind: Kind,
  name: string,
  revision: string,
): string {
  return `${organization}/${kind}/${name}/${revision}`;
}

function relative(bundle: WorkspaceBundle): string {
  return vscode.workspace.asRelativePath(bundle.directory);
}

function toLocalBundle(bundle: WorkspaceBundle): LocalBundle {
  const { kind, name, errors, warnings } = bundle;
  return { kind, name, path: relative(bundle), errors, warnings };
}

/** Explains an error in terms of what the user can do about it. */
function problemOf(error: unknown): Problem {
  if (error instanceof GcloudError && error.reason === 'missing') {
    const remote = vscode.env.remoteName
      ? ` It has to run where the extension runs (${vscode.env.remoteName}).`
      : '';
    return {
      reason: 'gcloudMissing',
      message: 'The Google Cloud CLI (gcloud) was not found.',
      hint: `Install it, or set apigeeTools.gcloudPath to its location.${remote}`,
    };
  }
  if (
    (error instanceof GcloudError && error.reason === 'signedOut') ||
    (error instanceof ApigeeError && error.status === 401)
  ) {
    return {
      reason: 'signedOut',
      message: 'gcloud is not signed in.',
      hint: 'Sign in with gcloud auth login, then try again.',
    };
  }
  return {
    reason: 'api',
    message: messageOf(error),
    hint: error instanceof ApigeeError ? error.hint : undefined,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
