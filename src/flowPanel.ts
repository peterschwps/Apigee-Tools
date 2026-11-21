// The flow view: a tab in the editor that shows how Apigee runs the flows of
// a bundle. It reads the local copy from the workspace, so it works
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
  FlowHookPoint,
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

/** A deployment that the flow view shows. */
export type Deployment = { organization: string; row: Row; cell: Cell };

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
    from: Deployment,
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

/** A bundle shown before or after the one on show, for Back and Forward. */
type Visit = {
  subject: Subject;
  source: string;
  routes: number[];
  notice?: Note;
};

/** The organization and deployments that environments come from. */
type Known = {
  organization: string;
  rows: readonly Row[];
  environments: readonly string[];
};

/** The flow hooks of an environment that have a shared flow attached. */
type Hooks = NonNullable<ViewContext['hooks']>;

/** What a build read: the model of a subject's source, and its context. */
type Built = {
  subject: Subject;
  source: string;
  model?: FlowModel;
  context: ViewContext;
  /** The deployment of an environment, whose files open in the editor. */
  shown?: Deployment & { files: BundleFiles; changes?: BundleChanges };
  /** The deployed shared flows of its flow hooks, whose steps open too. */
  hookFlows?: Partial<
    Record<FlowHookPoint, Deployment & { files: BundleFiles; model: FlowModel }>
  >;
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
  let built: Built | undefined;
  // What the newest build reads, so that it is not started twice
  let target = '';
  // A remark on the subject, and what went wrong in the last build
  let notice: Note | undefined;
  let warning: Note | undefined;
  // A copy, so that closing the dashboard keeps the environments
  let known: Known | undefined;
  // Counts the dashboard's loads; each may bring other flow hooks
  let loads = 0;
  // Counts models, so that the webview's references to places stay valid
  let version = 0;
  // Counts builds, so that a slow read cannot replace a newer one
  let builds = 0;
  // The route rule to follow for each proxy endpoint, by position
  let routes: number[] = [];
  let watcher: vscode.FileSystemWatcher | undefined;
  let rebuild: ReturnType<typeof setTimeout> | undefined;
  // The bundles to go back and forward to, the nearest last
  let back: Visit[] = [];
  let forward: Visit[] = [];
  let posted = '';
  // Deployed revisions never change; flow hooks are read once per load
  const models = new Map<string, FlowModel>();
  const hooks = new Map<string, Promise<Hooks>>();

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
      await open(subjectOf(directory, bundles), '');
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
    if (picked) await open(subjectOf(picked.bundle.directory, bundles), '');
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
    await open(
      { kind: target.kind, name: target.name, directory },
      deployed ?? (directory ? '' : (first ?? '')),
      copies.length > 1
        ? {
            tone: 'info',
            text: `Several bundles in the workspace are named ${target.name}, so the flow shows no local copy. Show the flow from a file of one of them.`,
          }
        : undefined,
    );
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

  /**
   * Opens the panel as a tab of the active editor group, or switches it to
   * another bundle there, and resolves once its first build is done. Files
   * open beside it. Another bundle can be gone back to, unless the switch
   * goes back or forward itself, which brings the routes it followed.
   */
  function open(
    next: Subject,
    from: string,
    remark?: Note,
    travelled?: number[],
  ): Promise<void> {
    const title = `Flow · ${next.name}`;
    if (panel) {
      panel.title = title;
      panel.reveal(vscode.ViewColumn.Active);
    } else {
      panel = vscode.window.createWebviewPanel(
        viewType,
        title,
        vscode.ViewColumn.Active,
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
        built = undefined;
        target = '';
        ready = false;
        back = [];
        forward = [];
        // A build still running belongs to the closed panel
        builds++;
      });
    }
    if (
      !subject ||
      subject.kind !== next.kind ||
      subject.directory !== next.directory ||
      subject.name !== next.name
    ) {
      // A new way forward replaces the old one, as in a browser
      if (subject && !travelled) {
        back.push({ subject, source, routes, notice });
        forward = [];
      }
      routes = travelled ?? [];
      watcher?.dispose();
      watcher = next.directory ? watch(next.directory) : undefined;
    }
    subject = next;
    source = from;
    notice = remark;
    return build();
  }

  /** Shows the bundle before or after the one on show. */
  async function travel(way: 'back' | 'forward'): Promise<void> {
    const [behind, ahead] = way === 'back' ? [back, forward] : [forward, back];
    const visit = behind.pop();
    if (!visit || !subject) return;
    ahead.push({ subject, source, routes, notice });
    await open(visit.subject, visit.source, visit.notice, visit.routes);
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

  /** What a build of a source reads, to tell whether it is read already. */
  function keyOf(from: string): string {
    if (!subject) return '';
    const base = `${subject.kind}/${subject.name}/${subject.directory ?? ''}`;
    if (!from) return base;
    const row = rowOf(subject);
    const cell = row && cellOf(row, from);
    return `${base}/${known?.organization}/${from}/${cell?.revision}/${loads}`;
  }

  /** Reads the source on show and posts its flow. */
  async function build(): Promise<void> {
    const current = subject;
    if (!current) return;
    const from = source;
    target = keyOf(from);
    const build = ++builds;
    let next: Built;
    let note: Note | undefined;
    try {
      ({ built: next, note } = from
        ? await environmentFlow(current, from)
        : {
            built: {
              subject: current,
              source: from,
              context: {},
              ...(current.directory && {
                model: flowModel(
                  await readBundle(current.directory, current.kind),
                  current.kind,
                ),
              }),
            },
          });
    } catch (error) {
      next = { subject: current, source: from, context: {} };
      note = {
        tone: 'warning',
        text: from
          ? `The flow in ${from} could not be read: ${messageOf(error)}`
          : `The bundle could not be read: ${messageOf(error)}`,
      };
    }
    if (build !== builds) return;
    built = next;
    warning = note;
    version++;
    post();
  }

  /**
   * Reads the revision deployed in an environment with the shared flows of
   * its flow hooks, and how it differs from the local copy. Flow hooks or a
   * local copy that cannot be read leave a note, not a missing flow.
   */
  async function environmentFlow(
    current: Subject,
    environment: string,
  ): Promise<{ built: Built; note?: Note }> {
    if (!vscode.workspace.isTrusted) {
      throw new Error('Environments need a trusted workspace.');
    }
    const scope = known;
    const row = rowOf(current);
    const cell = row && cellOf(row, environment);
    if (!scope || !row || !cell) {
      throw new Error(`${current.name} is not deployed in ${environment}.`);
    }
    const client = await host.client();

    // An aborted dashboard load may have shared the download; fetch it again
    const download = (item: Row, revision: string) =>
      host
        .revisionFiles(client, scope.organization, item, revision)
        .catch(error => {
          if ((error as Error)?.name !== 'AbortError') throw error;
          return host.revisionFiles(client, scope.organization, item, revision);
        });
    const modelOf = (item: Row, revision: string, files: BundleFiles) => {
      const key = `${scope.organization}/${item.kind}/${item.name}/${revision}`;
      const parsed = models.get(key) ?? flowModel(files, item.kind);
      models.set(key, parsed);
      return parsed;
    };
    const files = await download(row, cell.revision);
    const parsed = modelOf(row, cell.revision, files);

    const notes: string[] = [];
    const attached = await hooksOf(
      client,
      scope.organization,
      environment,
    ).catch(error => {
      notes.push(
        `The flow hooks of ${environment} could not be read: ${messageOf(error)}`,
      );
      return undefined;
    });
    // The steps of the hooks' shared flows, from their deployed revisions
    const hookFlows: NonNullable<Built['hookFlows']> = {};
    await Promise.all(
      flowHookPoints.map(async point => {
        const hook = attached?.[point];
        const flow =
          hook &&
          scope.rows.find(
            item =>
              item.kind === 'sharedflows' && item.name === hook.sharedFlow,
          );
        const deployed = flow && cellOf(flow, environment);
        if (!hook || !flow || !deployed) return;
        try {
          const shared = await download(flow, deployed.revision);
          hookFlows[point] = {
            organization: scope.organization,
            row: flow,
            cell: deployed,
            files: shared,
            model: modelOf(flow, deployed.revision, shared),
          };
        } catch (error) {
          notes.push(
            `The steps of ${hook.sharedFlow} could not be read: ${messageOf(error)}`,
          );
        }
      }),
    );
    const local = current.directory
      ? await readBundle(current.directory, current.kind).catch(error => {
          notes.push(
            `The local copy could not be read, so differences are not marked: ${messageOf(error)}`,
          );
          return undefined;
        })
      : undefined;
    const changes = local
      ? compareBundles(fingerprints(files), fingerprints(local))
      : undefined;
    return {
      built: {
        subject: current,
        source: environment,
        model: parsed,
        shown: {
          organization: scope.organization,
          row,
          cell,
          files,
          changes,
        },
        hookFlows,
        context: {
          environment,
          hooks: attached,
          hookFlows: Object.fromEntries(
            Object.entries(hookFlows).map(([point, flow]) => [
              point,
              flow.model,
            ]),
          ),
          changes,
          // The newest deployments of the organization, after each load
          sharedFlow: name => {
            const rows =
              known?.organization === scope.organization
                ? known.rows
                : scope.rows;
            const flow = rows.find(
              item => item.kind === 'sharedflows' && item.name === name,
            );
            const deployed = flow && cellOf(flow, environment);
            return (
              deployed && {
                revision: deployed.revision,
                differs: deployed.drift,
              }
            );
          },
        },
      },
      ...(notes.length && {
        note: { tone: 'warning', text: notes.join(' ') },
      }),
    };
  }

  /** Reads the flow hooks of an environment once per load of the dashboard. */
  function hooksOf(
    client: ApigeeClient,
    organization: string,
    environment: string,
  ): Promise<Hooks> {
    const key = `${organization}/${environment}`;
    const cached = hooks.get(key);
    if (cached) return cached;
    const pending = Promise.all(
      flowHookPoints.map(async point => {
        const hook = await client.flowHook(organization, environment, point);
        return [point, hook] as const;
      }),
    ).then(found =>
      Object.fromEntries(
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
      ),
    );
    hooks.set(key, pending);
    // A failed read is tried again next time, unless a newer one replaced it
    pending.catch(() => {
      if (hooks.get(key) === pending) hooks.delete(key);
    });
    return pending;
  }

  /** Copies the dashboard's deployments when it has loaded them. */
  function refreshKnown(): Snapshot {
    const snapshot = host.snapshot();
    if (snapshot.organization && snapshot.rows && snapshot.overview) {
      // Each load lists the deployments anew; flow hooks may have changed too
      if (snapshot.rows !== known?.rows) {
        loads++;
        hooks.clear();
      }
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
    'sources' | 'environments' | 'organization' | 'problem' | 'loading'
  > {
    const snapshot = refreshKnown();
    const loading = snapshot.loading;
    const sources: FlowSource[] = subject?.directory
      ? [{ id: '', label: 'Workspace' }]
      : [];
    if (!vscode.workspace.isTrusted) {
      return { sources, environments: 'untrusted', loading: false };
    }
    if (!known) {
      return loading
        ? { sources, environments: 'loading', loading }
        : snapshot.problem
          ? {
              sources,
              environments: 'problem',
              problem: snapshot.problem,
              loading,
            }
          : { sources, environments: 'unloaded', loading };
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
      environments: deployed ? 'ready' : loading ? 'loading' : 'undeployed',
      loading,
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
    const view = built?.model
      ? flowView(built.model, { ...built.context, routes })
      : { maps: [], notes: [] };
    const changes = built?.source === source && built.shown?.changes;
    const flow: FlowView = {
      version,
      kind: subject.kind,
      name: subject.name,
      ...(back.length && { back: back[back.length - 1].subject.name }),
      ...(forward.length && {
        forward: forward[forward.length - 1].subject.name,
      }),
      ...(subject.directory && {
        path: vscode.workspace.asRelativePath(subject.directory),
      }),
      source,
      ...environments,
      ...(cell && { cell }),
      ...(changes && {
        changes:
          changes.changed.length +
          changes.added.length +
          changes.removed.length,
      }),
      maps: view.maps,
      notes: [...view.notes, ...[warning, notice].filter(note => !!note)],
    };
    const json = JSON.stringify(flow);
    if (json === posted) return;
    posted = json;
    const message: HostMessage = { type: 'flow', flow };
    void panel.webview.postMessage(message);
  }

  /**
   * Takes in the dashboard's new state. A source that is gone falls back to
   * the local copy or the first environment; a source whose deployment
   * changed is read again; otherwise the view only posts what changed.
   */
  function update(): void {
    if (!panel || !ready || !subject) return;
    const ids = environmentsOf().sources.map(item => item.id);
    if (!ids.includes(source)) source = ids[0] ?? '';
    if (keyOf(source) !== target) void build();
    else post();
  }

  /** Handles a message from the webview, which counts as untrusted input. */
  async function handle(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        ready = true;
        posted = '';
        update();
        break;
      case 'flowOpen':
        if (message.version === version) {
          await openPlace(message.at, message.hook);
        }
        break;
      case 'flowRoute': {
        const { endpoint, route } = message;
        const routed =
          message.version === version &&
          Number.isInteger(endpoint) &&
          Number.isInteger(route) &&
          route >= 0 &&
          route < (built?.model?.proxyEndpoints[endpoint]?.routes.length ?? 0);
        if (routed) {
          routes[endpoint] = route;
          post();
        }
        break;
      }
      case 'flowBack':
        await travel('back');
        break;
      case 'flowForward':
        await travel('forward');
        break;
      case 'flowSource':
        if (
          typeof message.source === 'string' &&
          environmentsOf().sources.some(item => item.id === message.source)
        ) {
          source = message.source;
          await build();
        }
        break;
      case 'showFlow': {
        // Only the shared flow of a flow hook on show, in the same environment
        const view = built;
        const hook = Object.values(view?.context.hooks ?? {}).find(
          item => item.sharedFlow === message.name,
        );
        if (
          view &&
          hook &&
          message.kind === 'sharedflows' &&
          message.environment === view.source
        ) {
          await show({
            kind: 'sharedflows',
            name: hook.sharedFlow,
            environment: view.source,
          });
        }
        break;
      }
      case 'compare': {
        const view = built;
        const current = subject;
        if (
          view?.shown &&
          current?.directory &&
          view.subject === current &&
          message.kind === current.kind &&
          message.name === current.name &&
          message.environment === view.source
        ) {
          await host.compare(
            current.kind,
            current.name,
            view.source,
            current.directory,
            view.shown,
          );
        }
        break;
      }
      case 'refresh':
        // The new deployments rebuild an environment's flow when they arrive
        hooks.clear();
        await host.refresh();
        break;
      case 'signIn':
        if (vscode.workspace.isTrusted) host.signIn();
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
   * Opens a place of the model on show, or of a flow hook's shared flow,
   * beside the panel.
   */
  async function openPlace(at: number, hook: unknown): Promise<void> {
    const view = built;
    const flow = flowHookPoints.includes(hook as FlowHookPoint)
      ? view?.hookFlows?.[hook as FlowHookPoint]
      : undefined;
    if (hook !== undefined && !flow) return;
    const model = flow ? flow.model : view?.model;
    const place = Number.isInteger(at) ? model?.places[at] : undefined;
    if (!view || !place) return;
    let uri: vscode.Uri | undefined;
    if (flow) {
      uri = host.revisionDocument(
        flow.organization,
        flow.row,
        flow.cell.revision,
        flow.files,
        place.file,
      );
    } else if (view.source && view.shown) {
      uri = host.revisionDocument(
        view.shown.organization,
        view.shown.row,
        view.shown.cell.revision,
        view.shown.files,
        place.file,
      );
    } else if (!view.source && view.subject.directory) {
      uri = vscode.Uri.file(
        path.join(
          view.subject.directory,
          place.file.slice(bundleDirectory(view.subject.kind).length + 1),
        ),
      );
    }
    if (!uri) return;
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      const position = document.positionAt(place.offset);
      await vscode.window.showTextDocument(document, {
        // A split view to the right of the flow
        viewColumn: vscode.ViewColumn.Beside,
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
