import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  documentKinds,
  normalizeEnumValue,
  valueKinds,
  type DocumentSpec,
  type ElementSpec,
  type ValueSpec,
} from '../src/spec';

/** Checks a documentation link, labeling errors with the checked item. */
export type LinkCheck = (url: string, label: string) => void;

/** Holds what the checks of one element specification share. */
type ElementCheck = {
  /** File and element path, which prefix every error message. */
  label: string;
  element: ElementSpec;
  /** Documented child names of the element. */
  children: string[];
  document: DocumentSpec;
  checkLink: LinkCheck;
};

/** Returns the page of a documentation URL, without query and fragment. */
export function canonicalUrl(value: string): string {
  const url = new URL(value);
  return `${url.origin}${url.pathname}`;
}

/**
 * Builds a link check that requires an inventoried page and, where extracted
 * candidates list the page's anchors, an existing anchor.
 */
export function linkCheck(
  sourceUrls: ReadonlySet<string>,
  candidateAnchors: ReadonlyMap<string, ReadonlySet<string>>,
): LinkCheck {
  return (value, label) => {
    const link = new URL(value);
    const page = canonicalUrl(value);
    if (!sourceUrls.has(page)) {
      throw new Error(`${label}: source is not in the inventory.`);
    }
    if (
      link.hash &&
      candidateAnchors.has(page) &&
      !candidateAnchors.get(page)?.has(decodeURIComponent(link.hash.slice(1)))
    ) {
      throw new Error(`${label}: stale documentation anchor ${link.hash}.`);
    }
  };
}

/**
 * Validates the reviewed rule files and returns, for each documentation page,
 * whether every element based on it is completely reviewed.
 */
export async function validateReviewed(
  directory: string,
  checkLink: LinkCheck,
): Promise<Map<string, boolean>> {
  const files = (await readdir(directory)).filter(name =>
    name.endsWith('.json'),
  );
  if (!files.length) throw new Error('No reviewed rule files found.');
  let elements = 0;
  const coverage = new Map<string, boolean>();
  const documentRoots = new Set<string>();
  for (const file of files) {
    const json = await readFile(path.join(directory, file), 'utf8');
    const document = JSON.parse(json) as DocumentSpec;
    validateDocument(file, document, checkLink);

    // Allow one specification per root element and document kind
    const rootKey = `${document.kind}:${document.root}`;
    if (documentRoots.has(rootKey)) {
      throw new Error(`${file}: duplicate document root ${rootKey}.`);
    }
    documentRoots.add(rootKey);

    // Validate the elements and record the review coverage of their pages
    const paths = new Set<string>();
    for (const element of document.elements) {
      const insideRoot =
        element.path === `/${document.root}` ||
        element.path.startsWith(`/${document.root}/`);
      if (!insideRoot || paths.has(element.path)) {
        throw new Error(`${file}: invalid or duplicate path ${element.path}.`);
      }
      validateElement({
        label: `${file}: ${element.path}`,
        element,
        children: element.children || [],
        document,
        checkLink,
      });
      const page = canonicalUrl(element.source);
      coverage.set(page, (coverage.get(page) ?? true) && element.complete);
      paths.add(element.path);
      elements++;
    }
    if (!paths.has(`/${document.root}`)) {
      throw new Error(`${file}: root element definition is missing.`);
    }
  }
  console.log(
    `Validated ${elements} element contexts in ${files.length} reviewed files.`,
  );
  return coverage;
}

/** Validates the source link, root, elements, and kind of a document. */
function validateDocument(
  file: string,
  document: DocumentSpec,
  checkLink: LinkCheck,
): void {
  checkLink(document.source, file);
  if (
    !/^[A-Za-z_][\w.-]*$/.test(document.root || '') ||
    !document.elements?.length
  ) {
    throw new Error(`${file}: missing or invalid root or elements.`);
  }
  if (!(documentKinds as readonly string[]).includes(document.kind)) {
    throw new Error(`${file}: invalid document kind.`);
  }
}

/** Validates an element specification and the links of its rules. */
function validateElement(check: ElementCheck): void {
  check.checkLink(check.element.source, check.label);
  validateFlags(check);
  validateChildNames(check);
  validateUniqueChildAttribute(check);
  validateChildTextLimit(check);
  validateConditionalChildren(check);
  validateConflicts(check);
  validateGroups(check);
  validateValues(check);
}

