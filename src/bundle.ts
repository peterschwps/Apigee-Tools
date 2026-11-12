import type { Dirent } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { applyDirectives } from './directives';
import { removeElementEdit } from './fixes';
import type { LintIssue } from './linter';
import { parseXml, type XmlNode, type XmlText } from './xml';

/** Describes how a policy references a resource: element and URL schemes. */
type ResourcePolicy = { element: string; schemes: readonly string[] };

const flowNameSource =
  'https://docs.cloud.google.com/apigee/docs/api-platform/reference/flow-configuration-reference#name';
const resourceSource =
  'https://docs.cloud.google.com/apigee/docs/api-platform/develop/resource-files#where-resources-are-stored';
const routeTargetSource =
  'https://docs.cloud.google.com/apigee/docs/api-platform/reference/api-proxy-configuration-reference#proxyendpoint-howtoconfigurerouterules';

// Static references; values with templates or other characters are not checked
const referencePattern = /^[A-Za-z0-9._$ %\-]+$/;

// Policies that validate messages against a bundle resource
const resourcePolicies = new Map<string, ResourcePolicy>([
  ['OASValidation', { element: 'OASResource', schemes: ['oas'] }],
  ['MessageValidation', { element: 'ResourceURL', schemes: ['xsd', 'wsdl'] }],
]);

/**
 * Returns the sorted policy names of the bundle containing the file, or none
 * outside a bundle.
 */
export async function bundlePolicyNames(filePath: string): Promise<string[]> {
  const bundleRoot = findBundleRoot(filePath);
  const names =
    bundleRoot && (await bundleNames(path.join(bundleRoot, 'policies')));
  return names ? [...names].sort() : [];
}

/**
 * Lints the references of a bundle document to other files of its bundle.
 * Those files are read from disk, so unsaved changes to them are not seen.
 */
export async function lintBundleReferences(
  xml: string,
  filePath: string,
): Promise<LintIssue[]> {
  const bundleRoot = findBundleRoot(filePath);
  if (!bundleRoot) return [];
  const document = parseXml(xml);
  if (document.syntaxIssues.length || !document.root) return [];
  const issues = await referenceIssues(xml, document.root, bundleRoot);
  return applyDirectives(xml, document.comments, issues);
}

/** Returns whether an error reports a missing file or directory. */
export function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** Runs the reference checks that apply to the root element. */
async function referenceIssues(
  xml: string,
  root: XmlNode,
  bundleRoot: string,
): Promise<LintIssue[]> {
  if (root.name === 'APIProxy' || root.name === 'SharedFlowBundle') {
    return manifestPolicyIssues(xml, root, bundleRoot);
  }
  const resourcePolicy = resourcePolicies.get(root.name);
  if (resourcePolicy) return resourceIssues(root, resourcePolicy, bundleRoot);
  if (['ProxyEndpoint', 'TargetEndpoint', 'SharedFlow'].includes(root.name)) {
    return flowReferenceIssues(root, bundleRoot);
  }
  return [];
}

/**
 * Reports policies listed in a proxy or shared flow manifest whose file is
 * missing from the bundle (AX112).
 */
async function manifestPolicyIssues(
  xml: string,
  root: XmlNode,
  bundleRoot: string,
): Promise<LintIssue[]> {
  const policies = root.children
    .filter(child => child.name === 'Policies')
    .flatMap(node => node.children)
    .flatMap(node =>
      node.name === 'Policy' &&
      node.text &&
      referencePattern.test(node.text.value)
        ? [{ node, text: node.text }]
        : [],
    );
  if (!policies.length) return [];
  const entries = await readEntries(path.join(bundleRoot, 'policies'));
  if (!entries) return [];

  // Compare with the policy files, since the manifest lists file names
  const files = new Set(entries.filter(isXmlFile).map(entry => stem(entry)));
  const reference =
    root.name === 'APIProxy' ? 'api-proxy' : 'shared-flow-bundle';
  const source = `https://docs.cloud.google.com/apigee/docs/api-platform/reference/${reference}-configuration-reference#baseconfiguration-baseconfigurationelements`;
  return policies
    .filter(({ text }) => !files.has(text.value))
    .map(({ node, text }) => ({
      rule: 'AX112',
      message: `Policy file "policies/${text.value}.xml" listed in this manifest was not found in this bundle.`,
      start: text.start,
      end: text.end,
      source,
      severity: 'warning',
      remove: removeElementEdit(xml, node),
      createFile: path.join(bundleRoot, 'policies', `${text.value}.xml`),
    }));
}

/**
 * Warns when a validation policy references a resource file that is missing
 * from the bundle; it may still exist at environment scope (AX109).
 */
