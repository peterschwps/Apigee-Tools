import { directiveComment, directiveRules } from './directives';
import { parseXml, type XmlNode } from './xml';

/** Describes the replacement of the text between two offsets. */
export type TextEdit = { start: number; end: number; text: string };

/**
 * Removes an element, including its lines when they contain only that element
 * and whitespace.
 */
export function removeElementEdit(xml: string, node: XmlNode): TextEdit {
  const lineStart = xml.lastIndexOf('\n', node.start - 1) + 1;
  const newline = xml.indexOf('\n', node.end);
  const lineEnd = newline < 0 ? xml.length : newline;
  const ownLines =
    /^[ \t]*$/.test(xml.slice(lineStart, node.start)) &&
    /^[ \t\r]*$/.test(xml.slice(node.end, lineEnd));
  if (!ownLines) return { start: node.start, end: node.end, text: '' };

  // Remove the line break as well, unless the element ends the document
  const end = newline < 0 ? lineEnd : newline + 1;
  return { start: lineStart, end, text: '' };
}

/**
 * Returns the single documented value closest to a mistyped one, or nothing
 * when no value is close enough or several are equally close.
 */
export function closestValue(
  value: string,
  candidates: readonly string[],
  normalize: (text: string) => string = text => text,
): string | undefined {
  // Accept about one edit per three characters of the documented value
  const typed = normalize(value).toLowerCase();
  const scored = candidates
    .map(candidate => {
      const expected = normalize(candidate).toLowerCase();
      return {
        candidate,
        distance: editDistance(typed, expected),
        limit: Math.max(1, Math.floor(expected.length / 3)),
      };
    })
    .filter(item => item.distance <= item.limit)
    .sort((a, b) => a.distance - b.distance);

  // Suggest nothing when the best candidates are equally close
  return scored.length && scored[0].distance !== scored[1]?.distance
    ? scored[0].candidate
    : undefined;
}

/**
 * Builds the edit that suppresses a rule on the line containing the offset:
 * either a new directive line with the same indentation or the rule appended
 * to a directive on the previous line. Returns nothing when the comment could
 * not be placed as valid, effective XML.
 */
export function disableDirectiveEdit(
  xml: string,
  offset: number,
  rule: string,
): TextEdit | undefined {
  const lineStart = xml.lastIndexOf('\n', offset - 1) + 1;
  const newline = xml.indexOf('\n', lineStart);
  const line = xml.slice(lineStart, newline < 0 ? xml.length : newline);
  // Nothing may precede the XML declaration
  if (/^\s*<\?xml\b/.test(line)) return undefined;

  // Extend a directive on the previous line
  // A second comment line would shift the line the existing directive targets
  let edit: TextEdit | undefined;
  if (lineStart > 0) {
    const previousEnd = lineStart - 1;
    const previousStart = xml.lastIndexOf('\n', previousEnd - 1) + 1;
    const previous = xml.slice(previousStart, previousEnd).replace(/\r$/, '');
    const previousComment = /^([ \t]*)<!--(.*)-->[ \t]*$/.exec(previous);
    const rules = previousComment && directiveRules(previousComment[2]);
    if (rules?.includes(rule)) return undefined;
    if (previousComment && rules) {
      edit = {
        start: previousStart,
        end: previousStart + previous.length,
        text: previousComment[1] + directiveComment([...rules, rule]),
      };
    }
  }

  // Otherwise insert a directive line with the indentation of the target line
  const indentation = /^[ \t]*/.exec(line)?.[0] ?? '';
  const lineEnding = xml.includes('\r\n') ? '\r\n' : '\n';
  edit ??= {
    start: lineStart,
    end: lineStart,
    text: indentation + directiveComment([rule]) + lineEnding,
  };

  // Reject placements inside markup
  // There, the text would not parse as the intended comment
  const before = parseXml(xml);
  const after = parseXml(
    xml.slice(0, edit.start) + edit.text + xml.slice(edit.end),
  );
  const placed = after.comments.some(
    comment => comment.start === edit.start + edit.text.indexOf('<!--'),
  );
  return placed && after.syntaxIssues.length <= before.syntaxIssues.length
    ? edit
    : undefined;
}

/**
 * Returns the optimal string alignment distance: the number of insertions,
 * deletions, substitutions, and adjacent transpositions between two strings.
 */
function editDistance(a: string, b: string): number {
  // rows[i][j] is the distance between a's first i and b's first j characters
  const rows = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) =>
      i === 0 ? j : j === 0 ? i : 0,
    ),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + cost,
      );
      const transposed =
        i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1];
      if (transposed) rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
    }
  }
  return rows[a.length][b.length];
}
