// The flow view: a panel beside the editor that shows how Apigee runs the
// flows of a bundle. It reads the local copy from the workspace, so it works
// offline, signed out, and in Restricted Mode; with the dashboard's
// organization, it also shows what each environment runs.
import path from 'node:path';
import * as vscode from 'vscode';
import { cellOf, flowHookPoints, type ApigeeClient } from './apigee';
import { findBundleRoot } from './bundle';
import type { WorkspaceBundle } from './dashboard';
import { flowModel, flowView, type FlowModel, type ViewContext } from './flow';
import type {
  Cell,
  FlowSource,
  FlowView,
  HostMessage,
  Kind,
  Note,
  Row,
  Snapshot,
  WebviewMessage,
} from './protocol';
import {
  bundleDirectory,
  compareBundles,
  fingerprints,
  readBundle,
  type BundleChanges,
  type BundleFiles,
} from './revision';

const viewType = 'apigeeTools.flow';

/** What the flow panel needs from the dashboard, which registers it. */
export type FlowHost = {
  /** Finds the bundles in the workspace. */
  scanWorkspace(): Promise<WorkspaceBundle[]>;
  /** The page of the flow view, with the dashboard's scripts and styles. */
  pageHtml(webview: vscode.Webview): string;
  /** The dashboard's organization, deployments, and problems. */
  snapshot(): Snapshot;
  /** A client of the Apigee API with the dashboard's gcloud session. */
  client(): Promise<ApigeeClient>;
  /** Downloads a deployed revision once; the last few stay in memory. */
  revisionFiles(
    client: ApigeeClient,
    organization: string,
    row: Pick<Row, 'kind' | 'name'>,
    revision: string,
  ): Promise<BundleFiles>;
  /** Keeps a revision's files in memory and names the document of one. */
  revisionDocument(
    organization: string,
    row: Pick<Row, 'kind' | 'name'>,
    revision: string,
    files: BundleFiles,
    file: string,
  ): vscode.Uri;
  /** Opens the files that differ between a deployment and a local copy. */
  compare(
    kind: Kind,
    name: string,
    environment: string,
    directory: string,
  ): Promise<void>;
  /** Loads the organization again, as Refresh in the dashboard does. */
  refresh(): Promise<void>;
  /** Starts `gcloud auth login` in a terminal. */
  signIn(): void;
};

/** What the dashboard calls. */
export type FlowPanel = {
  /** Reloads the page after the webview was rebuilt in development. */
  reload(): void;
  /** Takes in the dashboard's new state, such as loaded deployments. */
  update(): void;
  /** Shows the flow of a proxy or shared flow, in an environment if given. */
  show(target: {
    kind: Kind;
    name: string;
    environment?: string;
  }): Promise<void>;
};

/** The bundle the panel shows, with the directory of its local copy. */
type Subject = { kind: Kind; name: string; directory?: string };

/** The organization and deployments that environments come from. */
type Known = {
  organization: string;
  rows: readonly Row[];
  environments: readonly string[];
};

/** A deployed revision on show, whose files open in the editor. */
type Shown = {
  organization: string;
  row: Row;
  cell: Cell;
  files: BundleFiles;
  changes?: BundleChanges;
};