async function resourceIssues(
  root: XmlNode,
  policy: ResourcePolicy,
  bundleRoot: string,
): Promise<LintIssue[]> {
  const text = root.children.find(child => child.name === policy.element)?.text;
  if (!text || /\{[^{}]+\}/.test(text.value)) return [];
  const match = /^(oas|xsd|wsdl):\/\/([^/\\]+)$/.exec(text.value);
  if (!match || !policy.schemes.includes(match[1])) return [];
  const [, scheme, fileName] = match;
  const entries = await readEntries(path.join(bundleRoot, 'resources', scheme));
  if (!entries || entries.some(entry => entry.name === fileName)) return [];
  return [
    {
      rule: 'AX109',
      message: `Resource "${fileName}" is not in this bundle; it may exist at environment scope.`,
      start: text.start,
      end: text.end,
      source: resourceSource,
      severity: 'warning',
    },
  ];
}

/**
 * Reports flow steps that reference a missing policy (AX108) and route rules
 * that reference a missing target endpoint (AX111).
 */
async function flowReferenceIssues(
  root: XmlNode,
  bundleRoot: string,
): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];
  const { steps, targets } = collectReferences(root);

  // Steps reference policies by their name attribute
  const policies = steps.length
    ? await bundleNames(path.join(bundleRoot, 'policies'))
    : undefined;
  for (const step of steps) {
    if (!policies || policies.has(step.value)) continue;
    issues.push({
      rule: 'AX108',
      message: `Policy "${step.value}" was not found in this bundle.`,
      start: step.start,
      end: step.end,
      source: flowNameSource,
    });
  }

  // Route rules reference targets by name attribute or by file name
  const endpoints = targets.length
    ? await bundleNames(path.join(bundleRoot, 'targets'), true)
    : undefined;
  for (const target of targets) {
    if (!endpoints || endpoints.has(target.value)) continue;
    issues.push({
      rule: 'AX111',
      message: `Target endpoint "${target.value}" was not found in this proxy bundle.`,
      start: target.start,
      end: target.end,
      source: routeTargetSource,
    });
  }
  return issues;
}

/** Collects static `Step/Name` and `RouteRule/TargetEndpoint` references. */
function collectReferences(root: XmlNode): {
  steps: XmlText[];
  targets: XmlText[];
} {
  const steps: XmlText[] = [];
  const targets: XmlText[] = [];
  const visit = (node: XmlNode, parent?: XmlNode): void => {
    const reference = node.text;
    if (reference && referencePattern.test(reference.value)) {
      if (node.name === 'Name' && parent?.name === 'Step') {
        steps.push(reference);
      }
      if (node.name === 'TargetEndpoint' && parent?.name === 'RouteRule') {
        targets.push(reference);
      }
    }
    for (const child of node.children) visit(child, node);
  };
  visit(root);
  return { steps, targets };
}

/** Returns the enclosing `apiproxy` or `sharedflowbundle` directory. */
function findBundleRoot(filePath: string): string | undefined {
  let directory = path.dirname(filePath);
  while (path.dirname(directory) !== directory) {
    const name = path.basename(directory).toLowerCase();
    if (name === 'apiproxy' || name === 'sharedflowbundle') return directory;
    directory = path.dirname(directory);
  }
  return undefined;
}

/**
 * Reads the root `name` attribute of each XML file in a bundle directory,
 * optionally adding the file names. Returns nothing when the directory cannot
 * be read.
 */
async function bundleNames(
  directory: string,
  includeFileNames = false,
): Promise<Set<string> | undefined> {
  const entries = await readEntries(directory);
  if (!entries) return undefined;
  const names = await Promise.all(
    entries.filter(isXmlFile).map(async entry => {
      const fileNames = includeFileNames ? [stem(entry)] : [];

      // Files that cannot be read contribute only their file name
      try {
        const xml = await readFile(path.join(directory, entry.name), 'utf8');
        const name = parseXml(xml).root?.attributes.find(
          attribute => attribute.name === 'name',
        )?.value;
        return name ? [name, ...fileNames] : fileNames;
      } catch {
        return fileNames;
      }
    }),
  );
  return new Set(names.flat());
}

/**
 * Lists a directory: empty when it does not exist, and nothing when it cannot
 * be read, so that callers skip checks they cannot decide.
 */
async function readEntries(directory: string): Promise<Dirent[] | undefined> {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    return isNotFound(error) ? [] : undefined;
  }
}

/** Returns whether an entry is an XML file, with the extension in any case. */
function isXmlFile(entry: Dirent): boolean {
  return entry.isFile() && entry.name.toLowerCase().endsWith('.xml');
}

/** Returns the name of an XML file without its extension. */
function stem(entry: Dirent): string {
  return entry.name.slice(0, -'.xml'.length);
}
