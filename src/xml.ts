import {
  parse,
  type AttributeCstNode,
  type ContentCstNode,
  type DocumentCstNode,
  type ElementCstNode,
} from '@xml-tools/parser';

type Token = ElementCstNode['children']['Name'][number];

/** Piece of element content with its decoded value. */
type TextPiece = { token: Token; value: string };

/**
 * Describes an attribute. Like all ranges in this module, `start` is the
 * inclusive and `end` the exclusive character offset in the document.
 */
export type XmlAttribute = {
  name: string;
  /** Decoded value between the quotes, absent for a missing value. */
  value?: string;
  /** Range of the attribute name. */
  start: number;
  end: number;
  /** Range of the raw value between the quotes. */
  valueStart?: number;
  valueEnd?: number;
};

/** Describes a decoded, trimmed text value and its range in the document. */
export type XmlText = { value: string; start: number; end: number };

/** Describes an element with its attributes, children, and leaf text. */
export type XmlNode = {
  name: string;
  /** Range of the whole element, including its end tag. */
  start: number;
  end: number;
  /** Range of the element name in the start tag. */
  nameStart: number;
  nameEnd: number;
  /** Decoded, trimmed character data of a leaf element, without comments. */
  text?: XmlText;
  attributes: XmlAttribute[];
  children: XmlNode[];
};

/** Describes a comment; `text` excludes the `<!--` and `-->` delimiters. */
export type XmlComment = { text: string; start: number; end: number };

/** Describes a lexer or parser error. */
export type SyntaxIssue = { message: string; start: number; end: number };

/** Holds the root element, comments in document order, and syntax errors. */
export type XmlDocument = {
  root?: XmlNode;
  comments: XmlComment[];
  syntaxIssues: SyntaxIssue[];
};

const predefinedEntities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * Decodes predefined and numeric XML references; unknown references stay
 * literal.
 */
