import { chooseSpec, classifyDocument } from './linter';
import {
  elementMap,
  normalizeEnumValue,
  ownValue,
  type DocumentSpec,
  type ElementSpec,
  type ValueSpec,
} from './spec';

/** Describes a completion that replaces the text between two offsets. */
export type Suggestion = {
  label: string;
  kind: 'element' | 'attribute' | 'value';
  replaceStart: number;
  replaceEnd: number;
  insertText: string;
  /** Link to the documentation of the suggested item. */
  source?: string;
};

/** Holds the cursor position and the elements open around it. */
type Cursor = {
  offset: number;
  /** Document text before the cursor. */
  before: string;
  /** Names of the open elements, from the root to the innermost one. */
  stack: string[];
  filePath: string;
  specs: readonly DocumentSpec[];
};

/** Describes a suggestion before it is placed at the cursor. */
type Choice = { label: string; insertText?: string; source?: string };

/**
 * Suggests elements, attributes, and documented values at the cursor; inside
 * `Step/Name`, it suggests the given policy names.
 */
export function complete(
  xml: string,
  offset: number,
  filePath: string,
  specs: readonly DocumentSpec[],
  policyNames: readonly string[] = [],
): Suggestion[] {
  const { stack, partialTag } = scanToCursor(xml, offset);
  const cursor = {
    offset,
    before: xml.slice(0, offset),
    stack,
    filePath,
    specs,
  };
  return partialTag
    ? tagSuggestions(cursor, partialTag)
    : textSuggestions(cursor, policyNames);
}

/**
 * Scans the document up to the cursor and returns the open elements and, when
 * the cursor is inside a tag, that unfinished tag. Comments, CDATA, processing
 * instructions, and declarations are skipped.
 */
function scanToCursor(
  xml: string,
  offset: number,
): { stack: string[]; partialTag?: string } {
  const stack: string[] = [];
  for (let index = 0; index < offset;) {
    if (xml[index] !== '<') {
      index++;
      continue;
    }

    // Skip markup without elements; a cursor inside it gets no suggestions
    const terminator = markupTerminator(xml, index);
    if (terminator) {
      const end = xml.indexOf(terminator, index + 2);
      if (end < 0 || end + terminator.length > offset) return { stack };
      index = end + terminator.length;
      continue;
    }

    // A tag that does not end before the cursor is the one being typed
    const end = tagEnd(xml, index, offset);
    if (end >= offset) return { stack, partialTag: xml.slice(index, offset) };

    // Track open elements; an end tag closes its innermost open namesake
    const tag = xml.slice(index, end + 1);
    const match = tag.match(/^<\s*(\/?)\s*([A-Za-z_][\w:.-]*)/);
    if (match) {
      const [, closing, name] = match;
      if (closing) {
        const open = stack.lastIndexOf(name);
        if (open >= 0) stack.splice(open);
      } else if (!/\/\s*>$/.test(tag)) {
        stack.push(name);
      }
    }
    index = end + 1;
  }
  return { stack };
}

/**
 * Returns the terminator of a comment, CDATA section, processing instruction,
 * or declaration that starts at the index.
 */
function markupTerminator(xml: string, index: number): string | undefined {
  if (xml.startsWith('<!--', index)) return '-->';
  if (xml.startsWith('<![CDATA[', index)) return ']]>';
  if (xml.startsWith('<?', index)) return '?>';
  if (xml.startsWith('<!', index)) return '>';
  return undefined;
}

/**
 * Returns the index of the `>` that ends the tag at `start`, ignoring quoted
 * attribute values, or `limit` when the tag does not end before it.
 */
function tagEnd(xml: string, start: number, limit: number): number {
  let quote: string | undefined;
  for (let index = start + 1; index < limit; index++) {
    const char = xml[index];
    if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return index;
    }
  }
  return limit;
}

