import { isIP } from 'node:net';
import policyPrefixData from '../data/policy-prefixes.json';
import { applyDirectives } from './directives';
import { closestValue, type TextEdit } from './fixes';
import {
  elementMap,
  normalizeEnumValue,
  ownValue,
  type DocumentKind,
  type DocumentSpec,
  type ElementSpec,
  type ValueSpec,
} from './spec';
import { parseXml, type XmlDocument, type XmlNode } from './xml';

/** Describes a finding; offsets refer to the linted document. */
export type LintIssue = {
  /** Rule ID such as `AX105`. */
  rule: string;
  message: string;
  start: number;
  end: number;
  /** Link to the documentation the finding is based on. */
  source?: string;
  /** Severity of the finding; absent means `error`. */
  severity?: 'error' | 'warning';
  /** Documented value that likely replaces a mistyped one. */
  replacement?: string;
  /** Edit removing a stale manifest entry. */
  remove?: TextEdit;
  /** Bundle-local file to create for a missing manifest entry. */
  createFile?: string;
};

/** Holds what the element checks of one document share. */
type CheckContext = {
  /** Element specifications by path. */
  elements: ReadonlyMap<string, ElementSpec>;
  /** Names of all documented elements, to tell misplaced from unknown ones. */
  knownNames: ReadonlySet<string>;
  /** Whether to check required and repeated content. */
  checkContent: boolean;
  issues: LintIssue[];
};

// Bundle locations of the document kinds; the first matching pattern wins
const documentLocations: readonly [RegExp, DocumentKind][] = [
  [/\/(?:apiproxy|sharedflowbundle)\/policies\/[^/]+\.xml$/, 'policy'],
  [/\/apiproxy\/proxies\/[^/]+\.xml$/, 'proxyEndpoint'],
  [/\/apiproxy\/targets\/[^/]+\.xml$/, 'targetEndpoint'],
  [/\/apiproxy\/integration-endpoints\/[^/]+\.xml$/, 'integrationEndpoint'],
  [/\/apiproxy\/[^/]+\.xml$/, 'apiProxy'],
  [/\/sharedflowbundle\/sharedflows\/[^/]+\.xml$/, 'sharedFlow'],
  [/\/sharedflowbundle\/[^/]+\.xml$/, 'sharedFlowBundle'],
];

// Root elements of the document kinds that allow only one root
const expectedRoots: Partial<Record<DocumentKind, string>> = {
  apiProxy: 'APIProxy',
  proxyEndpoint: 'ProxyEndpoint',
  targetEndpoint: 'TargetEndpoint',
  integrationEndpoint: 'IntegrationEndpoint',
  sharedFlowBundle: 'SharedFlowBundle',
  sharedFlow: 'SharedFlow',
};

// Selected policy name prefixes and the naming conventions they are based on
const policyPrefixes: Readonly<Record<string, string>> =
  policyPrefixData.prefixes;
const namingConventions = policyPrefixData.source;

/** Classifies a file by its location in an API proxy or shared flow bundle. */
export function classifyDocument(filePath: string): DocumentKind | undefined {
  // A leading slash lets relative paths match like absolute ones
  const normalized = `/${filePath.replace(/\\/g, '/').toLowerCase()}`;
  return documentLocations.find(([pattern]) => pattern.test(normalized))?.[1];
}

/**
 * Returns the specification of a root element, looked up within the document
 * kind of the file's location or, for standalone files, among all kinds.
 */
export function chooseSpec(
  filePath: string,
  rootName: string,
  specs: readonly DocumentSpec[],
): DocumentSpec | undefined {
  const kind = classifyDocument(filePath);
  return specs.find(
    spec => spec.root === rootName && (!kind || spec.kind === kind),
  );
}

/**
 * Lints a document against the reviewed specifications. Inline directives and
 * `ignoredRules` suppress findings.
 */
export function lint(
  xml: string,
  filePath: string,
  specs: readonly DocumentSpec[],
  ignoredRules: ReadonlySet<string> = new Set(),
): LintIssue[] {
  // A newly created file is empty until its root element is typed
  if (!xml.trim()) return [];
  const parsed = parseXml(xml);
  const issues = lintDocument(parsed, filePath, specs);
  return applyDirectives(xml, parsed.comments, issues).filter(
    issue => !ignoredRules.has(issue.rule),
  );
}

