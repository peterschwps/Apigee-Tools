import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { referencePattern } from './bundle';
import { classifyDocument } from './linter';
import type { Kind } from './protocol';
import { parseXml, rootElementName, type XmlNode } from './xml';

/** Bundle files by path, such as `apiproxy/policies/AM-Set.xml`. */
export type BundleFiles = Map<string, Buffer>;

/** Paths that differ between a deployed revision and the local bundle. */
export type BundleChanges = {
  changed: string[];
  /** Only in the local bundle. */
  added: string[];
  /** Only in the deployed revision. */
  removed: string[];
};

// Apigee bundles are at most 15 MB, so larger archives are not bundles
const maxZipBytes = 32 * 1024 * 1024;
const maxContentBytes = 64 * 1024 * 1024;

const endOfDirectory = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const directoryEntry = 0x02014b50;
const localEntry = 0x04034b50;

/** Returns the top-level directory of a bundle kind in archives and on disk. */
export function bundleDirectory(kind: Kind): string {
  return kind === 'apis' ? 'apiproxy' : 'sharedflowbundle';
}

/**
 * Extracts the files of a zip archive into memory. It reads the stored and
 * deflate methods without ZIP64, which covers Apigee's bundles; entry names
 * never become file paths.
 */
export function unzip(zip: Buffer): BundleFiles {
  if (zip.length > maxZipBytes) {
    throw new Error('The revision bundle is larger than 32 MiB.');
  }
  const end = zip.lastIndexOf(endOfDirectory);
  if (end < 0 || end + 22 > zip.length) {
    throw new Error('The revision bundle is not a zip archive.');
  }

  // Sizes come from the central directory, so data descriptors need no care
  const files: BundleFiles = new Map();
  let offset = zip.readUInt32LE(end + 16);
  let total = 0;
  for (let count = zip.readUInt16LE(end + 10); count > 0; count--) {
    if (zip.readUInt32LE(offset) !== directoryEntry) {
      throw new Error('The revision bundle has a damaged directory.');
    }
    const method = zip.readUInt16LE(offset + 10);
    const size = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const header = zip.readUInt32LE(offset + 42);
    const name = zip
      .toString('utf8', offset + 46, offset + 46 + nameLength)
      .replace(/\\/g, '/');
    offset +=
      46 +
      nameLength +
      zip.readUInt16LE(offset + 30) +
      zip.readUInt16LE(offset + 32);
    if (
      name.endsWith('/') ||
      name.startsWith('/') ||
      name.split('/').includes('..')
    ) {
      continue;
    }
    if (size === 0xffffffff || header === 0xffffffff) {
      throw new Error(
        'The revision bundle uses ZIP64, which is not supported.',
      );
    }
    if (zip.readUInt32LE(header) !== localEntry) {
      throw new Error(`The revision bundle has a damaged entry: ${name}`);
    }

    // The local header repeats name and extra field, with lengths of its own
    const start =
      header +
      30 +
      zip.readUInt16LE(header + 26) +
      zip.readUInt16LE(header + 28);
    const data = zip.subarray(start, start + size);
    if (method !== 0 && method !== 8) {
      throw new Error(
        `The revision bundle compresses ${name} with an unsupported method.`,
      );
    }
    const content =
      method === 8
        ? inflateRawSync(data, { maxOutputLength: maxContentBytes })
        : data;
    total += content.length;
    if (total > maxContentBytes) {
      throw new Error('The revision bundle unpacks to more than 64 MiB.');
    }
    files.set(name, content);
  }
  return files;
}

/**
 * Reads a local bundle directory, keyed like the entries of a revision
 * archive, such as `apiproxy/policies/AM-Set.xml`.
 */
