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
  deployedRevisions,
  loadFlowHooks,
  loadOverview,
  loadRows,
  relationshipsOf,
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
  HostMessage,
  KeyRef,
  Kind,
  LocalBundle,
  Note,
  Problem,
  Relationships,
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
  sharedFlowCalls,
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

// Revisions downloaded per load to find the shared flows they call
const revisionLimit = 200;

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
  // The organization chosen in the selector; only such a choice is remembered
  let picked: string | undefined;
  let postTimer: ReturnType<typeof setTimeout> | undefined;

  // Deployed revisions never change: files are kept for the last few, their
  // fingerprints for the whole session
  const revisions = new Map<string, Promise<BundleFiles>>();
  const prints = new Map<string, Promise<Map<string, string>>>();
  // The shared flows that each deployed revision calls, for the session
  const calls = new Map<string, string[]>();

  // The Relationships tab loads once opened, and then with every load
  let relationshipsWanted = false;
  let relationships: Relationships | undefined;
  let relationshipsLoading: AbortController | undefined;
  // Full API keys for the key search and for copying; the webview gets none
  let keyOwners = new Map<string, KeyRef>();

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
    {
      dispose: () => {
        loading?.abort();
        relationshipsLoading?.abort();
      },
    },
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
      loading?.abort();
      relationshipsLoading?.abort();
      relationshipsLoading = undefined;
      relationshipsWanted = false;
      relationships = undefined;
      keyOwners = new Map();
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
        post();
        postRelationships();
        if (
          snapshot.trusted &&
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
      case 'compare':
        await compare(message.kind, message.name, message.environment);
        break;
      case 'details':
        await checkDetails(message.kind, message.name);
        break;
      case 'relationships':
        relationshipsWanted = true;
        // Before the rows arrive, the running load reads them as well
        if (
          snapshot.rows &&
          relationships?.organization !== snapshot.organization &&
          !relationshipsLoading
        ) {
          await loadRelationships();
        }
        break;
      case 'findKey': {
        // The key is neither logged nor sent back
        const found =
          typeof message.key === 'string' &&
          relationships?.organization === snapshot.organization
            ? keyOwners.get(message.key.trim())
            : undefined;
        send({ type: 'keyOwner', found });
        break;
      }
      case 'copyKey': {
        const key = [...keyOwners].find(
          ([, owner]) => owner.app === message.app && owner.key === message.key,
        )?.[0];
        if (key) {
          await vscode.env.clipboard.writeText(key);
          vscode.window.setStatusBarMessage('$(check) API key copied', 3000);
        }
        break;
      }
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
    loading?.abort();
    relationshipsLoading?.abort();
    relationshipsLoading = undefined;
    const controller = new AbortController();
    loading = controller;
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
      const client = apigeeClient(current.tokens, current.base, {
        signal: controller.signal,
      });
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

      // An organization guessed from the gcloud project may not exist, and
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
      // Started before any await, so that the tab cannot start a second load
      const relating = relationshipsWanted ? loadRelationships() : undefined;

      // Only an organization chosen in the selector that loaded is remembered
      if (organization === picked) {
        await context.workspaceState.update(organizationKey, organization);
      }
      await Promise.all([
        checkStatus(client, organization, rows, controller, notes),
        checkDrift(client, organization, rows, controller, notes),
        relating,
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

  /**
   * Picks the organization chosen in the selector, then the last chosen one
   * that loaded, the gcloud project, or the first listed. Without a list,
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

  /**
   * Loads the status of the deployments, local bundles and recent ones first.
   * A network failure or an exhausted quota stops the remaining requests, so
   * the dashboard neither waits for timeouts nor uses up the quota of others.
   */
  async function checkStatus(
    client: ApigeeClient,
    organization: string,
    rows: Row[],
    controller: AbortController,
    notes: Note[],
  ): Promise<void> {
    const total = rows.reduce(
      (sum, row) => sum + Object.keys(row.cells).length,
      0,
    );
    const targets = statusTargets(rows, statusLimit);
    let checked = 0;
    let failed = 0;
    let firstFailure: unknown;
    let stopped: ApigeeError | undefined;
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
          checked++;
          schedulePost();
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
    if (!stopped && targets.length < total) {
      notes.push({
        tone: 'info',
        text: `Status was checked for ${checked} of ${total} deployments, local bundles and recent deployments first, to spare the API quota.`,
      });
    }
  }

  /**
   * Loads the status that the details of a proxy or shared flow still miss,
   * such as those beyond the limit of status checks per load.
   */
  async function checkDetails(kind: Kind, name: string): Promise<void> {
    const row = snapshot.rows?.find(
      item => item.kind === kind && item.name === name,
    );
    const organization = snapshot.organization;
    const missing = Object.entries(row?.cells ?? {}).filter(
      ([, cell]) => !cell.state,
    );
    if (!organization || !missing.length) return;
    // A running load reports its own end
    const alone = !loading;
    if (alone) {
      snapshot = { ...snapshot, loading: true };
      post();
    }
    try {
      const current = (session ??= await startSession());
      const client = apigeeClient(current.tokens, current.base);
      await Promise.all(
        missing.map(async ([environment, cell]) => {
          try {
            applyStatus(
              cell,
              await client.deploymentStatus(
                organization,
                environment,
                kind,
                name,
                cell.revision,
              ),
            );
          } catch (error) {
            host.log.warn(
              `Status of ${name} in ${environment}:`,
              messageOf(error),
            );
            snapshot.notes?.push({
              tone: 'warning',
              text: `Status of "${name}" in ${environment} could not be checked: ${messageOf(error)}`,
            });
          }
        }),
      );
    } catch (error) {
      host.log.warn('Checking the details failed:', messageOf(error));
      snapshot.notes?.push({
        tone: 'warning',
        text: `Status of "${name}" could not be checked: ${messageOf(error)}`,
      });
    } finally {
      if (alone && !loading) snapshot = { ...snapshot, loading: false };
      post();
    }
  }

  /**
   * Loads who uses what for the Relationships tab: API products, developers,
   * app groups, apps with their keys, flow hooks, and the shared flows that
   * deployed revisions call. A list that cannot be read becomes a note of the
   * tab, and a network failure or an exhausted quota stops the rest.
   */
  async function loadRelationships(): Promise<void> {
    const { organization, rows, overview } = snapshot;
    if (!relationshipsWanted || !organization || !rows || !overview) return;
    relationshipsLoading?.abort();
    const controller = new AbortController();
    relationshipsLoading = controller;
    const notes: Note[] = [];
    // The calls of an earlier load stay until new ones arrive
    const previous =
      relationships?.organization === organization ? relationships.calls : {};
    let model: Relationships | undefined;
    let stopped: ApigeeError | undefined;
    // A running load reports its own end
    const alone = !loading;
    if (alone) {
      snapshot = { ...snapshot, loading: true };
      post();
    }

    /** Returns what a request reads, or nothing, noting why. */
    const settle = async <T>(
      what: string,
      request: Promise<T>,
    ): Promise<T | undefined> => {
      try {
        return await request;
      } catch (error) {
        if (controller.signal.aborted) return undefined;
        if (
          error instanceof ApigeeError &&
          (error.status === undefined || error.status === 429)
        ) {
          stopped ??= error;
          controller.abort();
          return undefined;
        }
        host.log.warn(
          `Reading ${what.toLowerCase()} failed:`,
          messageOf(error),
        );
        const hint = error instanceof ApigeeError ? (error.hint ?? '') : '';
        notes.push({
          tone: 'warning',
          text: `${what} could not be read: ${messageOf(error)} ${hint}`.trim(),
        });
        return undefined;
      }
    };

    try {
      const current = (session ??= await startSession());
      const client = apigeeClient(current.tokens, current.base, {
        signal: controller.signal,
      });
      const [products, developers, apps, hooks] = await Promise.all([
        settle('API products', client.products(organization)),
        settle('Developers', client.developers(organization)),
        settle('Apps', client.apps(organization)),
        settle(
          'Flow hooks',
          loadFlowHooks(
            client,
            organization,
            overview.environments.map(environment => environment.name),
          ),
        ),
      ]);
      // Organizations without app groups never read them
      const appGroups = apps?.some(app => app.appGroup)
        ? await settle('App groups', client.appGroups(organization))
        : undefined;
      if (relationshipsLoading !== controller) return;
      if (developers?.length === 1000) {
        notes.push({
          tone: 'info',
          text: 'Apigee returns at most 1,000 developers with details; the owners of other apps show without name and status.',
        });
      }
      const built = relationshipsOf(organization, {
        products,
        developers,
        appGroups,
        apps,
        hooks: hooks ?? {},
      });
      keyOwners = built.keyOwners;
      model = { ...built.relationships, calls: previous, notes };
      relationships = model;
      postRelationships();

      if (!stopped) {
        const read = await readCalls(client, organization, rows, controller);
        if (relationshipsLoading !== controller) return;
        stopped ??= read.stopped;
        notes.push(...read.notes);
        model = { ...model, calls: read.calls };
      }
    } catch (error) {
      if (!controller.signal.aborted || stopped) {
        host.log.warn('Loading the relationships failed:', messageOf(error));
        notes.push({
          tone: 'warning',
          text: `Loading the relationships failed: ${messageOf(error)}`,
        });
      }
    } finally {
      // A replaced load posts nothing; a stopped one posts what it has
      if (relationshipsLoading === controller) {
        relationshipsLoading = undefined;
        if (stopped) {
          notes.push({
            tone: 'warning',
            text: `Loading the relationships stopped: ${stopped.message} ${stopped.hint ?? ''}`.trim(),
          });
        }
        relationships = {
          ...(model ?? {
            organization,
            owners: [],
            calls: previous,
            hooks: {},
          }),
          notes,
        };
        postRelationships();
      }
      if (alone && !loading) {
        snapshot = { ...snapshot, loading: false };
        post();
      }
    }
  }

  /**
   * Reads which shared flows the deployed revisions call. Each revision is
   * read once per session, and at most `revisionLimit` per load, recent
   * deployments first; a network failure or an exhausted quota stops it.
   */
  async function readCalls(
    client: ApigeeClient,
    organization: string,
    rows: Row[],
    controller: AbortController,
  ): Promise<{
    calls: Record<string, string[]>;
    notes: Note[];
    stopped?: ApigeeError;
  }> {
    const result: Record<string, string[]> = {};
    const notes: Note[] = [];
    const targets = deployedRevisions(rows);
    let downloads = 0;
    let unread = 0;
    let failed = 0;
    let firstFailure: unknown;
    let stopped: ApigeeError | undefined;
    await Promise.all(
      targets.map(async ({ row, revision }) => {
        const key = revisionKey(organization, row.kind, row.name, revision);
        let names = calls.get(key);
        if (!names) {
          if (downloads >= revisionLimit) {
            unread++;
            return;
          }
          downloads++;
          try {
            const zip = await client.bundle(
              organization,
              row.kind,
              row.name,
              revision,
            );
            names = sharedFlowCalls(unzip(zip));
            calls.set(key, names);
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
              `Shared flow calls of ${row.name} revision ${revision}:`,
              messageOf(error),
            );
            return;
          }
        }
        result[`${row.kind}/${row.name}/${revision}`] = names;
      }),
    );
    if (failed) {
      notes.push({
        tone: 'warning',
        text: `The shared flow calls of ${failed} revisions could not be read: ${messageOf(firstFailure)}`,
      });
    }
    if (unread && !stopped) {
      notes.push({
        tone: 'info',
        text: `Shared flow calls were read for ${Object.keys(result).length} of ${targets.length} deployed revisions, recent deployments first, to spare the API quota. Refresh to read more.`,
      });
    }
    return { calls: result, notes, stopped };
  }

  /**
   * Marks the deployments that differ from the bundle in the workspace. Like
   * the status checks, it stops on a network failure or an exhausted quota.
   */
  async function checkDrift(
    client: ApigeeClient,
    organization: string,
    rows: Row[],
    controller: AbortController,
    notes: Note[],
  ): Promise<void> {
    const failed: string[] = [];
    let firstFailure: unknown;
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
   * gcloud runs directly, so no shell interprets the configured path; on
   * Windows, cmd.exe runs gcloud.cmd. The home directory keeps cmd.exe from
   * running a gcloud.cmd of the workspace.
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
        name: 'gcloud auth login',
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
        `Signing in with gcloud failed: ${messageOf(error)}`,
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
    send({ type: 'snapshot', snapshot });
  }

  /** Sends the relationships, which go apart from the snapshot. */
  function postRelationships(): void {
    if (relationships) send({ type: 'relationships', relationships });
  }

  function send(message: HostMessage): void {
    if (panel && ready) void panel.webview.postMessage(message);
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
        ? 'The Google Cloud CLI (gcloud) was not found.'
        : `The Google Cloud CLI (gcloud) could not be run. ${messageOf(error)}`,
      hint: `${missing ? 'Install the CLI and add it to PATH' : 'Check that the CLI works in a terminal'}, or set apigeeTools.gcloudPath to its executable in User or Remote Settings. Restart VS Code after changing PATH.${remote}`,
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