/** Collects syntax issues and the findings of the matching specification. */
function lintDocument(
  parsed: XmlDocument,
  filePath: string,
  specs: readonly DocumentSpec[],
): LintIssue[] {
  const issues: LintIssue[] = parsed.syntaxIssues.map(issue => ({
    rule: 'AX001',
    ...issue,
  }));
  const root = parsed.root;
  if (!root) return issues;

  // Report a wrong root where the file's location determines the document type
  const kind = classifyDocument(filePath);
  const spec = chooseSpec(filePath, root.name, specs);
  if (!spec) {
    const expectedRoot = kind && expectedRoots[kind];
    if (expectedRoot) {
      issues.push({
        rule: 'AX101',
        message: `Expected <${expectedRoot}> as the document root.`,
        ...nameRange(root),
      });
    }
    return issues;
  }

  // Check the element tree
  // Content checks need a complete document, so syntax errors skip them
  const valid = !parsed.syntaxIssues.length;
  const knownNames = spec.elements.map(element =>
    element.path.slice(element.path.lastIndexOf('/') + 1),
  );
  checkElement(root, `/${root.name}`, {
    elements: elementMap(spec),
    knownNames: new Set(knownNames),
    checkContent: valid,
    issues,
  });
  if (spec.kind === 'policy' && valid) {
    issues.push(...policyNameIssues(root, filePath, kind));
  }
  return issues;
}

/**
 * Checks an element and, recursively, its children against the specification
 * at `path`. Elements without a specification are not checked.
 */
function checkElement(
  node: XmlNode,
  path: string,
  context: CheckContext,
): void {
  const spec = context.elements.get(path);
  if (!spec) return;
  const issues = context.issues;
  if (spec.warning) {
    issues.push({
      rule: 'AX110',
      message: spec.warning,
      ...nameRange(node),
      source: spec.source,
      severity: 'warning',
    });
  }
  issues.push(...attributeIssues(node, spec));
  if (context.checkContent) issues.push(...contentIssues(node, spec));
  const issue = textIssue(node, spec);
  if (issue) issues.push(issue);

  // Report children the specification does not allow and check the others
  for (const child of node.children) {
    const childPath = `${path}/${child.name}`;
    const allowed =
      context.elements.has(childPath) ||
      !spec.complete ||
      spec.allowAnyChildren ||
      (spec.children ?? []).includes(child.name);
    if (allowed) {
      checkElement(child, childPath, context);
      continue;
    }

    // A documented element in another place is misplaced rather than unknown
    const misplaced = context.knownNames.has(child.name);
    issues.push({
      rule: misplaced ? 'AX102' : 'AX101',
      message: misplaced
        ? `<${child.name}> is not allowed inside <${node.name}>.`
        : `Unknown element <${child.name}> inside <${node.name}>.`,
      ...nameRange(child),
      source: spec.source,
    });
  }
}

/** Reports unknown attributes and invalid attribute values. */
function attributeIssues(node: XmlNode, spec: ElementSpec): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const attribute of node.attributes) {
    const attributeSpec = ownValue(spec.attributes, attribute.name);

    // Report unknown attributes; namespace declarations are always allowed
    if (!attributeSpec) {
      const namespace =
        attribute.name === 'xmlns' || attribute.name.startsWith('xmlns:');
      if (spec.complete && !spec.allowAnyAttributes && !namespace) {
        issues.push({
          rule: 'AX103',
          message: `Unknown attribute "${attribute.name}" on <${node.name}>.`,
          start: attribute.start,
          end: attribute.end,
          source: spec.source,
        });
      }
      continue;
    }

    // Check the value of documented attributes
    const { value, valueStart, valueEnd } = attribute;
    if (
      value === undefined ||
      valueStart === undefined ||
      valueEnd === undefined
    ) {
      continue;
    }
    const issue = valueIssue(
      value,
      attributeSpec,
      valueStart,
      valueEnd,
      attributeSpec.source || spec.source,
    );
    if (issue) issues.push(issue);
  }
  return issues;
}

/**
 * Checks the text of a leaf element, against the constraint selected by an
 * attribute value when the specification defines one.
 */
function textIssue(node: XmlNode, spec: ElementSpec): LintIssue | undefined {
  const selector = spec.textByAttribute;
  const selectorValue = node.attributes.find(
    attribute => attribute.name === selector?.attribute,
  )?.value;
  const selected = selectorValue
    ? ownValue(selector?.values, selectorValue)
    : undefined;
  const textSpec = selected || spec.text;
  if (!textSpec || !node.text) return undefined;
  return valueIssue(
    node.text.value,
    textSpec,
    node.text.start,
    node.text.end,
    spec.source,
  );
}