/** Suggests element names, attributes, or attribute values inside a tag. */
function tagSuggestions(cursor: Cursor, partial: string): Suggestion[] {
  // End tags, comments, and processing instructions get no suggestions
  if (/^<\s*\//.test(partial) || /^<!|^<\?/.test(partial)) return [];
  const elementPrefix = partial.match(/^<\s*([A-Za-z_][\w:.-]*)?$/);
  if (elementPrefix) return elementSuggestions(cursor, elementPrefix[1] || '');

  // Behind the element name, suggest attributes or attribute values
  const tagName = partial.match(/^<\s*([A-Za-z_][\w:.-]*)\b/)?.[1];
  if (!tagName) return [];
  const element = elementSpecAt(cursor, [...cursor.stack, tagName]);
  if (!element) return [];
  const value = partial.match(/([A-Za-z_][\w:.-]*)\s*=\s*(["'])([^"']*)$/);
  return value
    ? attributeValueSuggestions(cursor, element, value[1], value[3])
    : attributeSuggestions(cursor, element, partial);
}

/** Suggests the children of the open element, or document roots at the top. */
function elementSuggestions(cursor: Cursor, typed: string): Suggestion[] {
  let choices: Choice[];
  if (cursor.stack.length) {
    const parent = elementSpecAt(cursor, cursor.stack);
    choices = (parent?.children ?? []).map(name => ({
      label: name,
      source: parent?.source,
    }));
  } else {
    // Offer the roots that the file's location allows
    const kind = classifyDocument(cursor.filePath);
    choices = cursor.specs
      .filter(spec => !kind || spec.kind === kind)
      .map(spec => ({ label: spec.root, source: spec.source }));
  }
  const matching = choices.filter(choice => choice.label.startsWith(typed));
  return toSuggestions(matching, 'element', cursor.offset, typed);
}

/** Suggests the documented values of an enum attribute. */
function attributeValueSuggestions(
  cursor: Cursor,
  element: ElementSpec,
  attribute: string,
  typed: string,
): Suggestion[] {
  const spec = ownValue(element.attributes, attribute);
  if (spec?.kind !== 'enum' || !spec.values) return [];
  const values = matchingEnumValues(spec, typed).map(value => ({
    label: value,
    source: spec.source || element.source,
  }));
  return toSuggestions(values, 'value', cursor.offset, typed);
}

/** Suggests the documented attributes that the tag does not use yet. */
function attributeSuggestions(
  cursor: Cursor,
  element: ElementSpec,
  partial: string,
): Suggestion[] {
  const typed = partial.match(/([A-Za-z_][\w:.-]*)$/)?.[1] || '';
  const used = new Set(
    [...partial.matchAll(/\b([A-Za-z_][\w:.-]*)\s*=/g)].map(match => match[1]),
  );
  const attributes = Object.keys(element.attributes ?? {})
    .filter(name => name.startsWith(typed) && !used.has(name))
    .map(name => ({
      label: name,
      insertText: `${name}=""`,
      source: element.attributes?.[name].source || element.source,
    }));
  return toSuggestions(attributes, 'attribute', cursor.offset, typed);
}

/**
 * Suggests policy names inside `Step/Name` and the documented values of enum
 * text elsewhere.
 */
function textSuggestions(
  cursor: Cursor,
  policyNames: readonly string[],
): Suggestion[] {
  const element = elementSpecAt(cursor, cursor.stack);
  if (!element) return [];
  const { before, stack } = cursor;
  if (stack.at(-2) === 'Step' && stack.at(-1) === 'Name') {
    const typed = before.match(/([A-Za-z0-9._$%-]*)$/)?.[1] || '';
    const names = policyNames
      .filter(name => name.startsWith(typed))
      .map(name => ({ label: name, source: element.source }));
    return toSuggestions(names, 'value', cursor.offset, typed);
  }
  const spec = textSpecAt(before, stack, element);
  if (spec?.kind !== 'enum' || !spec.values) return [];
  const typed = before.match(/([A-Za-z0-9_-]*)$/)?.[1] || '';
  const values = matchingEnumValues(spec, typed).map(value => ({
    label: value,
    source: element.source,
  }));
  return toSuggestions(values, 'value', cursor.offset, typed);
}

/**
 * Returns the text constraint of the innermost open element, selected by an
 * attribute value in its start tag when the specification defines one.
 */
function textSpecAt(
  before: string,
  stack: readonly string[],
  element: ElementSpec,
): ValueSpec | undefined {
  const selector = element.textByAttribute;
  if (!selector) return element.text;
  const openingTag = before.slice(before.lastIndexOf(`<${stack.at(-1)}`));
  const pattern = new RegExp(
    `\\b${selector.attribute}\\s*=\\s*["']([^"']+)["']`,
  );
  const selectedValue = openingTag.match(pattern)?.[1];
  const selected = selectedValue && ownValue(selector.values, selectedValue);
  return selected || element.text;
}

/**
 * Returns the specification of the element that the path of open elements
 * leads to, looked up in the specification of the path's root.
 */
function elementSpecAt(
  cursor: Cursor,
  stack: readonly string[],
): ElementSpec | undefined {
  if (!stack.length) return undefined;
  const spec = chooseSpec(cursor.filePath, stack[0], cursor.specs);
  return spec && elementMap(spec).get(`/${stack.join('/')}`);
}

/** Returns the enum values that start with the typed text, as normalized. */
function matchingEnumValues(spec: ValueSpec, typed: string): string[] {
  const prefix = normalizeEnumValue(typed, spec);
  return (spec.values ?? []).filter(value =>
    normalizeEnumValue(value, spec).startsWith(prefix),
  );
}

/** Places choices at the cursor, replacing the typed prefix. */
function toSuggestions(
  choices: readonly Choice[],
  kind: Suggestion['kind'],
  offset: number,
  typed: string,
): Suggestion[] {
  return choices.map(choice => ({
    label: choice.label,
    kind,
    replaceStart: offset - typed.length,
    replaceEnd: offset,
    insertText: choice.insertText ?? choice.label,
    source: choice.source,
  }));
}