/** Registers the Show Flow command and its panel. */
export function registerFlowPanel(
  context: vscode.ExtensionContext,
  host: FlowHost,
): FlowPanel {
  const webviewRoot = vscode.Uri.joinPath(
    context.extensionUri,
    'dist',
    'webview',
  );
  let panel: vscode.WebviewPanel | undefined;
  let ready = false;
  let subject: Subject | undefined;
  // The source on show: empty for the local copy, else an environment
  let source = '';
  let model: FlowModel | undefined;
  let viewContext: ViewContext = {};
  let shown: Shown | undefined;
  let problem: Note | undefined;
  // A copy, so that closing the dashboard keeps the environments
  let known: Known | undefined;
  // Counts models, so that the webview's references to places stay valid
  let version = 0;
  // Counts builds, so that a slow read cannot replace a newer one
  let builds = 0;
  // The route rule to follow for each proxy endpoint, by position
  let routes: number[] = [];
  let watcher: vscode.FileSystemWatcher | undefined;
  let rebuild: ReturnType<typeof setTimeout> | undefined;
  // The editor group that Show Flow came from, where files open
  let origin: vscode.ViewColumn | undefined;
  let posted = '';
  let environmentsPosted = '';
  // Deployed revisions never change; flow hooks stay until Refresh
  const models = new Map<string, FlowModel>();
  const hooks = new Map<string, NonNullable<ViewContext['hooks']>>();

  context.subscriptions.push(
    vscode.commands.registerCommand('apigeeTools.showFlow', showFlow),
    {
      dispose: () => {
        clearTimeout(rebuild);
        watcher?.dispose();
      },
    },
  );

  /**
   * Shows the flow of the bundle of a file: the one given by the editor title,
   * the active editor's, or else one picked from the workspace. Others, such
   * as tests, may name a proxy or shared flow and an environment.
   */
  async function showFlow(argument?: unknown): Promise<void> {
    if (isTarget(argument)) {
      await show(argument);
      return;
    }
    const editor = vscode.window.activeTextEditor;
    const uri =
      argument instanceof vscode.Uri ? argument : editor?.document.uri;
    const directory = uri?.scheme === 'file' && findBundleRoot(uri.fsPath);
    const bundles = await host.scanWorkspace();
    if (directory) {
      open(subjectOf(directory, bundles), '', false);
      return;
    }
    if (!bundles.length) {
      void vscode.window.showInformationMessage(
        'Open a folder with an API proxy or shared flow bundle to show its flow.',
      );
      return;
    }
    const picked = await vscode.window.showQuickPick(
      bundles.map(bundle => ({
        label: bundle.name,
        description: vscode.workspace.asRelativePath(bundle.directory),
        bundle,
      })),
      { placeHolder: 'Choose the bundle whose flow to show' },
    );
    if (picked) open(subjectOf(picked.bundle.directory, bundles), '', true);
  }

  /**
   * Shows a proxy or shared flow by name, with its local copy if exactly one
   * bundle in the workspace has the name, in the environment if it is
   * deployed there, and takes the focus.
   */
  async function show(target: {
    kind: Kind;
    name: string;
    environment?: string;
  }): Promise<void> {
    const copies = (await host.scanWorkspace()).filter(
      bundle => bundle.kind === target.kind && bundle.name === target.name,
    );
    refreshKnown();
    const row = rowOf(target);
    const deployed =
      target.environment !== undefined && row && cellOf(row, target.environment)
        ? target.environment
        : undefined;
    const directory = copies.length === 1 ? copies[0].directory : undefined;
    const first = known?.environments.find(
      environment => row && cellOf(row, environment),
    );
    open(
      { kind: target.kind, name: target.name, directory },
      deployed ?? (directory ? '' : (first ?? '')),
      true,
    );
    if (copies.length > 1) {
      problem = {
        tone: 'info',
        text: `Several bundles in the workspace are named ${target.name}, so the flow shows no local copy. Show the flow from a file of one of them.`,
      };
    }
  }

  /** Names a bundle directory as the workspace scan does, else by its folder. */
  function subjectOf(
    directory: string,
    bundles: readonly WorkspaceBundle[],
  ): Subject {
    const scanned = bundles.find(bundle => bundle.directory === directory);
    return {
      kind:
        path.basename(directory).toLowerCase() === 'apiproxy'
          ? 'apis'
          : 'sharedflows',
      name: scanned?.name ?? path.basename(path.dirname(directory)),
      directory,
    };
  }

  /** Opens the panel beside the editor, or switches it to another bundle. */
  function open(next: Subject, from: string, focus: boolean): void {
    const title = `Flow · ${next.name}`;
    const active = vscode.window.tabGroups.activeTabGroup.viewColumn;
    if (active !== panel?.viewColumn) origin = active;
    if (panel) {
      panel.title = title;
      panel.reveal(undefined, !focus);
    } else {
      panel = vscode.window.createWebviewPanel(
        viewType,
        title,
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: !focus },
        { enableScripts: true, localResourceRoots: [webviewRoot] },
      );
      panel.iconPath = vscode.Uri.joinPath(
        context.extensionUri,
        'images',
        'icon.png',
      );
      ready = false;
      panel.webview.html = host.pageHtml(panel.webview);
      const listener = panel.webview.onDidReceiveMessage(handle);
      panel.onDidDispose(() => {
        listener.dispose();
        clearTimeout(rebuild);
        watcher?.dispose();
        watcher = undefined;
        panel = undefined;
        subject = undefined;
        model = undefined;
        shown = undefined;
        ready = false;
      });
    }
    if (
      !subject ||
      subject.directory !== next.directory ||
      subject.name !== next.name
    ) {
      routes = [];
      watcher?.dispose();
      watcher = next.directory ? watch(next.directory) : undefined;
    }
    subject = next;
    source = from;
    problem = undefined;
    void build();
  }

  /** Rebuilds the view shortly after a file of the local copy changed. */
  function watch(directory: string): vscode.FileSystemWatcher {
    const files = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(directory), '**/*'),
    );
    const later = () => {
      clearTimeout(rebuild);
      rebuild = setTimeout(() => void build(), 300);
    };
    files.onDidChange(later);
    files.onDidCreate(later);
    files.onDidDelete(later);
    return files;
  }

  /** Reads the source on show and posts its flow. */
  async function build(): Promise<void> {
    const current = subject;
    if (!current) return;
    const build = ++builds;
    const from = source;
    let next: {
      model?: FlowModel;
      context: ViewContext;
      shown?: Shown;
      note?: Note;
    };
    try {
      next = from
        ? await environmentFlow(current, from)
        : current.directory
          ? {
              model: flowModel(
                await readBundle(current.directory, current.kind),
                current.kind,
              ),
              context: {},
            }
          : { context: {} };
    } catch (error) {
      next = {
        context: {},
        note: {
          tone: 'warning',
          text: from
            ? `The flow in ${from} could not be read: ${messageOf(error)}`
            : `The bundle could not be read: ${messageOf(error)}`,
        },
      };
    }
    if (build !== builds) return;
    model = next.model;
    viewContext = next.context;
    shown = next.shown;
    if (next.note) problem = next.note;
    else if (problem?.tone === 'warning') problem = undefined;
    version++;
    post();
  }

  /**
   * Reads the revision deployed in an environment with the shared flows of
   * its flow hooks, and how it differs from the local copy.
   */
  async function environmentFlow(
    current: Subject,
    environment: string,
  ): Promise<{ model: FlowModel; context: ViewContext; shown: Shown }> {
    const scope = known;
    const row = rowOf(current);
    const cell = row && cellOf(row, environment);
    if (!scope || !row || !cell) {
      throw new Error(`${current.name} is not deployed in ${environment}.`);
    }
    const client = await host.client();

    // An aborted dashboard load may have shared the download; fetch it again
    const download = () =>
      host.revisionFiles(client, scope.organization, row, cell.revision);
    const files = await download().catch(error => {
      if ((error as Error)?.name !== 'AbortError') throw error;
      return download();
    });
    const key = `${scope.organization}/${row.kind}/${row.name}/${cell.revision}`;
    const parsed = models.get(key) ?? flowModel(files, row.kind);
    models.set(key, parsed);
    const attached = await hooksOf(client, scope.organization, environment);
    const changes = current.directory
      ? compareBundles(
          fingerprints(files),
          fingerprints(await readBundle(current.directory, current.kind)),
        )
      : undefined;
    return {
      model: parsed,
      shown: { organization: scope.organization, row, cell, files, changes },
      context: {
        environment,
        hooks: attached,
        changes,
        sharedFlow: name => {
          const flow = scope.rows.find(
            item => item.kind === 'sharedflows' && item.name === name,
          );
          const deployed = flow && cellOf(flow, environment);
          return (
            deployed && { revision: deployed.revision, differs: deployed.drift }
          );
        },
      },
    };
  }

  /** Reads the flow hooks of an environment once, until Refresh. */
  async function hooksOf(
    client: ApigeeClient,
    organization: string,
    environment: string,
  ): Promise<NonNullable<ViewContext['hooks']>> {
    const key = `${organization}/${environment}`;
    const cached = hooks.get(key);
    if (cached) return cached;
    const found = await Promise.all(
      flowHookPoints.map(async point => {
        const hook = await client.flowHook(organization, environment, point);
        return [point, hook] as const;
      }),
    );
    const attached = Object.fromEntries(
      found.flatMap(([point, hook]) =>
        hook.sharedFlow
          ? [
              [
                point,
                {
                  sharedFlow: hook.sharedFlow,
                  continueOnError: hook.continueOnError,
                },
              ],
            ]
          : [],
      ),
    );
    hooks.set(key, attached);
    return attached;
  }

  /** Copies the dashboard's deployments when it has loaded them. */
  function refreshKnown(): Snapshot {
    const snapshot = host.snapshot();
    if (snapshot.organization && snapshot.rows && snapshot.overview) {
      known = {
        organization: snapshot.organization,
        rows: snapshot.rows,
        environments: snapshot.overview.environments.map(item => item.name),
      };
    }
    return snapshot;
  }

  function rowOf(target: Pick<Row, 'kind' | 'name'>): Row | undefined {
    return known?.rows.find(
      row => row.kind === target.kind && row.name === target.name,
    );
  }

  /** The sources to choose from, and what keeps environments away. */
  function environmentsOf(): Pick<
    FlowView,
    'sources' | 'environments' | 'organization' | 'problem'
  > {
    const snapshot = refreshKnown();
    const sources: FlowSource[] = subject?.directory
      ? [{ id: '', label: 'Workspace' }]
      : [];
    if (!vscode.workspace.isTrusted) {
      return { sources, environments: 'untrusted' };
    }
    if (!known) {
      return snapshot.loading
        ? { sources, environments: 'loading' }
        : snapshot.problem
          ? { sources, environments: 'problem', problem: snapshot.problem }
          : { sources, environments: 'unloaded' };
    }
    const row = subject && rowOf(subject);
    for (const environment of known.environments) {
      const cell = row && cellOf(row, environment);
      if (cell) {
        sources.push({
          id: environment,
          label: `${environment} · Revision ${cell.revision}`,
        });
      }
    }
    const deployed = sources.some(item => item.id);
    return {
      sources,
      organization: known.organization,
      environments: deployed
        ? 'ready'
        : snapshot.loading
          ? 'loading'
          : 'undeployed',
      ...(snapshot.problem && { problem: snapshot.problem }),
    };
  }

  /** Posts the view, but only when it changed. */
  function post(): void {
    if (!panel || !ready || !subject) return;
    const environments = environmentsOf();
    // The current deployment state, which may arrive after the revision
    const row = rowOf(subject);
    const cell = source && row ? cellOf(row, source) : undefined;
    environmentsPosted = JSON.stringify([environments, cell]);
    const view = model
      ? flowView(model, { ...viewContext, routes })
      : { maps: [], notes: [] };
    const changes = shown?.changes;
    const flow: FlowView = {
      version,
      kind: subject.kind,
      name: subject.name,
      ...(subject.directory && {
        path: vscode.workspace.asRelativePath(subject.directory),
      }),
      source,
      ...environments,
      ...(cell && { cell }),
      ...(source &&
        changes && {
          changes:
            changes.changed.length +
            changes.added.length +
            changes.removed.length,
        }),
      maps: view.maps,
      notes: problem ? [...view.notes, problem] : view.notes,
    };
    const json = JSON.stringify(flow);
    if (json === posted) return;
    posted = json;
    const message: HostMessage = { type: 'flow', flow };
    void panel.webview.postMessage(message);
  }

  /**
   * Takes in the dashboard's new state. Nothing happens unless the sources
   * changed; a source that is gone falls back to the local copy or the first
   * environment, and a new revision of the source is read again.
   */
  function update(): void {
    if (!panel || !ready || !subject) return;
    const environments = environmentsOf();
    const row = rowOf(subject);
    const cell = source && row ? cellOf(row, source) : undefined;
    if (JSON.stringify([environments, cell]) === environmentsPosted) return;
    const ids = environments.sources.map(item => item.id);
    if (!ids.includes(source)) {
      source = ids[0] ?? '';
      void build();
    } else if (source && cell?.revision !== shown?.cell.revision) {
      void build();
    } else {
      post();
    }
  }

  /** Handles a message from the webview, which counts as untrusted input. */
  async function handle(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        ready = true;
        posted = '';
        post();
        break;
      case 'flowOpen':
        if (message.version === version) await openPlace(message.at);
        break;
      case 'flowRoute': {
        const { endpoint, route } = message;
        const routed =
          message.version === version &&
          Number.isInteger(endpoint) &&
          Number.isInteger(route) &&
          route >= 0 &&
          route < (model?.proxyEndpoints[endpoint]?.routes.length ?? 0);
        if (routed) {
          routes[endpoint] = route;
          post();
        }
        break;
      }
      case 'flowSource':
        if (environmentsOf().sources.some(item => item.id === message.source)) {
          source = message.source;
          await build();
        }
        break;
      case 'showFlow': {
        // Only the shared flow of a flow hook on show, in the same environment
        const hook = Object.values(viewContext.hooks ?? {}).find(
          item => item.sharedFlow === message.name,
        );
        if (
          hook &&
          message.kind === 'sharedflows' &&
          message.environment === source
        ) {
          await show({
            kind: 'sharedflows',
            name: hook.sharedFlow,
            environment: source,
          });
        }
        break;
      }
      case 'compare':
        if (
          subject?.directory &&
          message.kind === subject.kind &&
          message.name === subject.name &&
          message.environment === source &&
          source
        ) {
          await host.compare(
            subject.kind,
            subject.name,
            source,
            subject.directory,
          );
        }
        break;
      case 'refresh':
        hooks.clear();
        await host.refresh();
        // Flow hooks may have changed even where the revision has not
        if (source) await build();
        break;
      case 'signIn':
        host.signIn();
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

  /** Opens a place of the model in the editor group Show Flow came from. */
  async function openPlace(at: number): Promise<void> {
    const place = Number.isInteger(at) ? model?.places[at] : undefined;
    if (!place || !subject) return;
    let uri: vscode.Uri | undefined;
    if (source && shown) {
      uri = host.revisionDocument(
        shown.organization,
        shown.row,
        shown.cell.revision,
        shown.files,
        place.file,
      );
    } else if (!source && subject.directory) {
      uri = vscode.Uri.file(
        path.join(
          subject.directory,
          place.file.slice(bundleDirectory(subject.kind).length + 1),
        ),
      );
    }
    if (!uri) return;
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      const position = document.positionAt(place.offset);
      await vscode.window.showTextDocument(document, {
        // Never over the panel itself
        viewColumn:
          origin && origin !== panel?.viewColumn
            ? origin
            : vscode.ViewColumn.Beside,
        selection: new vscode.Range(position, position),
      });
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Opening ${place.file} failed: ${messageOf(error)}`,
      );
    }
  }

  return {
    reload: () => {
      if (!panel) return;
      ready = false;
      panel.webview.html = host.pageHtml(panel.webview);
    },
    update,
    show,
  };
}

/** Whether a command argument names a proxy or shared flow to show. */
function isTarget(
  value: unknown,
): value is { kind: Kind; name: string; environment?: string } {
  const target = value as
    { kind?: unknown; name?: unknown; environment?: unknown } | undefined;
  return (
    typeof target === 'object' &&
    target !== null &&
    (target.kind === 'apis' || target.kind === 'sharedflows') &&
    typeof target.name === 'string' &&
    (target.environment === undefined || typeof target.environment === 'string')
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
