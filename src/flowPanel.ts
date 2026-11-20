// The flow view: a panel beside the editor that shows how Apigee runs the
// flows of a bundle. It reads the bundle from the workspace, so it works
// offline, signed out, and in Restricted Mode.
import path from 'node:path';
import * as vscode from 'vscode';
import { findBundleRoot } from './bundle';
import type { WorkspaceBundle } from './dashboard';
import { flowModel, flowView, type FlowModel } from './flow';
import type {
  FlowView,
  HostMessage,
  Kind,
  Note,
  WebviewMessage,
} from './protocol';
import { bundleDirectory, readBundle } from './revision';

const viewType = 'apigeeTools.flow';

/** What the flow panel needs from the dashboard, which registers it. */
export type FlowHost = {
  /** Finds the bundles in the workspace. */
  scanWorkspace(): Promise<WorkspaceBundle[]>;
  /** The page of the flow view, with the dashboard's scripts and styles. */
  pageHtml(webview: vscode.Webview): string;
};

/** The bundle the panel shows: a directory in the workspace. */
type Subject = { kind: Kind; name: string; directory: string };

/**
 * Registers the Show Flow command and its panel. Returns what the dashboard
 * calls: a reload of the page after the webview was rebuilt in development.
 */
export function registerFlowPanel(
  context: vscode.ExtensionContext,
  host: FlowHost,
): { reload(): void } {
  const webviewRoot = vscode.Uri.joinPath(
    context.extensionUri,
    'dist',
    'webview',
  );
  let panel: vscode.WebviewPanel | undefined;
  let ready = false;
  let subject: Subject | undefined;
  let model: FlowModel | undefined;
  let problem: Note | undefined;
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
   * the active editor's, or else one picked from the workspace.
   */
  async function showFlow(argument?: unknown): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const uri =
      argument instanceof vscode.Uri ? argument : editor?.document.uri;
    origin = editor?.viewColumn;
    const directory = uri?.scheme === 'file' && findBundleRoot(uri.fsPath);
    const bundles = await host.scanWorkspace();
    if (directory) {
      show(subjectOf(directory, bundles), false);
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
    if (picked) show(subjectOf(picked.bundle.directory, bundles), true);
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
  function show(next: Subject, focus: boolean): void {
    const title = `Flow · ${next.name}`;
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
        ready = false;
      });
    }
    if (subject?.directory !== next.directory) {
      routes = [];
      watch(next.directory);
    }
    subject = next;
    void build();
  }

  /** Rebuilds the view shortly after a file of the bundle changed. */
  function watch(directory: string): void {
    watcher?.dispose();
    watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(directory), '**/*'),
    );
    const later = () => {
      clearTimeout(rebuild);
      rebuild = setTimeout(() => void build(), 300);
    };
    watcher.onDidChange(later);
    watcher.onDidCreate(later);
    watcher.onDidDelete(later);
  }

  async function build(): Promise<void> {
    const current = subject;
    if (!current) return;
    const build = ++builds;
    try {
      const files = await readBundle(current.directory, current.kind);
      if (build !== builds) return;
      model = flowModel(files, current.kind);
      problem = undefined;
    } catch (error) {
      if (build !== builds) return;
      model = undefined;
      problem = {
        tone: 'warning',
        text: `The bundle could not be read: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    version++;
    post();
  }

  /** Posts the view, but only when it changed. */
  function post(): void {
    if (!panel || !ready || !subject) return;
    const view = model
      ? flowView(model, { routes })
      : { maps: [], notes: problem ? [problem] : [] };
    const flow: FlowView = {
      version,
      kind: subject.kind,
      name: subject.name,
      path: vscode.workspace.asRelativePath(subject.directory),
      ...view,
    };
    const json = JSON.stringify(flow);
    if (json === posted) return;
    posted = json;
    const message: HostMessage = { type: 'flow', flow };
    void panel.webview.postMessage(message);
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
        if (message.version === version) await open(message.at);
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
    }
  }

  /** Opens a place of the model in the editor group Show Flow came from. */
  async function open(at: number): Promise<void> {
    const place = Number.isInteger(at) ? model?.places[at] : undefined;
    if (!place || !subject) return;
    const uri = vscode.Uri.file(
      path.join(
        subject.directory,
        place.file.slice(bundleDirectory(subject.kind).length + 1),
      ),
    );
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
        `Opening ${place.file} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    reload: () => {
      if (!panel) return;
      ready = false;
      panel.webview.html = host.pageHtml(panel.webview);
    },
  };
}
