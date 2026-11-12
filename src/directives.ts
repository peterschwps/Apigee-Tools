import type { LintIssue } from './linter';
import { lineColumn, type XmlComment } from './xml';

const directivePattern =
  /^\s*apigee-tools\s+disable\s*=\s*([A-Za-z]{2}[0-9]{3}(?:\s*,\s*[A-Za-z]{2}[0-9]{3})*)\s*$/;

/** Builds the comment that disables the given rules on the following line. */
export function directiveComment(rules: readonly string[]): string {
  return `<!-- apigee-tools disable=${rules.join(',')} -->`;
}

/**
 * Returns the upper-case rule IDs of a directive comment body, or nothing for
 * other comments.
 */
export function directiveRules(commentText: string): string[] | undefined {
  return directivePattern
    .exec(commentText)?.[1]
    .split(',')
    .map(rule => rule.trim().toUpperCase());
}

/**
 * Drops issues on the line following a directive comment such as
 * `<!-- apigee-tools disable=AX101,AX104 -->`, matching apigeelint's
 * line-based directive semantics.
 */
export function applyDirectives(
  xml: string,
  comments: readonly XmlComment[],
  issues: LintIssue[],
): LintIssue[] {
  // Collect the disabled rules of each line below a directive
  const disabled = new Map<number, Set<string>>();
  for (const comment of comments) {
    const rules = directiveRules(comment.text);
    if (!rules) continue;
    const line = lineColumn(xml, comment.end - 1).line + 1;
    disabled.set(line, new Set([...(disabled.get(line) ?? []), ...rules]));
  }
  if (!disabled.size) return issues;

  // Keep issues whose line does not disable their rule
  return issues.filter(
    issue => !disabled.get(lineColumn(xml, issue.start).line)?.has(issue.rule),
  );
}
