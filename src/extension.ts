import { minimatch } from 'minimatch';
import * as vscode from 'vscode';
import { bundlePolicyNames, lintBundleReferences } from './bundle';
import { complete, type Suggestion } from './completion';
import { disableDirectiveEdit, type TextEdit } from './fixes';
import { classifyDocument, lint, type LintIssue } from './linter';
import {
  loadSpecifications,
  type DocumentKind,
  type DocumentSpec,
} from './spec';
import { rootElementName } from './xml';

/** Lint results of one document version, kept for its quick fixes. */
type Published = { version: number; issues: LintIssue[] };

const setting = 'apigeeTools';
const diagnosticSource = 'Apigee Tools';
const delayMs = 250;
const xmlFiles: vscode.DocumentSelector = { language: 'xml', scheme: 'file' };
const completionTriggers = ['<', ' ', '=', '"', "'", '>'];

// Documents whose steps reference policies, which completion suggests
const stepDocuments: ReadonlySet<DocumentKind | undefined> = new Set([
  'proxyEndpoint',
  'targetEndpoint',
  'sharedFlow',
]);

// Documents to re-lint when bundle files change
const referenceDocuments: ReadonlySet<DocumentKind | undefined> = new Set([
  ...stepDocuments,
  'apiProxy',
  'sharedFlowBundle',
]);
const resourceDocuments: ReadonlySet<DocumentKind | undefined> = new Set([
  'policy',
]);

const completionKinds: Record<Suggestion['kind'], vscode.CompletionItemKind> = {
  element: vscode.CompletionItemKind.Class,
  attribute: vscode.CompletionItemKind.Property,
  value: vscode.CompletionItemKind.Value,
};