/** Validates the completeness flag, warning, and arbitrary content flags. */
function validateFlags({ label, element }: ElementCheck): void {
  if (typeof element.complete !== 'boolean') {
    throw new Error(`${label} has no review completeness flag.`);
  }
  if (
    element.warning !== undefined &&
    (typeof element.warning !== 'string' || !element.warning.trim())
  ) {
    throw new Error(`${label} has an invalid warning.`);
  }

  // Arbitrary content requires a completely reviewed element
  if (
    element.allowAnyChildren !== undefined &&
    (element.allowAnyChildren !== true || !element.complete)
  ) {
    throw new Error(`${label} has invalid arbitrary-child coverage.`);
  }
  if (
    element.allowAnyAttributes !== undefined &&
    (element.allowAnyAttributes !== true || !element.complete)
  ) {
    throw new Error(`${label} has invalid arbitrary-attribute coverage.`);
  }
}

/** Validates the child names and the required and single children. */
function validateChildNames({ label, element, children }: ElementCheck): void {
  if (
    new Set(children).size !== children.length ||
    children.some(child => !/^[A-Za-z_][\w.-]*$/.test(child))
  ) {
    throw new Error(`${label} has invalid or duplicate children.`);
  }
  if (element.requiredChildren?.some(child => !children.includes(child))) {
    throw new Error(`${label} has a required child absent from children.`);
  }
  const singles = element.singleChildren;
  if (
    singles &&
    (new Set(singles).size !== singles.length ||
      singles.some(child => !children.includes(child)))
  ) {
    throw new Error(`${label} has invalid singleton children.`);
  }
}

/** Requires a unique child attribute to belong to a documented child. */
function validateUniqueChildAttribute(check: ElementCheck): void {
  const { label, element, children, document } = check;
  const unique = element.uniqueChildAttribute;
  if (!unique) return;
  const childPath = `${element.path}/${unique.child}`;
  const documented = document.elements.some(
    item => item.path === childPath && item.attributes?.[unique.attribute],
  );
  if (!children.includes(unique.child) || !documented) {
    throw new Error(`${label} has an invalid unique child attribute.`);
  }
  check.checkLink(unique.source, `${label} unique child attribute`);
}

/** Requires a child text limit with a documented descendant and maximum. */
function validateChildTextLimit(check: ElementCheck): void {
  const { label, element, children, document } = check;
  const limit = element.childTextLimit;
  if (!limit) return;
  const childPath = `${element.path}/${limit.child}`;
  const child = document.elements.find(item => item.path === childPath);
  if (
    !children.includes(limit.child) ||
    !child?.children?.includes(limit.descendant) ||
    !limit.value ||
    !Number.isInteger(limit.max) ||
    limit.max < 0
  ) {
    throw new Error(`${label} has an invalid child text limit.`);
  }
  check.checkLink(limit.source, `${label} child text limit`);
}

/** Requires conditional children with a selector of documented elements. */
function validateConditionalChildren(check: ElementCheck): void {
  const { label, element, children, document } = check;
  for (const condition of element.conditionalRequiredChildren || []) {
    if (
      !condition.selector.length ||
      !children.includes(condition.selector[0]) ||
      !children.includes(condition.required) ||
      condition.values?.length === 0 ||
      (condition.values &&
        new Set(condition.values).size !== condition.values.length)
    ) {
      throw new Error(`${label} has an invalid conditional child rule.`);
    }

    // Each selector step must be a documented child of the previous element
    let selectedPath = element.path;
    for (const name of condition.selector) {
      const selected = document.elements.find(
        item => item.path === selectedPath,
      );
      if (!selected?.children?.includes(name)) {
        throw new Error(`${label} has an invalid conditional selector.`);
      }
      selectedPath += `/${name}`;
    }
    if (!document.elements.some(item => item.path === selectedPath)) {
      throw new Error(`${label} has an undefined conditional selector.`);
    }
    check.checkLink(condition.source, `${label} conditional child rule`);
  }
}

/** Requires each conflict to pair one attribute or child with another child. */
function validateConflicts(check: ElementCheck): void {
  const { label, element, children } = check;
  for (const conflict of element.conflicts || []) {
    if (
      Boolean(conflict.attribute) === Boolean(conflict.child) ||
      (conflict.attribute && !element.attributes?.[conflict.attribute]) ||
      (conflict.child && !children.includes(conflict.child)) ||
      !children.includes(conflict.withChild) ||
      conflict.child === conflict.withChild
    ) {
      throw new Error(`${label} has an invalid child conflict.`);
    }
    check.checkLink(conflict.source, `${label} child conflict`);
  }
}