/** Checks a value against its documented constraint. */
function valueIssue(
  value: string,
  spec: ValueSpec,
  start: number,
  end: number,
  source: string,
): LintIssue | undefined {
  // Message templates are only resolved at runtime
  if (spec.allowTemplate && /\{[^{}]+\}/.test(value)) return undefined;

  // Report undocumented enum values with the closest documented value
  if (spec.kind === 'enum' && spec.values) {
    const normalized = normalizeEnumValue(value, spec);
    const documented = spec.values.some(
      candidate => normalizeEnumValue(candidate, spec) === normalized,
    );
    if (!documented) {
      const replacement = closestValue(value, spec.values, text =>
        normalizeEnumValue(text, spec),
      );
      const hint = replacement ? ` Did you mean "${replacement}"?` : '';
      return {
        rule: 'AX105',
        message: `Expected one of: ${spec.values.join(', ')}.${hint}`,
        start,
        end,
        source,
        replacement,
      };
    }
  }

  // Report values in the wrong format
  if (
    spec.kind === 'format' &&
    spec.pattern &&
    !new RegExp(spec.pattern).test(value)
  ) {
    return {
      rule: 'AX106',
      message: spec.format || 'Value does not match the documented format.',
      start,
      end,
      source,
    };
  }
  if (spec.kind === 'format' && spec.formatType === 'ip' && isIP(value) === 0) {
    return {
      rule: 'AX106',
      message: spec.format || 'Value is not a valid IP address.',
      start,
      end,
      source,
    };
  }

  // Warn about documented values with known caveats
  const warning = ownValue(spec.warningValues, value);
  if (warning) {
    return {
      rule: 'AX110',
      message: warning,
      start,
      end,
      source,
      severity: 'warning',
    };
  }
  return undefined;
}

/** Reports missing, repeated, and conflicting content of an element. */
function contentIssues(node: XmlNode, spec: ElementSpec): LintIssue[] {
  return [
    ...requiredIssues(node, spec),
    ...groupIssues(node, spec),
    ...singleChildIssues(node, spec),
    ...duplicateAttributeIssues(node, spec),
    ...textLimitIssues(node, spec),
    ...conditionalIssues(node, spec),
    ...conflictIssues(node, spec),
  ];
}

/** Reports missing required attributes and children (AX104). */
function requiredIssues(node: XmlNode, spec: ElementSpec): LintIssue[] {
  const issues: LintIssue[] = [];
  const present = new Set(node.attributes.map(attribute => attribute.name));
  for (const [name, attribute] of Object.entries(spec.attributes ?? {})) {
    if (attribute.required && !present.has(name)) {
      issues.push({
        rule: 'AX104',
        message: `Missing required attribute "${name}" on <${node.name}>.`,
        ...nameRange(node),
        source: attribute.source || spec.source,
      });
    }
  }
  for (const child of spec.requiredChildren ?? []) {
    if (!node.children.some(item => item.name === child)) {
      issues.push({
        rule: 'AX104',
        message: `Missing required <${child}> inside <${node.name}>.`,
        ...nameRange(node),
        source: spec.source,
      });
    }
  }
  return issues;
}

/**
 * Reports groups of children or attributes outside their count limits; an
 * excess is reported at the first item beyond the maximum (AX107).
 */
function groupIssues(node: XmlNode, spec: ElementSpec): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const group of spec.childGroups ?? []) {
    const names = group.children.join(', ');
    const matching = node.children.filter(child =>
      group.children.includes(child.name),
    );
    if (group.min !== undefined && matching.length < group.min) {
      issues.push({
        rule: 'AX107',
        message: `Expected at least ${group.min} of: ${names}.`,
        ...nameRange(node),
        source: group.source,
      });
    }
    if (group.max !== undefined && matching.length > group.max) {
      issues.push({
        rule: 'AX107',
        message: `Expected at most ${group.max} of: ${names}.`,
        ...nameRange(matching[group.max]),
        source: group.source,
      });
    }
  }
  for (const group of spec.attributeGroups ?? []) {
    const names = group.attributes.join(', ');
    const matching = node.attributes.filter(attribute =>
      group.attributes.includes(attribute.name),
    );
    if (group.min !== undefined && matching.length < group.min) {
      issues.push({
        rule: 'AX107',
        message: `Expected at least ${group.min} of attributes: ${names}.`,
        ...nameRange(node),
        source: group.source,
      });
    }
    if (group.max !== undefined && matching.length > group.max) {
      const excess = matching[group.max];
      issues.push({
        rule: 'AX107',
        message: `Expected at most ${group.max} of attributes: ${names}.`,
        start: excess.start,
        end: excess.end,
        source: group.source,
      });
    }
  }
  return issues;
}

/** Reports the second occurrence of children allowed only once (AX107). */
function singleChildIssues(node: XmlNode, spec: ElementSpec): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const name of spec.singleChildren ?? []) {
    const matching = node.children.filter(child => child.name === name);
    if (matching.length > 1) {
      issues.push({
        rule: 'AX107',
        message: `Only one <${name}> is allowed inside <${node.name}>.`,
        ...nameRange(matching[1]),
        source: spec.source,
      });
    }
  }
  return issues;
}

