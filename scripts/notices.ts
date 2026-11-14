import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const metafiles = ['dist/meta-node.json', 'dist/meta-webview.json'];
const licenseFile = /^(?:licen[cs]e|notice)/i;
const rule = '='.repeat(78);

/**
 * Writes `dist/ThirdPartyNotices.txt` for the packages that esbuild bundled:
 * one line per package, then each distinct license or notice text once.
 */
async function main(): Promise<void> {
  // The package directories behind the bundled inputs
  const directories = new Set<string>();
  for (const metafile of metafiles) {
    const { inputs } = JSON.parse(
      await readFile(path.join(root, metafile), 'utf8'),
    ) as { inputs: Record<string, unknown> };
    for (const input of Object.keys(inputs)) {
      const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
      if (match) directories.add(match[1]);
    }
  }

  // List each package and group the license texts by content
  const packages: string[] = [];
  const texts = new Map<string, string[]>();
  for (const directory of [...directories].sort()) {
    const { name, version, license } = JSON.parse(
      await readFile(path.join(root, directory, 'package.json'), 'utf8'),
    ) as { name: string; version: string; license: string };
    packages.push(`${name} ${version} (${license})`);
    const entries = await readdir(path.join(root, directory), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isFile() || !licenseFile.test(entry.name)) continue;
      const text = (
        await readFile(path.join(root, directory, entry.name), 'utf8')
      )
        .replace(/^\uFEFF/, '')
        .trim();
      texts.set(text, [...(texts.get(text) ?? []), name]);
    }
  }

  const sections = [...texts].map(
    ([text, names]) => `${rule}\n${names.join(', ')}\n${rule}\n\n${text}\n`,
  );
  await writeFile(
    path.join(root, 'dist', 'ThirdPartyNotices.txt'),
    [
      'Apigee Tools includes the following third-party software:',
      '',
      ...packages,
      '',
      ...sections,
    ].join('\n'),
  );
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
