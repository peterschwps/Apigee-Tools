import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** Kinds of documented constraints on attribute values and element text. */
export const valueKinds = ['free', 'enum', 'format', 'unknown'] as const;

/** Kinds of bundle documents, each with its own location and root element. */
export const documentKinds = [
  'policy',
  'apiProxy',
  'proxyEndpoint',
  'targetEndpoint',
  'integrationEndpoint',
  'sharedFlowBundle',
  'sharedFlow',
] as const;

export type DocumentKind = (typeof documentKinds)[number];

/**
 * Describes the documented constraint on an attribute value or element text.
 */
export type ValueSpec = {
  /**
   * Accepts any value (`free`), one of `values` (`enum`), or values matching
   * `pattern` or `formatType` (`format`); `unknown` marks undocumented values.
   */
  kind: (typeof valueKinds)[number];
  values?: string[];
  /** Regular expression that a `format` value must match. */
  pattern?: string;
  /** Built-in format check; `ip` accepts IPv4 and IPv6 addresses. */
  formatType?: 'ip';
  /** Diagnostic message that describes the expected format. */
  format?: string;
  /** Skips values that contain a `{variable}` message template. */
  allowTemplate?: boolean;
  /** Compares enum values ignoring case. */
  caseInsensitive?: boolean;
  /** Compares enum values ignoring hyphens. */
  ignoreHyphens?: boolean;
  /** Warning messages for documented enum values with known caveats. */
  warningValues?: Record<string, string>;
};

/** Describes a documented attribute. */
export type AttributeSpec = ValueSpec & {
  required?: boolean;
  /** Documentation link of the attribute when it differs from the element's. */
  source?: string;
};

/** Limits how many children with the listed names an element may contain. */
export type ChildGroup = {
  children: string[];
  min?: number;
  max?: number;
  source: string;
};

/** Limits how many of the listed attributes an element may carry. */
export type AttributeGroup = {
  attributes: string[];
  min?: number;
  max?: number;
  source: string;
};

/** Describes a documented element, addressed by its path from the root. */
export type ElementSpec = {
  /** Slash-separated element names from the root, such as `/Quota/Allow`. */
  path: string;
  /**
   * Whether the documentation lists every child and attribute; only then are
   * unknown children and attributes reported.
   */
  complete: boolean;
  /** Warning reported wherever the element is used, such as a deprecation. */
  warning?: string;
  /** Accepts arbitrary children, such as a free-form message payload. */
  allowAnyChildren?: boolean;
  /** Accepts arbitrary attributes, such as custom JWT claims. */
  allowAnyAttributes?: boolean;
  /** Link to the documentation section the element is based on. */
  source: string;
  attributes?: Record<string, AttributeSpec>;
  /** Names of the documented child elements. */
  children?: string[];
  requiredChildren?: string[];
  /** Children that may appear at most once. */
  singleChildren?: string[];
  childGroups?: ChildGroup[];
  attributeGroups?: AttributeGroup[];
  /**
   * Attribute whose value must be unique among the named children, such as
   * flow names.
   */
  uniqueChildAttribute?: { child: string; attribute: string; source: string };
  /**
   * Limits how many `child` elements may contain a `descendant` with the text
   * `value`, such as a single fallback server.
   */
  childTextLimit?: {
    child: string;
    descendant: string;
    value: string;
    max: number;
    source: string;
  };
  /**
   * Requires the `required` child when the element at `selector` exists and,
   * if `values` is given, has one of these texts.
   */
  conditionalRequiredChildren?: {
    selector: string[];
    values?: string[];
    required: string;
    source: string;
  }[];
  /** Attributes or children that cannot be combined with `withChild`. */
  conflicts?: {
    attribute?: string;
    child?: string;
    withChild: string;
    source: string;
  }[];
  text?: ValueSpec;
  /**
   * Selects the text constraint by an attribute value, such as a property
   * name; other values fall back to `text`.
   */
  textByAttribute?: { attribute: string; values: Record<string, ValueSpec> };
};

/** Describes the reviewed rules of one document type, such as a policy. */
export type DocumentSpec = {
  kind: DocumentKind;
  /** Name of the root element. */
  root: string;
  source: string;
  /** Date of the last documentation review. */
  reviewedAt: string;
  elements: ElementSpec[];
};

/** Loads the reviewed rule data below the package root. */
export function loadSpecifications(packageRoot: string): DocumentSpec[] {
  const directory = path.join(packageRoot, 'data', 'reviewed');
  return readdirSync(directory)
    .filter(file => file.endsWith('.json'))
    .map(file => {
      const json = readFileSync(path.join(directory, file), 'utf8');
      return JSON.parse(json) as DocumentSpec;
    });
}

/** Indexes the element specifications of a document by path. */
export function elementMap(document: DocumentSpec): Map<string, ElementSpec> {
  return new Map(document.elements.map(element => [element.path, element]));
}

/**
 * Returns the value that a record holds for a key itself. Keys come from
 * documents, so inherited members such as `constructor` must not match.
 */
export function ownValue<T>(
  record: Readonly<Record<string, T>> | undefined,
  key: string,
): T | undefined {
  return record && Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Normalizes an enum value for comparison, as the specification requires. */
export function normalizeEnumValue(value: string, spec: ValueSpec): string {
  const normalized = spec.ignoreHyphens ? value.replace(/-/g, '') : value;
  return spec.caseInsensitive ? normalized.toLowerCase() : normalized;
}