/** Activates diagnostics, quick fixes, and completion for Apigee bundle XML. */
export function activate(context: vscode.ExtensionContext): void {
  const specs = loadSpecifications(context.extensionPath);
  const diagnostics =
    vscode.languages.createDiagnosticCollection('apigee-tools');
  const log = vscode.window.createOutputChannel('Apigee Tools', { log: true });
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  // Published issues keep the fix data that diagnostics cannot carry
  const published = new Map<string, Published>();
  context.subscriptions.push(diagnostics, log);

  function clear(uri: vscode.Uri): void {
    diagnostics.delete(uri);
    published.delete(uri.toString());
  }

  /** Lints a document and publishes the result unless it changed meanwhile. */
  async function update(document: vscode.TextDocument): Promise<void> {
    if (!applicable(document, specs)) {
      clear(document.uri);
      return;
    }
    const ignored = new Set(settings(document).get<string[]>('ignore', []));
    const version = document.version;
    const xml = document.getText();
    const issues = lint(xml, document.uri.fsPath, specs, ignored);
    const bundleIssues = await lintBundleReferences(xml, document.uri.fsPath);

    // Discard the result if the document changed, closed, or became excluded
    // while bundle files were read
    if (
      document.isClosed ||
      document.version !== version ||
      !applicable(document, specs)
    ) {
      return;
    }
    issues.push(...bundleIssues.filter(issue => !ignored.has(issue.rule)));
    diagnostics.set(
      document.uri,
      issues.map(issue => toDiagnostic(document, issue)),
    );
    published.set(document.uri.toString(), { version, issues });
  }

  function cancel(key: string): void {
    const timer = timers.get(key);
    if (timer) clearTimeout(timer);
    timers.delete(key);
  }

  /** Lints a document after a delay that restarts on every change. */
  function schedule(document: vscode.TextDocument, delay = delayMs): void {
    const key = document.uri.toString();
    cancel(key);
    const version = document.version;
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        if (document.version !== version) return;
        update(document).catch((error: unknown) =>
          log.error(`Linting ${document.uri.fsPath} failed:`, error),
        );
      }, delay),
    );
  }

  /** Re-lints the open documents of the given kinds. */
  function refresh(kinds: ReadonlySet<DocumentKind | undefined>): void {
    for (const document of vscode.workspace.textDocuments) {
      if (kinds.has(classifyDocument(document.uri.fsPath))) schedule(document);
    }
  }

  // Watch the bundle files that references and resource checks depend on
  const referenceWatcher = vscode.workspace.createFileSystemWatcher(
    '**/{apiproxy,sharedflowbundle}/{policies,targets}/*.xml',
  );
  const resourceWatcher = vscode.workspace.createFileSystemWatcher(
    '**/{apiproxy,sharedflowbundle}/resources/{oas,xsd,wsdl}/*',
  );
  const refreshReferences = () => refresh(referenceDocuments);
  const refreshResources = () => refresh(resourceDocuments);

  context.subscriptions.push(
    referenceWatcher,
    resourceWatcher,
    referenceWatcher.onDidCreate(refreshReferences),
    referenceWatcher.onDidChange(refreshReferences),
    referenceWatcher.onDidDelete(refreshReferences),
    resourceWatcher.onDidCreate(refreshResources),
    resourceWatcher.onDidChange(refreshResources),
    resourceWatcher.onDidDelete(refreshResources),
    vscode.workspace.onDidOpenTextDocument(document => schedule(document, 0)),
    vscode.workspace.onDidChangeTextDocument(event => schedule(event.document)),
    vscode.workspace.onDidSaveTextDocument(document => schedule(document, 0)),
    vscode.workspace.onDidCloseTextDocument(document => {
      cancel(document.uri.toString());
      clear(document.uri);
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration(setting)) return;
      for (const document of vscode.workspace.textDocuments) {
        schedule(document, 0);
      }
    }),
    vscode.languages.registerCompletionItemProvider(
      xmlFiles,
      {
        async provideCompletionItems(document, position) {
          if (!applicable(document, specs)) return [];
          const xml = document.getText();
          const offset = document.offsetAt(position);
          // ponytail: reads the policies directory per request;
          // cache per bundle if large bundles feel slow.
          const policyNames = stepDocuments.has(
            classifyDocument(document.uri.fsPath),
          )
            ? await bundlePolicyNames(document.uri.fsPath)
            : [];
          const suggestions = complete(
            xml,
            offset,
            document.uri.fsPath,
            specs,
            policyNames,
          );
          return suggestions.map(suggestion =>
            toCompletionItem(document, suggestion),
          );
        },
      },
      ...completionTriggers,
    ),
    vscode.languages.registerCodeActionsProvider(
      xmlFiles,
      {
        provideCodeActions(document, _range, codeActionContext) {
          // Fixes need the issues of the diagnostics' document version
          const current = published.get(document.uri.toString());
          if (!current || current.version !== document.version) return [];
          return codeActionContext.diagnostics
            .filter(diagnostic => diagnostic.source === diagnosticSource)
            .flatMap(diagnostic =>
              quickFixes(document, diagnostic, current.issues),
            );
        },
      },
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
    {
      dispose: () => {
        for (const timer of timers.values()) clearTimeout(timer);
        timers.clear();
      },
    },
  );

  for (const document of vscode.workspace.textDocuments) schedule(document, 0);
}

export function deactivate(): void {
  // Resources are disposed through the extension context.
}

function settings(
  document: vscode.TextDocument,
): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(setting, document.uri);
}

/**
 * Returns whether the extension handles a document: an enabled XML file that
 * is not excluded and lies in a bundle or has a documented root element.
 */
function applicable(
  document: vscode.TextDocument,
  specs: readonly DocumentSpec[],
): boolean {
  if (document.languageId !== 'xml' || document.uri.scheme !== 'file') {
    return false;
  }
  const config = settings(document);
  if (!config.get<boolean>('enabled', true)) return false;

  // Match exclude patterns against the workspace-relative path
  const relative = vscode.workspace
    .asRelativePath(document.uri, false)
    .replace(/\\/g, '/');
  const excluded = config
    .get<string[]>('exclude', [])
    .some(pattern => minimatch(relative, pattern, { dot: true }));
  if (excluded) return false;
  if (classifyDocument(document.uri.fsPath)) return true;

  // Outside a bundle, a documented root element qualifies the file
  const root = rootElementName(document.getText());
  return Boolean(root && specs.some(spec => spec.root === root));
}

