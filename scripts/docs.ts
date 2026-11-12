import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { load, type CheerioAPI } from 'cheerio';
import { isNotFound } from '../src/bundle';
import { canonicalUrl, linkCheck, validateReviewed } from './validate-reviewed';

const reviewStatuses = ['pending', 'in-progress', 'reviewed', 'gap'] as const;

/** Describes a documentation page in the review inventory. */
type Source = {
  id: string;
  kind: 'policy' | 'core';
  title: string;
  url: string;
  reviewStatus?: (typeof reviewStatuses)[number];
  reviewNotes?: string;
};

/** Holds the facts extracted from one section of a documentation page. */
type CandidateSection = {
  heading: string;
  /** Last earlier heading that names an element, such as `<Rate>`. */
  contextHeading?: string;
  anchor?: string;
  /** Elements named in the heading. */
  elements: string[];
  exampleElements: string[];
  exampleAttributes: string[];
  /** Attribute values listed as `[a|b]` in syntax samples. */
  syntaxAttributeValues: Record<string, string[]>;
  attributeRows: Record<string, string>[];
  otherTables: { headers: string[]; rows: string[][] }[];
  valueHints: string[];
  formatHints: string[];
  /** Hash of the section content, to detect documentation changes. */
  hash: string;
};

const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, 'data');
const candidateDir = path.join(dataDir, 'candidates');
const proposalDir = path.join(dataDir, 'proposals');
const sourceFile = path.join(dataDir, 'sources.json');
const baselineFile = path.join(dataDir, 'source-hashes.json');
const policyIndex =
  'https://docs.cloud.google.com/apigee/docs/api-platform/reference/policies/reference-overview-policy';
const coreSources: Source[] = [
  {
    id: 'api-proxy-configuration-reference',
    kind: 'core',
    title: 'API proxy configuration reference',
    url: 'https://docs.cloud.google.com/apigee/docs/api-platform/reference/api-proxy-configuration-reference',
  },
  {
    id: 'flow-configuration-reference',
    kind: 'core',
    title: 'Flow configuration reference',
    url: 'https://docs.cloud.google.com/apigee/docs/api-platform/reference/flow-configuration-reference',
  },
  {
    id: 'endpoint-properties-reference',
    kind: 'core',
    title: 'Endpoint properties reference',
    url: 'https://docs.cloud.google.com/apigee/docs/api-platform/reference/endpoint-properties-reference',
  },
  {
    id: 'load-balancing-across-backend-servers',
    kind: 'core',
    title: 'Load balancing across backend servers',
    url: 'https://docs.cloud.google.com/apigee/docs/api-platform/deploy/load-balancing-across-backend-servers',
  },
  {
    id: 'semantic-caching-psc-tutorial',
    kind: 'core',
    title: 'Semantic caching with a private endpoint',
    url: 'https://docs.cloud.google.com/apigee/docs/api-platform/tutorials/using-semantic-caching-policies-psc',
  },
  {
    id: 'model-armor-tutorial',
    kind: 'core',
    title: 'Get started with Apigee Model Armor policies',
    url: 'https://docs.cloud.google.com/apigee/docs/api-platform/tutorials/using-model-armor-policies',
  },
  {
    id: 'responsecache-deployment-errors',
    kind: 'core',
    title: 'ResponseCache deployment errors',
    url: 'https://docs.cloud.google.com/apigee/docs/api-platform/troubleshoot/policies/deployment/responsecache-deployment-errors',
  },
  {
    id: 'oauth-access-tokens-guide',
    kind: 'core',
    title: 'Verifying access tokens',
    url: 'https://docs.cloud.google.com/apigee/docs/api-platform/security/oauth/using-access-tokens',
  },
  {
    id: 'flow-basics-guide',
    kind: 'core',
    title: 'Controlling API proxies with flows',
    url: 'https://docs.cloud.google.com/apigee/docs/api-platform/fundamentals/what-are-flows',
  },
  {
    id: 'extractvariables-deployment-errors',
    kind: 'core',
    title: 'ExtractVariables deployment errors',
    url: 'https://docs.cloud.google.com/apigee/docs/api-platform/troubleshoot/policies/deployment/extract-variables-deployment-errors',
  },
  {
    id: 'quota-deployment-errors',
    kind: 'core',
    title: 'Quota deployment errors',
    url: 'https://docs.cloud.google.com/apigee/docs/api-platform/troubleshoot/policies/deployment/quota-deployment-errors',
  },
  {
    id: 'shared-flows-guide',
    kind: 'core',
    title: 'Creating reusable shared flows',
    url: 'https://docs.cloud.google.com/apigee/docs/api-platform/fundamentals/shared-flows',
  },
  {
    id: 'shared-flow-bundle-configuration-reference',
    kind: 'core',
    title: 'Shared flow bundle configuration reference',
    url: 'https://docs.cloud.google.com/apigee/docs/api-platform/reference/shared-flow-bundle-configuration-reference',
  },
];
// Policy pages that the policy index does not link
const supplementalPolicies: Source[] = [
  {
    id: 'generate-saml-assertion-policy',
    kind: 'policy',
    title: 'generate saml assertion policy',
    url: 'https://docs.cloud.google.com/apigee/docs/api-platform/reference/policies/generate-saml-assertion-policy',
  },
  {
    id: 'validate-saml-assertion-policy',
    kind: 'policy',
    title: 'validate saml assertion policy',
    url: 'https://docs.cloud.google.com/apigee/docs/api-platform/reference/policies/validate-saml-assertion-policy',
  },
  {
    id: 'llm-token-quota-policy',
    kind: 'policy',
    title: 'llm token quota policy',
    url: 'https://docs.cloud.google.com/apigee/docs/api-platform/reference/policies/llm-token-quota-policy',
  },
  {
    id: 'parse-payload-policy',
    kind: 'policy',
    title: 'parse payload policy',
    url: 'https://docs.cloud.google.com/apigee/docs/api-platform/reference/policies/parse-payload-policy',
  },
  {
    id: 'prompt-token-limit-policy',
    kind: 'policy',
    title: 'prompt token limit policy',
    url: 'https://docs.cloud.google.com/apigee/docs/api-platform/reference/policies/prompt-token-limit-policy',
  },
];