export function decodeEntities(raw: string): string {
  return raw.replace(
    /&(?:#x([0-9A-Fa-f]+)|#([0-9]+)|([A-Za-z_][\w.-]*));/g,
    (reference, hex?: string, decimal?: string, name?: string) => {
      if (name) return predefinedEntities[name] ?? reference;
      const codePoint = Number.parseInt(hex ?? decimal ?? '', hex ? 16 : 10);
      return codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : reference;
    },
  );
}

/** Returns the 1-based line and column of an offset; lines end at `\n`. */
export function lineColumn(
  text: string,
  offset: number,
): { line: number; column: number } {
  const lines = text.slice(0, offset).split('\n');
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

/**
 * Returns the root element name, skipping a leading declaration, processing
 * instructions, and comments.
 */
export function rootElementName(xml: string): string | undefined {
  return xml.match(
    /^\s*(?:(?:<\?[\s\S]*?\?>|<!--[\s\S]*?-->)\s*)*<([A-Za-z_][\w:.-]*)/,
  )?.[1];
}

/** Parses XML into a position-aware model that tolerates incomplete markup. */
export function parseXml(text: string): XmlDocument {
  const result = parse(text);
  const document = result.cst as DocumentCstNode;

  // Report lexer and parser errors with a range of at least one character
  const syntaxIssues: SyntaxIssue[] = [
    ...result.lexErrors.map(error => ({
      message: error.message,
      start: error.offset,
      end: error.offset + Math.max(error.length, 1),
    })),
    ...result.parseErrors.map(error => {
      // Errors at the end of the input have no token offset
      const start = Number.isFinite(error.token.startOffset)
        ? error.token.startOffset
        : text.length;
      return {
        message: error.message,
        start,
        end: Math.min(start + 1, text.length),
      };
    }),
  ];

  // Collect comments outside the root; elements add their own when converted
  const comments = (document.children.misc ?? [])
    .flatMap(misc => misc.children.Comment ?? [])
    .map(toComment);
  const rootCst = document.children.element?.[0];
  const root = rootCst ? toNode(rootCst, comments) : undefined;
  return {
    root,
    comments: comments.sort((a, b) => a.start - b.start),
    syntaxIssues,
  };
}

/** Returns the exclusive end offset of a token. */
function tokenEnd(token: Token): number {
  return (token.endOffset ?? token.startOffset) + 1;
}

function toComment(token: Token): XmlComment {
  return {
    text: token.image.slice('<!--'.length, -'-->'.length),
    start: token.startOffset,
    end: tokenEnd(token),
  };
}

/** Converts an attribute, or returns nothing for one without a name. */
function toAttribute(attribute: AttributeCstNode): XmlAttribute | undefined {
  const key = attribute.children.Name?.[0];
  if (!key) return undefined;
  const raw = attribute.children.STRING?.[0];
  const quote = raw?.image[0];
  return {
    name: key.image,
    value:
      raw && (quote === '"' || quote === "'")
        ? decodeEntities(raw.image.slice(1, -1))
        : undefined,
    start: key.startOffset,
    end: tokenEnd(key),
    valueStart: raw ? raw.startOffset + 1 : undefined,
    valueEnd: raw ? raw.endOffset : undefined,
  };
}

/**
 * Converts an element and its descendants, or returns nothing for one without
 * a name. Comments inside the element are appended to `comments`.
 */
function toNode(
  cst: ElementCstNode,
  comments: XmlComment[],
): XmlNode | undefined {
  const name = cst.children.Name?.[0];
  if (!name) return undefined;
  const open = cst.children.OPEN?.[0];

  // Incomplete elements end at their start tag or, failing that, their name
  const endToken =
    cst.children.END?.[0] ??
    cst.children.SLASH_CLOSE?.[0] ??
    cst.children.START_CLOSE?.[0] ??
    name;

  // Convert attributes, comments, and child elements in document order
  const attributes = (cst.children.attribute ?? [])
    .map(toAttribute)
    .filter(isDefined);
  const content = cst.children.content ?? [];
  comments.push(
    ...content.flatMap(item => item.children.Comment ?? []).map(toComment),
  );
  const children = content
    .flatMap(item => item.children.element ?? [])
    .map(child => toNode(child, comments))
    .filter(isDefined);
  return {
    name: name.image,
    start: open?.startOffset ?? name.startOffset,
    end: tokenEnd(endToken),
    nameStart: name.startOffset,
    nameEnd: tokenEnd(name),
    text: children.length ? undefined : leafText(content),
    attributes,
    children,
  };
}

/**
 * Returns the decoded, trimmed text of leaf content with a range that excludes
 * surrounding whitespace, or nothing for blank content.
 */
function leafText(content: readonly ContentCstNode[]): XmlText | undefined {
  const pieces = textPieces(content);
  const value = pieces
    .map(piece => piece.value)
    .join('')
    .trim();
  const meaningful = pieces.filter(piece => piece.value.trim());
  if (!value || !meaningful.length) return undefined;

  // Narrow the range to the non-whitespace part of the outer plain-text tokens
  const first = meaningful[0].token;
  const last = meaningful[meaningful.length - 1].token;
  const start =
    first.tokenType.name === 'TEXT'
      ? first.startOffset + first.image.length - first.image.trimStart().length
      : first.startOffset;
  const end =
    last.tokenType.name === 'TEXT'
      ? last.startOffset + last.image.trimEnd().length
      : tokenEnd(last);
  return { value, start, end };
}

/**
 * Lists the character data, CDATA sections, and references of content in
 * document order.
 */
function textPieces(content: readonly ContentCstNode[]): TextPiece[] {
  const pieces = content.flatMap(({ children }) => {
    const characters = (children.chardata ?? [])
      .flatMap(data => [
        ...(data.children.TEXT ?? []),
        ...(data.children.SEA_WS ?? []),
      ])
      .map(token => ({ token, value: token.image }));
    const sections = (children.CData ?? []).map(token => ({
      token,
      value: token.image.slice('<![CDATA['.length, -']]>'.length),
    }));
    const references = (children.reference ?? [])
      .flatMap(reference => [
        ...(reference.children.EntityRef ?? []),
        ...(reference.children.CharRef ?? []),
      ])
      .map(token => ({ token, value: decodeEntities(token.image) }));
    return [...characters, ...sections, ...references];
  });
  return pieces.sort((a, b) => a.token.startOffset - b.token.startOffset);
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
