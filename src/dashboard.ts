import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { watch } from 'node:fs';
import { homedir } from 'node:os';
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
  gcloudCommand,
  gcloudConfig,
  GcloudError,
  gcloudInvocation,
  gcloudRunner,
  isConfigurationName,
  tokenSource,
  type TokenSource,
} from './gcloud';
import type {
  Cell,
  HostMessage,
  Kind,
  LocalBundle,
  Note,
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

/** A bundle in the workspace. */
export type WorkspaceBundle = Omit<LocalBundle, 'path'> & {
  /** Absolute path of the `apiproxy` or `sharedflowbundle` directory. */
  directory: string;
  /** Absolute path of the top-level descriptor, if the bundle has one. */
  descriptor?: string;
};

/** What the dashboard needs from the rest of the extension. */
export type DashboardHost = {
  log: vscode.LogOutputChannel;
  /** Finds the bundles in the workspace. */
  scanWorkspace(): Promise<WorkspaceBundle[]>;
};

/** GCloud access, set up again on refresh and when settings change. */
type Session = {
  account?: string;
  project?: string;
  base: string;
  tokens: TokenSource;
};

const viewType = 'apigeeTools.dashboard';
const revisionScheme = 'apigee-revision';
const organizationKey = 'apigeeTools.organization';

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
  let dataController: AbortController | undefined;
  let dataClient: ApigeeClient | undefined;
  let selectedEnvironment = '';
  let environmentLoads = new Map<string, Promise<void>>();
  let pendingChecks = 0;
  // A resolved request also remembers an explicitly unknown runtime state.
  const statusRequests = new WeakMap<Cell, Promise<void>>();
  // The organization chosen in the selector; only such a choice is remembered
  let picked: string | undefined;
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
    { dispose: () => dataController?.abort() },
  );

  // While developing, esbuild rebuilds the webview on every change, and the
  // dashboard reloads at once and keeps its data; esbuild stops with this host,
  // whose end closes its standard input
  if (context.extensionMode === vscode.ExtensionMode.Development) {
    const windows = process.platform === 'win32';
    const build = spawn(
      windows ? 'npm.cmd' : 'npm',
      ['run', 'build:webview', '--', '--watch'],
      {
        cwd: context.extensionPath,
        stdio: ['pipe', 'ignore', 'pipe'],
        shell: windows,
      },
    );
    build.stderr.on('data', chunk => host.log.info(String(chunk).trim()));
    build.on('error', error =>
      host.log.warn('Watching the dashboard sources failed:', messageOf(error)),
    );
    let reload: ReturnType<typeof setTimeout> | undefined;
    const watcher = watch(webviewRoot.fsPath, () => {
      clearTimeout(reload);
      reload = setTimeout(() => {
        if (!panel) return;
        ready = false;
        panel.webview.html = pageHtml(panel.webview, webviewRoot);
      }, 300);
    });
    context.subscriptions.push({
      dispose: () => {
        clearTimeout(reload);
        watcher.close();
        build.kill();
      },
    });
  }

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
      dataController?.abort();
      dataController = undefined;
      dataClient = undefined;
      loading = undefined;
      environmentLoads = new Map();
      pendingChecks = 0;
      panel = undefined;
      ready = false;
      picked = undefined;
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
        selectedEnvironment = message.environment ?? selectedEnvironment;
        post();
        if (
          snapshot.trusted &&
          snapshot.requested &&
          !snapshot.loading &&
          !snapshot.overview &&
          !snapshot.problem
        ) {
          await load();
        } else if (snapshot.requested) {
          await checkEnvironment(selectedEnvironment);
        }
        break;
      case 'refresh':
        snapshot = { ...snapshot, requested: true };
        session = undefined;
        await load();
        break;
      case 'organization':
        // Compare with the requested organization, which may still be loading
        if (
          snapshot.organizations.includes(message.name) &&
          message.name !== snapshot.organization
        ) {
          picked = message.name;
          snapshot = {
            ...snapshot,
            organization: message.name,
            overview: undefined,
            rows: undefined,
          };
          await load();
        }
        break;
      case 'environment':
        if (
          message.organization === snapshot.organization &&
          snapshot.overview?.environments.some(
            item => item.name === message.name,
          )
        ) {
          selectedEnvironment = message.name;
          await checkEnvironment(message.name);
        }
        break;
      case 'compare':
        await compare(message.kind, message.name, message.environment);
        break;
      case 'details':
        await checkDetails(message.kind, message.name);
        break;
      case 'openBundle': {
        const bundle = bundles.find(item => relative(item) === message.path);
        try {
          if (bundle?.descriptor) {
            await vscode.window.showTextDocument(
              vscode.Uri.file(bundle.descriptor),
            );
          } else if (bundle) {
            await vscode.commands.executeCommand(
              'revealInExplorer',
              vscode.Uri.file(bundle.directory),
            );
          }
        } catch (error) {
          void vscode.window.showErrorMessage(
            `Opening ${bundle?.name} failed: ${messageOf(error)}`,
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

  /**
   * Loads the organization, its deployments, and the workspace bundles, then
   * the deployment status and the differences from the local bundles.
   */
  async function load(): Promise<void> {
    if (!vscode.workspace.isTrusted) return;
    dataController?.abort();
    const controller = new AbortController();
    loading = controller;
    dataController = controller;
    dataClient = undefined;
    environmentLoads = new Map();
    pendingChecks = 0;
    // Each load has notes of its own, so an aborted load cannot add to them
    const notes: Note[] = [];
    snapshot = {
      ...snapshot,
      loading: true,
      problem: undefined,
      notes,
    };
    post();
    try {
      // A settings change may reset the session while this load runs
      const current = (session ??= await startSession());
      if (controller.signal.aborted) return;
      const client = apigeeClient(current.tokens, current.base, {
        signal: controller.signal,
      });
      dataClient = client;
      const organizations: string[] = await client
        .organizations()
        .catch(error => {
          // Without permission to list organizations, the project may still work
          if (error instanceof ApigeeError && error.status === 403) return [];
          throw error;
        });
      const organization = chooseOrganization(organizations, current.project);
      if (!organization) {
        snapshot = {
          ...snapshot,
          account: current.account,
          organizations: [],
          organization: undefined,
          overview: undefined,
          rows: undefined,
          problem: {
            reason: 'noOrganization',
            message: 'No Apigee organization was found for this account.',
            hint: 'Select the project of an Apigee organization with gcloud config set project, or ask for access to one.',
          },
        };
        return;
      }

      // An organization guessed from the GCloud project may not exist, and
      // Apigee answers 403 for missing organizations too
      if (!organizations.includes(organization)) {
        const missing = await client.organization(organization).then(
          () => false,
          error => {
            if (error instanceof ApigeeError && error.status === 403)
              return true;
            throw error;
          },
        );
        if (missing) {
          snapshot = {
            ...snapshot,
            account: current.account,
            organizations: [],
            organization: undefined,
            overview: undefined,
            rows: undefined,
            problem: {
              reason: 'noOrganization',
              message: `No Apigee organization was found for project ${organization}.`,
              hint: 'Select the project of an Apigee organization with gcloud config set project, or ask for a role such as Apigee Read-only Admin (roles/apigee.readOnlyAdmin).',
            },
          };
          return;
        }
      }

      // Publish the choice first, so the selector stays if loading it fails;
      // data of another organization or account must not stay next to it
      const changed =
        organization !== snapshot.organization ||
        current.account !== snapshot.account;
      snapshot = {
        ...snapshot,
        ...(changed && { overview: undefined, rows: undefined }),
        account: current.account,
        organizations: organizations.includes(organization)
          ? organizations
          : [organization, ...organizations],
        organization,
      };
      post();
      const [overview, rows, scanned] = await Promise.all([
        loadOverview(client, organization),
        loadRows(client, organization),
        host.scanWorkspace(),
      ]);
      if (controller.signal.aborted) return;
      bundles = scanned;
      for (const row of rows) row.local = Boolean(localBundle(row));
      const ambiguous = rows.filter(row => localBundles(row).length > 1);
      if (ambiguous.length) {
        notes.push({
          tone: 'warning',
          text: `Several bundles in the workspace are named ${ambiguous.map(row => `"${row.name}"`).join(', ')}, so they are not compared. Exclude the extra copies with apigeeTools.exclude.`,
        });
      }
      snapshot = {
        ...snapshot,
        overview,
        rows,
        bundles: bundles.map(toLocalBundle),
      };
      post();

      // Only an organization chosen in the selector that loaded is remembered
      if (organization === picked) {
        await context.workspaceState.update(organizationKey, organization);
      }
      if (
        !overview.environments.some(item => item.name === selectedEnvironment)
      ) {
        selectedEnvironment = overview.environments[0]?.name ?? '';
      }
      await checkEnvironment(selectedEnvironment);
    } catch (error) {
      if (controller.signal.aborted) return;
      host.log.warn('Loading the dashboard failed:', messageOf(error));
      snapshot = { ...snapshot, problem: problemOf(error) };
    } finally {
      if (loading === controller) {
        loading = undefined;
        snapshot = { ...snapshot, loading: pendingChecks > 0 };
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

  /**
   * Picks the organization chosen in the selector, then the last chosen one
   * that loaded, the GCloud project, or the first listed. Without a list,
   * which the account may not be allowed to read, the project comes first.
   */
  function chooseOrganization(
    organizations: string[],
    project?: string,
  ): string | undefined {
    const stored = context.workspaceState.get<string>(organizationKey);
    if (!organizations.length) return project ?? picked ?? stored;
    return (
      [picked, stored, project].find(
        name => name && organizations.includes(name),
      ) ?? organizations[0]
    );
  }

  /** Loads each selected environment once until Refresh replaces its cells. */
  function checkEnvironment(environment: string): Promise<void> {
    const existing = environmentLoads.get(environment);
    if (existing) return existing;
    const { organization, rows, overview } = snapshot;
    const controller = dataController;
    const client = dataClient;
    if (
      !snapshot.trusted ||
      !snapshot.requested ||
      !organization ||
      !rows ||
      !controller ||
      controller.signal.aborted ||
      !client ||
      !overview?.environments.some(item => item.name === environment)
    ) {
      return Promise.resolve();
    }
    const notes = snapshot.notes ?? [];
    const task = (async () => {
      pendingChecks++;
      snapshot = { ...snapshot, loading: true };
      post();
      try {
        await Promise.all([
          checkStatus(
            client,
            organization,
            rows,
            environment,
            controller,
            notes,
          ),
          checkDrift(
            client,
            organization,
            rows,
            environment,
            controller,
            notes,
          ),
        ]);
      } catch (error) {
        if (!controller.signal.aborted) {
          notes.push({
            tone: 'warning',
            text: `Loading environment "${environment}" failed: ${messageOf(error)}`,
          });
        }
      } finally {
        if (dataController === controller) {
          pendingChecks--;
          snapshot = {
            ...snapshot,
            loading: Boolean(loading || pendingChecks),
          };
          post();
        }
      }
    })();
    environmentLoads.set(environment, task);
    return task;
  }

  /** Shares status requests between environment loads and resource details. */
  function readStatus(
    client: ApigeeClient,
    organization: string,
    row: Row,
    environment: string,
  ): Promise<void> {
    const cell = row.cells[environment];
    let request = statusRequests.get(cell);
    if (!request) {
      request = client
        .deploymentStatus(
          organization,
          environment,
          row.kind,
          row.name,
          cell.revision,
        )
        .then(status => {
          applyStatus(cell, status);
          schedulePost();
        });
      statusRequests.set(cell, request);
      request.catch(() => statusRequests.delete(cell));
    }
    return request;
  }

  /**
   * Loads every deployment status in the selected environment.
   * A network failure or an exhausted quota stops the remaining requests, so
   * the dashboard neither waits for timeouts nor uses up the quota of others.
   */
  async function checkStatus(
    client: ApigeeClient,
    organization: string,
    rows: Row[],
    environment: string,
    controller: AbortController,
    notes: Note[],
  ): Promise<void> {
    const targets = statusTargets(rows, environment);
    let failed = 0;
    let firstFailure: unknown;
    let stopped: ApigeeError | undefined;
    await Promise.all(
      targets.map(async ({ row, environment }) => {
        try {
          await readStatus(client, organization, row, environment);
        } catch (error) {
          if (controller.signal.aborted) return;
          if (
            error instanceof ApigeeError &&
            (error.status === undefined || error.status === 429)
          ) {
            stopped = error;
            controller.abort();
            return;
          }
          failed++;
          firstFailure ??= error;
          host.log.warn(
            `Status of ${row.name} in ${environment}:`,
            messageOf(error),
          );
        }
      }),
    );
    if (stopped) {
      notes.push({
        tone: 'warning',
        text: `Status checks stopped: ${stopped.message} ${stopped.hint ?? ''}`.trim(),
      });
    } else if (failed) {
      const hint =
        firstFailure instanceof ApigeeError
          ? ` ${firstFailure.hint ?? ''}`
          : '';
      notes.push({
        tone: 'warning',
        text: `Status could not be checked for ${failed} deployments: ${messageOf(firstFailure)}${hint}`.trim(),
      });
    }
  }

  /** Loads missing status values across environments when details are opened. */
  async function checkDetails(kind: Kind, name: string): Promise<void> {
    const row = snapshot.rows?.find(
      item => item.kind === kind && item.name === name,
    );
    const organization = snapshot.organization;
    const controller = dataController;
    const client = dataClient;
    if (
      !row ||
      !organization ||
      !controller ||
      controller.signal.aborted ||
      !client
    )
      return;
    const missing = Object.keys(row.cells).filter(
      environment => !row.cells[environment].state,
    );
    if (!missing.length) return;
    const notes = snapshot.notes ?? [];
    pendingChecks++;
    snapshot = { ...snapshot, loading: true };
    post();
    try {
      await Promise.all(
        missing.map(async environment => {
          try {
            await readStatus(client, organization, row, environment);
          } catch (error) {
            if (controller.signal.aborted) return;
            host.log.warn(
              `Status of ${name} in ${environment}:`,
              messageOf(error),
            );
            notes.push({
              tone: 'warning',
              text: `Status of "${name}" in ${environment} could not be checked: ${messageOf(error)}`,
            });
          }
        }),
      );
    } finally {
      if (dataController === controller) {
        pendingChecks--;
        snapshot = { ...snapshot, loading: Boolean(loading || pendingChecks) };
        post();
      }
    }
  }

  /**
   * Marks the deployments that differ from the bundle in the workspace. Like
   * the status checks, it stops on a network failure or an exhausted quota.
   */
  async function checkDrift(
    client: ApigeeClient,
    organization: string,
    rows: Row[],
    environment: string,
    controller: AbortController,
    notes: Note[],
  ): Promise<void> {
    const failed: string[] = [];
    let firstFailure: unknown;
    await Promise.all(
      rows
        .filter(row => row.local && row.cells[environment])
        .map(async row => {
          const bundle = localBundle(row)!;
          try {
            const local = fingerprints(
              await readBundle(bundle.directory, row.kind),
            );
            const cell = row.cells[environment];
            const remote = await revisionPrints(
              client,
              organization,
              row,
              cell.revision,
            );
            cell.drift = differs(remote, local);
            schedulePost();
          } catch (error) {
            if (controller.signal.aborted) return;
            host.log.warn(
              `Comparing ${row.name} with the local bundle:`,
              messageOf(error),
            );
            failed.push(row.name);
            firstFailure ??= error;
            if (
              error instanceof ApigeeError &&
              (error.status === undefined || error.status === 429)
            ) {
              controller.abort();
            }
          }
        }),
    );
    if (failed.length) {
      notes.push({
        tone: 'warning',
        text: `Differences from the local bundle could not be checked for ${failed.map(name => `"${name}"`).join(', ')}: ${messageOf(firstFailure)}`,
      });
    }
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
    if (!row || !cell || !bundle || !organization) return;
    try {
      const current = (session ??= await startSession());
      const client = apigeeClient(current.tokens, current.base);

      // An aborted load may have shared the download; then fetch it again
      const download = () =>
        revisionFiles(client, organization, row, cell.revision);
      const remote = await download().catch(error => {
        if ((error as Error)?.name !== 'AbortError') throw error;
        return download();
      });
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
      'This revision is no longer in memory. Open the comparison again from the Apigee Tools dashboard.'
    );
  }

  /**
   * Starts `gcloud auth login` in a terminal, where it can open a browser.
   * GCloud runs directly, so no shell interprets the configured path; on
   * Windows, cmd.exe runs `gcloud.cmd`. The home directory keeps cmd.exe from
   * running a `gcloud.cmd` of the workspace.
   */
  function signIn(): void {
    const settings = vscode.workspace.getConfiguration('apigeeTools');
    const configuration = settings.get<string>('gcloudConfiguration', '');
    const args = [
      'auth',
      'login',
      ...(isConfigurationName(configuration)
        ? [`--configuration=${configuration}`]
        : []),
    ];
    try {
      const invocation = gcloudInvocation(
        gcloudCommand(settings.get<string>('gcloudPath') || 'gcloud'),
        args,
      );
      const terminal = vscode.window.createTerminal({
        name: 'GCloud sign-in',
        cwd: homedir(),
        shellPath: invocation.shell
          ? (process.env.ComSpec ?? 'cmd.exe')
          : invocation.file,
        shellArgs: invocation.shell
          ? `/d /s /c "${invocation.file}"`
          : invocation.args,
      });
      terminal.show();
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Signing in with GCloud failed: ${messageOf(error)}`,
      );
    }
  }

  function localBundles(row: Pick<Row, 'kind' | 'name'>) {
    return bundles.filter(
      bundle => bundle.kind === row.kind && bundle.name === row.name,
    );
  }

  /** Returns the local bundle of a row, unless several share its name. */
  function localBundle(row: Pick<Row, 'kind' | 'name'>) {
    const matches = localBundles(row);
    return matches.length === 1 ? matches[0] : undefined;
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
  return { kind: bundle.kind, name: bundle.name, path: relative(bundle) };
}

/** Explains an error in terms of what the user can do about it. */
function problemOf(error: unknown): Problem {
  if (error instanceof GcloudError && error.reason !== 'signedOut') {
    const missing = error.reason === 'missing';
    const remote = vscode.env.remoteName
      ? ` It has to run where the extension runs (${vscode.env.remoteName}).`
      : '';
    return {
      reason: missing ? 'gcloudMissing' : 'gcloudFailed',
      message: missing
        ? 'The Google Cloud CLI (GCloud) was not found.'
        : `The Google Cloud CLI (GCloud) could not be run. ${messageOf(error)}`,
      hint: `${missing ? 'Install the CLI and add it to PATH' : 'Check that the CLI works in a terminal'}, or set apigeeTools.gcloudPath to its executable in User or Remote Settings. Restart VS Code after changing PATH.${remote}`,
    };
  }
  if (
    (error instanceof GcloudError && error.reason === 'signedOut') ||
    (error instanceof ApigeeError && error.status === 401)
  ) {
    return {
      reason: 'signedOut',
      message: 'GCloud is not signed in.',
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