async function main(): Promise<void> {
  const [command, ...ids] = process.argv.slice(2);
  switch (command) {
    case 'discover':
      await discover();
      break;
    case 'extract':
      await extract(ids);
      break;
    case 'refresh':
      await refresh();
      break;
    case 'propose':
      await propose(ids);
      break;
    case 'validate':
      await validate();
      break;
    case 'status':
      await status(false);
      break;
    case 'release-check':
      await status(true, await validate());
      break;
    default:
      throw new Error(
        'Usage: docs.ts <discover|extract [source IDs...]|propose [source IDs...]|refresh|validate|status|release-check>',
      );
  }
}

/** Rebuilds the source inventory from Google's policy index. */
async function discover(): Promise<void> {
  const found = await indexedPolicies();
  for (const source of supplementalPolicies) found.set(source.id, source);

  // Keep previously discovered policy pages that the index no longer links
  const previous = await readSourcesIfPresent();
  for (const source of previous) {
    if (
      source.kind === 'policy' &&
      source.id !== 'saml-assertion-policy' &&
      !found.has(source.id)
    ) {
      found.set(source.id, source);
      console.warn(
        `Retained previously discovered page missing from current index: ${source.id}`,
      );
    }
  }
  if (found.size < 20) {
    throw new Error(
      `Only ${found.size} policy pages found; inspect index extraction before saving.`,
    );
  }

  // Carry review states over to the new inventory
  const old = new Map(previous.map(source => [source.id, source]));
  const policies = [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
  const sources = [...coreSources, ...policies].map(source => ({
    ...source,
    reviewStatus: old.get(source.id)?.reviewStatus || 'pending',
    ...(old.get(source.id)?.reviewNotes
      ? { reviewNotes: old.get(source.id)?.reviewNotes }
      : {}),
  }));
  const newPages = sources.filter(source => !old.has(source.id));
  await mkdir(dataDir, { recursive: true });
  await writeFile(sourceFile, `${JSON.stringify(sources, null, 2)}\n`);
  console.log(
    `Discovered ${found.size} policy pages and ${coreSources.length} core references; ${newPages.length} new since previous inventory.`,
  );
}

/** Returns the policy reference pages that Google's policy index links. */
async function indexedPolicies(): Promise<Map<string, Source>> {
  const $ = load(await fetchHtml(policyIndex));
  const body = articleBody($);
  if (!body.length) {
    throw new Error(
      'Policy index article was not found; inspect the current Google Docs layout.',
    );
  }
  const found = new Map<string, Source>();
  for (const link of body.find('a[href]').toArray()) {
    const href = $(link).attr('href');
    if (!href) continue;
    const url = new URL(href, policyIndex);
    const id = url.pathname.match(
      /^\/apigee\/docs\/api-platform\/reference\/policies\/([a-z0-9-]+)$/,
    )?.[1];
    // The index page and the retired SAML overview are not policy references
    if (
      !id ||
      ['reference-overview-policy', 'saml-assertion-policy'].includes(id)
    ) {
      continue;
    }
    url.search = '';
    url.hash = '';
    const title = id.replace(/-/g, ' ');
    found.set(id, { id, kind: 'policy', title, url: url.toString() });
  }
  return found;
}

/**
 * Extracts candidate facts from the given sources, or all sources, and updates
 * the section hash baseline.
 */
async function extract(ids: string[]): Promise<void> {
  const selected = selectSources(await readSources(), ids);
  if (!selected) {
    throw new Error(
      'One or more requested source IDs are missing from data/sources.json.',
    );
  }
  const baseline = await readBaseline();
  await mkdir(candidateDir, { recursive: true });

  // Continue after failed pages and report them all at the end
  const failed: string[] = [];
  for (const [index, source] of selected.entries()) {
    const progress = `${index + 1}/${selected.length} ${source.id}`;
    try {
      const sections = extractSections(await fetchHtml(source.url));
      if (!sections.length) {
        throw new Error(
          'No sections found; this might be a moved or deprecated page.',
        );
      }
      baseline[source.id] = sectionHashes(sections);
      await writeFile(
        path.join(candidateDir, `${source.id}.json`),
        `${JSON.stringify({ source, sections }, null, 2)}\n`,
      );
      console.log(`${progress}: ${sections.length} sections`);
    } catch (error) {
      failed.push(source.id);
      console.error(`${progress}: ${String(error)}`);
    }
  }
  await writeFile(baselineFile, `${JSON.stringify(baseline, null, 2)}\n`);
  if (failed.length) {
    throw new Error(`Extraction failed for: ${failed.join(', ')}`);
  }
}

/** Reports the sources whose sections differ from the extraction baseline. */
async function refresh(): Promise<void> {
  const sources = await readSources();
  const baseline = await readBaseline();
  let changes = 0;
  for (const [index, source] of sources.entries()) {
    const current = sectionHashes(extractSections(await fetchHtml(source.url)));
    const previous = baseline[source.id];
    const keys = new Set([
      ...Object.keys(current),
      ...Object.keys(previous || {}),
    ]);
    const changedSections = [...keys].filter(
      key => current[key] !== previous?.[key],
    );
    if (changedSections.length) {
      changes++;
      console.log(
        `${source.id}: ${changedSections.length} new, removed, or changed sections`,
      );
    }
    if ((index + 1) % 10 === 0) {
      console.log(`Checked ${index + 1}/${sources.length} pages.`);
    }
  }
  console.log(
    `${changes} of ${sources.length} sources differ from the extraction baseline.`,
  );
}

/** Turns extracted candidates into unreviewed rule proposals. */
async function propose(ids: string[]): Promise<void> {
  const selected = selectSources(await readSources(), ids);
  if (!selected) {
    throw new Error('One or more requested source IDs are missing.');
  }
  await mkdir(proposalDir, { recursive: true });
  for (const source of selected) {
    const candidate = await readCandidate(source);
    const sections = candidate.sections
      .map(section => proposeSection(source, section))
      .filter(
        section =>
          section.elements.length ||
          section.exampleElements.length ||
          section.exampleAttributes.length ||
          section.attributes.length ||
          section.namedRows.length ||
          section.valueHints.length ||
          section.formatHints.length,
      );
    await writeFile(
      path.join(proposalDir, `${source.id}.json`),
      `${JSON.stringify({ source, reviewStatus: 'unreviewed', sections }, null, 2)}\n`,
    );
    console.log(`${source.id}: ${sections.length} candidate fact sections`);
  }
}

/** Derives attribute and value facts from an extracted section. */
function proposeSection(source: Source, section: CandidateSection) {
  const attributes = section.attributeRows
    .filter(row => /^[A-Za-z_][\w:.-]*$/.test(row.Attribute || ''))
    .map(row => {
      const description = row.Description || '';
      return {
        name: row.Attribute,
        required: /^(required|yes)$/i.test(
          row.Presence || row['Required?'] || '',
        ),
        type: row.Type || undefined,
        possibleValues: simpleValues(description),
        formatHint: description
          .match(
            /\b(?:format|characters? (?:allowed|restricted))\b[^.]*(?:\.|$)/i,
          )?.[0]
          ?.slice(0, 200),
      };
    });

  // Tables keyed by name describe elements or fields
  const namedRows = section.otherTables
    .filter(table =>
      /^(?:Name|Field Name|Element)$/i.test(table.headers[0] || ''),
    )
    .flatMap(table => {
      const requiredColumn = table.headers.findIndex(header =>
        /^(?:required\??|presence)$/i.test(header),
      );
      return table.rows
        .filter(row => /^[A-Za-z][\w.-]*$/.test(row[0] || ''))
        .map(row => ({
          name: row[0],
          required: /^(yes|required)$/i.test(row[requiredColumn] || ''),
          possibleValues: simpleValues(row.slice(1).join(' ')),
        }));
    });
  return {
    heading: section.heading,
    contextHeading: section.contextHeading,
    source: `${source.url}${section.anchor ? `#${section.anchor}` : ''}`,
    elements: section.elements,
    exampleElements: section.exampleElements,
    exampleAttributes: section.exampleAttributes,
    syntaxAttributeValues: section.syntaxAttributeValues,
    attributes,
    namedRows,
    possibleValues: section.valueHints.flatMap(
      hint => simpleValues(hint) || [],
    ),
    valueHints: section.valueHints,
    formatHints: section.formatHints,
  };
}

/** Returns the values of a short "Valid values: a, b, or c" list, if any. */
function simpleValues(text: string): string[] | undefined {
  const match = text.match(
    /(?:Valid values?|Allowed values?|Select from|One of)(?:\s+(?:are|include))?\s*:?\s*([A-Za-z0-9_-]+(?:\s*(?:,|or|and)\s*[A-Za-z0-9_-]+)+)/i,
  );
  if (!match) return undefined;
  const values = match[1].split(/\s*(?:,|\bor\b|\band\b)\s*/i).filter(Boolean);
  return values.length > 1 && values.length < 20 ? values : undefined;
}

/** Validates the source inventory and the reviewed rule data. */
async function validate(): Promise<Map<string, boolean>> {
  const sources = await readSources();
  const sourceUrls = new Set(sources.map(source => canonicalUrl(source.url)));
  const ids = new Set(sources.map(source => source.id));
  if (sourceUrls.size !== sources.length || ids.size !== sources.length) {
    throw new Error('Source inventory contains duplicate IDs or URLs.');
  }

  // Check documentation anchors against the extracted candidates, where present
  const candidateAnchors = new Map<string, Set<string>>();
  for (const source of sources) {
    try {
      const candidate = await readCandidate(source);
      const anchors = candidate.sections
        .map(section => section.anchor)
        .filter((anchor): anchor is string => Boolean(anchor));
      candidateAnchors.set(canonicalUrl(source.url), new Set(anchors));
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  return validateReviewed(
    path.join(dataDir, 'reviewed'),
    linkCheck(sourceUrls, candidateAnchors),
  );
}

/**
 * Prints the review progress. For a release, every source must be reviewed
 * with complete rule coverage or have a documented gap.
 */
async function status(
  release: boolean,
  coverage?: Map<string, boolean>,
): Promise<void> {
  const sources = await readSources();
  const counts = Object.fromEntries(
    reviewStatuses.map(state => [
      state,
      sources.filter(source => (source.reviewStatus || 'pending') === state)
        .length,
    ]),
  );
  console.log(
    `Documentation review: ${JSON.stringify(counts)} (total ${sources.length}).`,
  );
  if (!release) return;
  const counted = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (counted !== sources.length) {
    throw new Error('Source inventory contains an unknown review status.');
  }
  if (counts.pending + counts['in-progress'] > 0) {
    throw new Error(
      'Release gate failed: all Apigee X sources must be reviewed or have a recorded documentation gap.',
    );
  }
  for (const source of sources) {
    const page = canonicalUrl(source.url);
    if (source.reviewStatus === 'gap' && !source.reviewNotes?.trim()) {
      throw new Error(`${source.id}: documentation gap needs a note.`);
    }
    if (source.reviewStatus === 'reviewed' && coverage?.get(page) !== true) {
      throw new Error(
        `${source.id}: reviewed source lacks complete rule coverage.`,
      );
    }
  }
}

/**
 * Splits a documentation page into sections at its headings and collects the
 * element names, examples, tables, and hints of each section.
 */
function extractSections(html: string): CandidateSection[] {
  const $ = load(html);
  const body = articleBody($);
  if (!body.length) throw new Error('Documentation article was not found.');

  // Malformed HTML can push most headings out of the article node
  const fallback =
    $('h1,h2,h3,h4').length > body.find('h1,h2,h3,h4').length + 10;
  if (!fallback) body.find('nav, aside, script, style').remove();
  const blockSelector = 'h1,h2,h3,h4,p,ul,ol,pre,table';
  const blocks = fallback
    ? $.root().find(blockSelector)
    : body.find(blockSelector);

  const sections: CandidateSection[] = [];
  let current: CandidateSection | undefined;
  let sectionText: string[] = [];
  let contextHeading: string | undefined;
  // Without the article node, the content starts at the page title
  let started = !fallback;
  for (const block of blocks.toArray()) {
    // Tables are handled as a whole, so skip blocks inside them
    if ($(block).closest('table').length && block.tagName !== 'table') continue;
    const tag = block.tagName.toLowerCase();
    if (fallback && !started) {
      if (tag !== 'h1') continue;
      started = true;
    }
    const isHeading = /^h[1-4]$/.test(tag);
    if (
      fallback &&
      isHeading &&
      normalize($(block).text()) === 'Products and pricing'
    ) {
      break;
    }

    // Start a new section at each heading
    if (isHeading) {
      if (current) sections.push(finishSection(current, sectionText));
      const heading = normalize($(block).text());
      if (!heading) {
        current = undefined;
        continue;
      }
      if (/<[A-Za-z][\w.-]*>/.test(heading)) contextHeading = heading;
      current = newSection(heading, contextHeading, $(block).attr('id'));
      sectionText = [];
      continue;
    }

    // Collect the content of the current section
    if (!current) continue;
    if (tag === 'table') {
      const rows = $(block)
        .children('tr')
        .add($(block).children('thead,tbody').children('tr'));
      const cells = rows.toArray().map(row =>
        $(row)
          .children('th,td')
          .toArray()
          .map(cell => normalize($(cell).text())),
      );
      addTable(current, cells);
      continue;
    }
    if (tag === 'pre') addExample(current, $(block).text());
    const text = normalize($(block).text());
    if (text) sectionText.push(text);
  }
  if (current) sections.push(finishSection(current, sectionText));
  return sections;
}

function newSection(
  heading: string,
  contextHeading: string | undefined,
  anchor: string | undefined,
): CandidateSection {
  return {
    heading,
    contextHeading,
    anchor: anchor || undefined,
    elements: [
      ...new Set(
        [...heading.matchAll(/<([A-Za-z][\w.-]*)>/g)].map(match => match[1]),
      ),
    ],
    exampleElements: [],
    exampleAttributes: [],
    syntaxAttributeValues: {},
    attributeRows: [],
    otherTables: [],
    valueHints: [],
    formatHints: [],
    hash: '',
  };
}

/** Records the element and attribute names of an XML example. */
function addExample(section: CandidateSection, code: string): void {
  for (const tag of code.matchAll(/<([A-Za-z_][\w:.-]*)(?=[\s/>])([^>]*)>/g)) {
    const [, element, attributes] = tag;
    if (!section.exampleElements.includes(element)) {
      section.exampleElements.push(element);
    }
    for (const attribute of attributes.matchAll(
      /([A-Za-z_][\w:.-]*)\s*=\s*(["'])(.*?)\2/g,
    )) {
      const [, name, , value] = attribute;
      if (!section.exampleAttributes.includes(name)) {
        section.exampleAttributes.push(name);
      }

      // Syntax samples list the allowed values as [a|b|c]
      const values = value
        .match(/^\[([^\]]+)\]$/)?.[1]
        .split('|')
        .map(item => item.trim())
        .filter(Boolean);
      if (values && values.length > 1 && values.length < 20) {
        section.syntaxAttributeValues[name] = values;
      }
    }
  }
}

/** Records a table: attribute tables row by row, other tables as a whole. */
function addTable(section: CandidateSection, cells: string[][]): void {
  const [headers = [], ...body] = cells;
  const rows = body.filter(row => row.some(Boolean));
  const attributeColumn = headers.findIndex(header =>
    /^attribute(s| name)?$/i.test(header),
  );
  if (attributeColumn < 0) {
    if (rows.length) section.otherTables.push({ headers, rows });
    return;
  }
  for (const row of rows) {
    const entry = Object.fromEntries(
      headers.map((header, index) => [
        header || `column${index}`,
        row[index] || '',
      ]),
    );
    if (row[attributeColumn]) section.attributeRows.push(entry);
  }
}

/** Completes a section with its hints, content hash, and sorted examples. */
function finishSection(
  section: CandidateSection,
  texts: readonly string[],
): CandidateSection {
  section.valueHints = hints(
    texts,
    /(?:Valid values|Allowed values|Possible values|Select from|One of)[^.]*(?:\.|$)/gi,
  );
  section.formatHints = hints(
    texts,
    /\b(?:format|pattern|characters? (?:allowed|restricted))\b[^.]*(?:\.|$)/gi,
  );
  section.hash = digest(
    `${section.heading}\n${texts.join('\n')}\n${JSON.stringify(section.attributeRows)}\n${JSON.stringify(section.otherTables)}`,
  );
  section.exampleElements.sort();
  section.exampleAttributes.sort();
  return section;
}

/** Returns the distinct matches of a pattern, cut to 350 characters. */
function hints(texts: readonly string[], pattern: RegExp): string[] {
  const matches = texts.flatMap(text => text.match(pattern) || []);
  return [...new Set(matches.map(text => text.slice(0, 350)))];
}

/** Keys section hashes by anchor or heading, adding `~n` to repeated keys. */
function sectionHashes(sections: CandidateSection[]): Record<string, string> {
  const occurrences = new Map<string, number>();
  return Object.fromEntries(
    sections.map(section => {
      const base = section.anchor || section.heading;
      const occurrence = (occurrences.get(base) || 0) + 1;
      occurrences.set(base, occurrence);
      return [occurrence === 1 ? base : `${base}~${occurrence}`, section.hash];
    }),
  );
}

/** Returns the article body of a documentation page, which may be empty. */
function articleBody($: CheerioAPI) {
  const body = $('.devsite-article-body').first();
  return body.length ? body : $('article').first();
}

/** Fetches the English version of a page, retrying twice after a delay. */
async function fetchHtml(url: string): Promise<string> {
  let lastError: unknown;
  const englishUrl = new URL(url);
  englishUrl.searchParams.set('hl', 'en');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(englishUrl, {
        headers: {
          'accept-language': 'en-US,en;q=0.9',
          'user-agent':
            'apigee-tools-docs-inventory/0.1 (public documentation review)',
        },
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}: ${url}`);
      }
      return response.text();
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 750 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

/**
 * Selects the sources with the given IDs, or all sources without IDs. Returns
 * nothing when nothing is selected or an ID is unknown or repeated.
 */
function selectSources(sources: Source[], ids: string[]): Source[] | undefined {
  const selected = ids.length
    ? sources.filter(source => ids.includes(source.id))
    : sources;
  if (!selected.length) return undefined;
  if (ids.length && selected.length !== ids.length) return undefined;
  return selected;
}

async function readSources(): Promise<Source[]> {
  return JSON.parse(await readFile(sourceFile, 'utf8')) as Source[];
}

async function readSourcesIfPresent(): Promise<Source[]> {
  try {
    return await readSources();
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return [];
  }
}

/** Reads the section hashes of the last extraction by source and section. */
async function readBaseline(): Promise<Record<string, Record<string, string>>> {
  try {
    const json = await readFile(baselineFile, 'utf8');
    return JSON.parse(json) as Record<string, Record<string, string>>;
  } catch (error) {
    if (isNotFound(error)) return {};
    throw error;
  }
}

async function readCandidate(
  source: Source,
): Promise<{ sections: CandidateSection[] }> {
  const json = await readFile(
    path.join(candidateDir, `${source.id}.json`),
    'utf8',
  );
  return JSON.parse(json) as { sections: CandidateSection[] };
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