/** Requires groups with documented members and valid bounds. */
function validateGroups(check: ElementCheck): void {
  const { label, element, children } = check;
  for (const group of element.childGroups || []) {
    if (
      !group.children.length ||
      new Set(group.children).size !== group.children.length ||
      group.children.some(child => !children.includes(child))
    ) {
      throw new Error(`${label} has an invalid child group.`);
    }
    if (invalidBounds(group)) {
      throw new Error(`${label} has invalid child group bounds.`);
    }
    check.checkLink(group.source, `${label} child group`);
  }
  for (const group of element.attributeGroups || []) {
    if (
      !group.attributes.length ||
      new Set(group.attributes).size !== group.attributes.length ||
      group.attributes.some(attribute => !element.attributes?.[attribute]) ||
      invalidBounds(group)
    ) {
      throw new Error(`${label} has an invalid attribute group.`);
    }
    check.checkLink(group.source, `${label} attribute group`);
  }
}

/** Returns whether bounds are missing, negative, fractional, or inverted. */
function invalidBounds(group: { min?: number; max?: number }): boolean {
  const { min, max } = group;
  return (
    (min === undefined && max === undefined) ||
    [min, max].some(
      limit => limit !== undefined && (!Number.isInteger(limit) || limit < 0),
    ) ||
    (min !== undefined && max !== undefined && min > max)
  );
}

/** Validates the attribute and text value specifications of an element. */
function validateValues(check: ElementCheck): void {
  const { label, element } = check;
  for (const [name, value] of Object.entries(element.attributes || {})) {
    if (!/^[A-Za-z_][\w:.-]*$/.test(name)) {
      throw new Error(`${label} has invalid attribute ${name}.`);
    }
    validateValue(value, `${label}@${name}`);
    if (value.source) check.checkLink(value.source, `${label}@${name}`);
  }
  if (element.text) validateValue(element.text, `${label} text`);
  if (element.textByAttribute) {
    const { attribute, values } = element.textByAttribute;
    if (!element.attributes?.[attribute]) {
      throw new Error(`${label} has an unknown text selector attribute.`);
    }
    for (const [name, value] of Object.entries(values)) {
      validateValue(value, `${label} text for ${attribute}=${name}`);
    }
  }
}

/** Validates a value specification. */
function validateValue(value: ValueSpec, label: string): void {
  if (!(valueKinds as readonly string[]).includes(value.kind)) {
    throw new Error(`${label}: invalid value kind.`);
  }
  if (
    value.kind === 'enum' &&
    (!value.values?.length ||
      new Set(value.values).size !== value.values.length)
  ) {
    throw new Error(`${label}: enum values must be present and unique.`);
  }
  if (
    value.caseInsensitive !== undefined &&
    typeof value.caseInsensitive !== 'boolean'
  ) {
    throw new Error(`${label}: caseInsensitive must be boolean.`);
  }
  if (
    value.ignoreHyphens !== undefined &&
    typeof value.ignoreHyphens !== 'boolean'
  ) {
    throw new Error(`${label}: ignoreHyphens must be boolean.`);
  }

  // Warnings must describe documented enum values
  const warnings = value.warningValues;
  if (
    warnings &&
    (value.kind !== 'enum' ||
      !Object.keys(warnings).length ||
      Object.entries(warnings).some(
        ([key, message]) =>
          !value.values?.includes(key) ||
          typeof message !== 'string' ||
          !message.trim(),
      ))
  ) {
    throw new Error(`${label}: warnings must describe documented enum values.`);
  }

  // Normalization must keep enum values apart
  if ((value.caseInsensitive || value.ignoreHyphens) && value.kind !== 'enum') {
    throw new Error(`${label}: enum normalization requires kind enum.`);
  }
  if (
    value.kind === 'enum' &&
    value.values &&
    new Set(value.values.map(item => normalizeEnumValue(item, value))).size !==
      value.values.length
  ) {
    throw new Error(
      `${label}: enum values must be unique after normalization.`,
    );
  }

  // Formats need a known type or a valid pattern
  if (
    value.formatType !== undefined &&
    (value.kind !== 'format' || value.formatType !== 'ip')
  ) {
    throw new Error(`${label}: invalid format type.`);
  }
  if (value.pattern) {
    try {
      new RegExp(value.pattern);
    } catch {
      throw new Error(`${label}: invalid format pattern.`);
    }
  }
}