/** Converts a finding to a diagnostic whose code links the documentation. */
function toDiagnostic(
  document: vscode.TextDocument,
  issue: LintIssue,
): vscode.Diagnostic {
  const severity =
    issue.severity === 'warning'
      ? vscode.DiagnosticSeverity.Warning
      : vscode.DiagnosticSeverity.Error;
  const diagnostic = new vscode.Diagnostic(
    toRange(document, issue.start, issue.end),
    issue.message,
    severity,
  );
  diagnostic.source = diagnosticSource;
  diagnostic.code = issue.source
    ? { value: issue.rule, target: vscode.Uri.parse(issue.source) }
    : issue.rule;
  return diagnostic;
}

/**
 * Returns the quick fixes for a diagnostic: the documented replacement, the
 * manifest fixes of AX112, and a directive that disables the rule.
 */
function quickFixes(
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic,
  issues: readonly LintIssue[],
): vscode.CodeAction[] {
  // Find the finding behind the diagnostic by rule and start
  const rule = ruleOf(diagnostic);
  const start = document.offsetAt(diagnostic.range.start);
  const issue = issues.find(item => item.rule === rule && item.start === start);
  if (!issue) return [];

  const actions: vscode.CodeAction[] = [];
  const { replacement, remove, createFile } = issue;
  if (replacement) {
    const action = fixAction(`Change to "${replacement}"`, diagnostic, edit =>
      edit.replace(document.uri, diagnostic.range, replacement),
    );
    action.isPreferred = true;
    actions.push(action);
  }
  if (remove) {
    const action = fixAction('Remove policy reference', diagnostic, edit =>
      addTextEdit(edit, document, remove),
    );
    actions.push(action);
  }
  if (createFile) {
    const uri = vscode.Uri.file(createFile);
    const title = `Create policies/${uri.path.split('/').at(-1)}`;
    const action = fixAction(title, diagnostic, edit =>
      edit.createFile(uri, { ignoreIfExists: true }),
    );
    action.command = {
      command: 'vscode.open',
      title: 'Open policy file',
      arguments: [uri],
    };
    actions.push(action);
  }
  const directive = disableDirectiveEdit(
    document.getText(),
    issue.start,
    issue.rule,
  );
  if (directive) {
    const title = `Disable ${issue.rule} for this line`;
    const action = fixAction(title, diagnostic, edit =>
      addTextEdit(edit, document, directive),
    );
    actions.push(action);
  }
  return actions;
}

/** Creates a quick fix for a diagnostic with an edit that `fill` builds. */
function fixAction(
  title: string,
  diagnostic: vscode.Diagnostic,
  fill: (edit: vscode.WorkspaceEdit) => void,
): vscode.CodeAction {
  const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
  action.edit = new vscode.WorkspaceEdit();
  fill(action.edit);
  action.diagnostics = [diagnostic];
  return action;
}

/** Returns a diagnostic's rule ID, with or without a documentation link. */
function ruleOf(diagnostic: vscode.Diagnostic): string {
  return typeof diagnostic.code === 'object'
    ? String(diagnostic.code.value)
    : String(diagnostic.code);
}

/** Converts a suggestion to a completion item; attributes insert a snippet. */
function toCompletionItem(
  document: vscode.TextDocument,
  suggestion: Suggestion,
): vscode.CompletionItem {
  const item = new vscode.CompletionItem(
    suggestion.label,
    completionKinds[suggestion.kind],
  );
  item.range = toRange(
    document,
    suggestion.replaceStart,
    suggestion.replaceEnd,
  );
  item.insertText =
    suggestion.kind === 'attribute'
      ? new vscode.SnippetString(`${suggestion.label}="$1"`)
      : suggestion.insertText;
  if (suggestion.source) {
    item.documentation = new vscode.MarkdownString(
      `[Google Apigee reference](${suggestion.source})`,
    );
  }
  return item;
}

function addTextEdit(
  edit: vscode.WorkspaceEdit,
  document: vscode.TextDocument,
  textEdit: TextEdit,
): void {
  edit.replace(
    document.uri,
    toRange(document, textEdit.start, textEdit.end),
    textEdit.text,
  );
}

function toRange(
  document: vscode.TextDocument,
  start: number,
  end: number,
): vscode.Range {
  return new vscode.Range(document.positionAt(start), document.positionAt(end));
}