export async function readBundle(
  directory: string,
  kind: Kind,
): Promise<BundleFiles> {
  const files: BundleFiles = new Map();

  // Links count like what they point to; a set of visited directories ends
  // link cycles, and hidden files such as .DS_Store are never bundle files
  const visited = new Set<string>();
  const walk = async (current: string, relative: string): Promise<void> => {
    const real = await realpath(current);
    if (visited.has(real)) return;
    visited.add(real);
    for (const name of await readdir(current)) {
      if (name.startsWith('.')) continue;
      const file = path.join(current, name);
      const key = relative ? `${relative}/${name}` : name;
      const info = await stat(file).catch(() => undefined);
      if (info?.isDirectory()) await walk(file, key);
      else if (info?.isFile()) {
        files.set(`${bundleDirectory(kind)}/${key}`, await readFile(file));
      }
    }
  };
  await walk(directory, '');
  return files;
}

/**
 * Returns a fingerprint for each comparable file. The top-level descriptor and
 * `manifests/` are left out, since Apigee writes them anew on import.
 */
export function fingerprints(files: BundleFiles): Map<string, string> {
  const prints = new Map<string, string>();
  for (const [file, content] of files) {
    const kind = classifyDocument(file);
    const segments = file.split('/');
    if (
      kind === 'apiProxy' ||
      kind === 'sharedFlowBundle' ||
      segments[1] === 'manifests' ||
      segments.some(segment => segment.startsWith('.'))
    ) {
      continue;
    }
    prints.set(
      file,
      createHash('sha256')
        .update(comparableForm(file, content))
        .digest('base64'),
    );
  }
  return prints;
}

/** Lists the files that differ between two sets of fingerprints. */
export function compareBundles(
  remote: ReadonlyMap<string, string>,
  local: ReadonlyMap<string, string>,
): BundleChanges {
  const remoteFiles = [...remote.keys()].sort();
  return {
    changed: remoteFiles.filter(
      file => local.has(file) && local.get(file) !== remote.get(file),
    ),
    added: [...local.keys()].filter(file => !remote.has(file)).sort(),
    removed: remoteFiles.filter(file => !local.has(file)),
  };
}

/** Returns whether two sets of fingerprints describe different bundles. */
export function differs(
  remote: ReadonlyMap<string, string>,
  local: ReadonlyMap<string, string>,
): boolean {
  const { changed, added, removed } = compareBundles(remote, local);
  return Boolean(changed.length || added.length || removed.length);
}

/**
 * Returns the shared flows that the FlowCallout policies of a bundle call,
 * sorted. Names with templates are left out, since they resolve at runtime.
 */
export function sharedFlowCalls(files: BundleFiles): string[] {
  const names = new Set<string>();
  for (const [file, content] of files) {
    if (classifyDocument(file) !== 'policy') continue;
    const xml = content.toString('utf8').replace(/^﻿/, '');
    // Most policies are something else, which the root name tells cheaply
    if (rootElementName(xml) !== 'FlowCallout') continue;
    const name = parseXml(xml).root?.children.find(
      child => child.name === 'SharedFlowBundle',
    )?.text?.value;
    if (name && referencePattern.test(name)) names.add(name);
  }
  return [...names].sort();
}

/**
 * Returns the form in which a file is compared: bundle XML as its element
 * tree, other text with normalized line endings, and binaries as they are.
 */
function comparableForm(file: string, content: Buffer): Buffer | string {
  if (content.includes(0)) return content;

  // Latin-1 keeps every byte of other encodings, so changes still show
  const text = content
    .toString(isUtf8(content) ? 'utf8' : 'latin1')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');
  if (!classifyDocument(file)) return text;

  // ponytail: comments and text between child elements are not compared;
  // fall back to the text if such edits ever need to count as changes.
  const document = parseXml(text);
  return document.root && !document.syntaxIssues.length
    ? JSON.stringify(elementTree(document.root))
    : text;
}

/** Returns an element as name, sorted attributes, leaf text, and children. */
function elementTree(node: XmlNode): unknown[] {
  return [
    node.name,
    node.attributes
      .map(attribute => [attribute.name, attribute.value ?? ''])
      .sort(([a], [b]) => a.localeCompare(b)),
    node.text?.value ?? '',
    node.children.map(elementTree),
  ];
}
