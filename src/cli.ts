#!/usr/bin/env node
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { version } from '../package.json';
import { lintBundleReferences } from './bundle';
import { classifyDocument, lint, type LintIssue } from './linter';
import { loadSpecifications, type DocumentSpec } from './spec';
import { lineColumn } from './xml';

/** Receives the lines that the command writes to stdout and stderr. */
export type Output = {
  out: (line: string) => void;
  err: (line: string) => void;
};

/** Selects the reported rules; ignored rules take precedence. */
type RuleSelection = {
  ignored: ReadonlySet<string>;
  only?: ReadonlySet<string>;
};

const usage = `Usage: apigee-tools [--only AX108,AX112] [--ignore AX110,AX101] [--version] [path ...]

Lints Apigee X proxy and shared flow bundle XML below each path (default: the current directory).
Files given explicitly are linted even outside apiproxy or sharedflowbundle directories.

--only reports only the specified rule IDs. --only and --ignore accept comma-separated
IDs or repeated options, ignoring case. --ignore and inline suppression take precedence.
Counts and exit codes reflect the reported findings.

Exit codes: 0 without errors, 1 when errors were found, 2 for invalid usage or unreadable paths.`;

const argumentConfig = {
  allowPositionals: true,
  options: {
    only: { type: 'string', multiple: true },
    ignore: { type: 'string', multiple: true },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  },
} as const;

const consoleOutput: Output = {
  out: line => process.stdout.write(`${line}\n`),
  err: line => process.stderr.write(`${line}\n`),
};

// Directories that never contain bundles to lint
const skippedDirectories = /(?:^|[\\/])(?:node_modules|\.git)(?:[\\/]|$)/;

/**
 * Lints the given paths, writes one line per finding, and returns the process
 * exit code.
 */
export async function run(
  args: string[],
  output: Output = consoleOutput,
): Promise<number> {
  const options = parseArguments(args);
  if (options instanceof Error) {
    output.err(`${options.message}\n\n${usage}`);
    return 2;
  }
  if (options.values.help) {
    output.out(usage);
    return 0;
  }
  if (options.values.version) {
    output.out(version);
    return 0;
  }
  const ignored = ruleIds(options.values.ignore);
  const only = options.values.only ? ruleIds(options.values.only) : undefined;
  if (only?.size === 0) {
    output.err(`Provide at least one rule ID with --only.\n\n${usage}`);
    return 2;
  }

  // Collect all files first, so unreadable paths fail before any finding
  const targets = options.positionals.length ? options.positionals : ['.'];
  const files = await collectFiles(targets, output);
  if (!files) return 2;

  // Lint the files in a stable order and count the reported findings
  const specs = loadSpecifications(path.resolve(__dirname, '..'));
  let errors = 0;
  let warnings = 0;
  for (const file of [...files].sort()) {
    const xml = await readFile(file, 'utf8');
    for (const issue of await lintFile(xml, file, specs, { ignored, only })) {
      const severity = issue.severity ?? 'error';
      if (severity === 'error') errors++;
      else warnings++;
      output.out(formatFinding(file, xml, issue, severity));
    }
  }
  output.err(
    `${count(files.size, 'file')} checked: ${count(errors, 'error')}, ${count(warnings, 'warning')}.`,
  );
  return errors ? 1 : 0;
}

/** Parses the arguments, returning a usage error instead of throwing it. */
function parseArguments(args: string[]) {
  try {
    return parseArgs({ args, ...argumentConfig });
  } catch (error) {
    return error as Error;
  }
}

/** Collects upper-case rule IDs from repeated, comma-separated values. */
function ruleIds(values: string[] = []): Set<string> {
  return new Set(
    values
      .flatMap(value => value.split(','))
      .map(rule => rule.trim().toUpperCase())
      .filter(Boolean),
  );
}

/**
 * Collects the files to lint below the targets, or reports the first target
 * that cannot be read and returns nothing.
 */
async function collectFiles(
  targets: readonly string[],
  output: Output,
): Promise<Set<string> | undefined> {
  const files = new Set<string>();
  for (const target of targets) {
    try {
      for (const file of await lintableFiles(target)) files.add(file);
    } catch (error) {
      output.err(`Cannot read ${target}: ${(error as Error).message}`);
      return undefined;
    }
  }
  return files;
}

/** Returns a file target itself, or the bundle files below a directory. */
async function lintableFiles(target: string): Promise<string[]> {
  if (!(await stat(target)).isDirectory()) return [target];
  const entries = await readdir(target, { recursive: true });
  return entries
    .filter(entry => !skippedDirectories.test(entry))
    .map(entry => path.join(target, entry))
    .filter(file => classifyDocument(file));
}

/** Returns the selected findings of a file, ordered by position. */
async function lintFile(
  xml: string,
  file: string,
  specs: readonly DocumentSpec[],
  { ignored, only }: RuleSelection,
): Promise<LintIssue[]> {
  const bundleIssues = (await lintBundleReferences(xml, file)).filter(
    issue => !ignored.has(issue.rule),
  );
  return [...lint(xml, file, specs, ignored), ...bundleIssues]
    .filter(issue => !only || only.has(issue.rule))
    .sort((a, b) => a.start - b.start);
}

/** Formats a finding as `file:line:column: severity rule message`. */
function formatFinding(
  file: string,
  xml: string,
  issue: LintIssue,
  severity: string,
): string {
  const { line, column } = lineColumn(xml, issue.start);
  const displayPath = path.relative(process.cwd(), file) || file;
  return `${displayPath}:${line}:${column}: ${severity} ${issue.rule} ${issue.message}`;
}

/** Formats an amount with a singular or plural noun, such as `2 files`. */
function count(amount: number, noun: string): string {
  return `${amount} ${noun}${amount === 1 ? '' : 's'}`;
}

if (require.main === module) {
  run(process.argv.slice(2)).then(
    code => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error);
      process.exitCode = 2;
    },
  );
}