/** Reports repeated values of an attribute that must be unique (AX107). */
function duplicateAttributeIssues(
  node: XmlNode,
  spec: ElementSpec,
): LintIssue[] {
  const unique = spec.uniqueChildAttribute;
  if (!unique) return [];
  const issues: LintIssue[] = [];
  const seen = new Set<string>();
  for (const child of node.children) {
    if (child.name !== unique.child) continue;
    const attribute = child.attributes.find(
      item => item.name === unique.attribute,
    );
    if (!attribute?.value) continue;
    if (seen.has(attribute.value)) {
      issues.push({
        rule: 'AX107',
        message: `Duplicate ${unique.child} ${unique.attribute} "${attribute.value}".`,
        start: attribute.valueStart ?? child.nameStart,
        end: attribute.valueEnd ?? child.nameEnd,
        source: unique.source,
      });
    }
    seen.add(attribute.value);
  }
  return issues;
}

/** Reports each child text beyond the documented maximum (AX107). */
function textLimitIssues(node: XmlNode, spec: ElementSpec): LintIssue[] {
  const limit = spec.childTextLimit;
  if (!limit) return [];
  const issues: LintIssue[] = [];
  let count = 0;
  for (const child of node.children) {
    if (child.name !== limit.child) continue;
    for (const nested of child.children) {
      if (nested.name !== limit.descendant) continue;
      if (nested.text?.value !== limit.value) continue;
      count++;
      if (count > limit.max) {
        issues.push({
          rule: 'AX107',
          message: `At most ${limit.max} <${limit.child}> may have <${limit.descendant}>${limit.value}</${limit.descendant}>.`,
          ...nameRange(nested),
          source: limit.source,
        });
      }
    }
  }
  return issues;
}

/** Reports children that the value of another element requires (AX104). */
function conditionalIssues(node: XmlNode, spec: ElementSpec): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const condition of spec.conditionalRequiredChildren ?? []) {
    // Follow the selector path to the element that decides
    let selected: XmlNode | undefined = node;
    for (const name of condition.selector) {
      selected = selected?.children.find(child => child.name === name);
    }
    if (!selected) continue;
    const value = selected.text?.value ?? '';
    if (condition.values && !condition.values.includes(value)) continue;

    if (!node.children.some(child => child.name === condition.required)) {
      issues.push({
        rule: 'AX104',
        message: `<${condition.required}> is required when <${condition.selector.join('/')}> has this value.`,
        ...nameRange(node),
        source: condition.source,
      });
    }
  }
  return issues;
}

/** Reports content combined with a conflicting child (AX107). */
function conflictIssues(node: XmlNode, spec: ElementSpec): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const conflict of spec.conflicts ?? []) {
    const first = conflict.attribute
      ? node.attributes.find(attribute => attribute.name === conflict.attribute)
      : node.children.find(child => child.name === conflict.child);
    const second = node.children.find(
      child => child.name === conflict.withChild,
    );
    if (!first || !second) continue;
    const label = conflict.attribute
      ? `attribute "${conflict.attribute}"`
      : `<${conflict.child}>`;
    issues.push({
      rule: 'AX107',
      message: `${label} cannot be combined with <${conflict.withChild}>.`,
      ...nameRange(second),
      source: conflict.source,
    });
  }
  return issues;
}

/**
 * Checks a policy name against the prefix for its type (AX113) and, inside a
 * bundle, against the file name (AX114).
 */
function policyNameIssues(
  root: XmlNode,
  filePath: string,
  kind: DocumentKind | undefined,
): LintIssue[] {
  const name = root.attributes.find(attribute => attribute.name === 'name');
  if (!name?.value?.trim()) return [];
  if (name.valueStart === undefined || name.valueEnd === undefined) return [];
  const issues: LintIssue[] = [];
  const prefix = ownValue(policyPrefixes, root.name);
  if (prefix && !name.value.startsWith(prefix)) {
    issues.push({
      rule: 'AX113',
      severity: 'warning',
      message: `Policy name "${name.value}" should start with "${prefix}" for <${root.name}>.`,
      start: name.valueStart,
      end: name.valueEnd,
      source: namingConventions,
    });
  }

  // Compare with the file name without its extension
  // Standalone files are exempt, since only bundles tie file names to policies
  if (kind === 'policy') {
    const fileName = filePath.replace(/\\/g, '/').split('/').at(-1)!;
    if (fileName.slice(0, -'.xml'.length) !== name.value) {
      issues.push({
        rule: 'AX114',
        message: `Policy file name "${fileName}" does not match policy name "${name.value}".`,
        start: name.valueStart,
        end: name.valueEnd,
        source: namingConventions,
      });
    }
  }
  return issues;
}

/** Returns the range of an element name, where element-level issues appear. */
function nameRange(node: XmlNode): { start: number; end: number } {
  return { start: node.nameStart, end: node.nameEnd };
}
