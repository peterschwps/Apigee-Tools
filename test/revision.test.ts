import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import {
  compareBundles,
  differs,
  fingerprints,
  readBundle,
  unzip,
} from '../src/revision';

const fixtures = path.join(__dirname, 'fixtures');
const bundle = path.join(fixtures, 'bundle', 'apiproxy');

let workspace: string;

before(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'apigee-tools-revision-'));
});

after(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/** Copies the fixture bundle and applies `edit` to the copy's files. */
async function editedCopy(
  name: string,
  edit: (directory: string) => Promise<void>,
): Promise<string> {
  const directory = path.join(workspace, name, 'apiproxy');
  await cp(bundle, directory, { recursive: true });
  await edit(directory);
  return directory;
}

async function revision() {
  return unzip(await readFile(path.join(fixtures, 'revision.zip')));
}

test('unzip reads stored and deflated entries and skips directories', async () => {
  const files = await revision();
  assert.deepEqual([...files.keys()].sort(), [
    'apiproxy/hello.xml',
    'apiproxy/policies/OAS-Validate.xml',
    'apiproxy/policies/RF-Fault.xml',
    'apiproxy/policies/SA-Limit.xml',
    'apiproxy/proxies/default.xml',
    'apiproxy/resources/oas/hello.yaml',
    'apiproxy/targets/backend-v2.xml',
    'apiproxy/targets/default.xml',
  ]);
  assert.deepEqual(
    files.get('apiproxy/proxies/default.xml'),
    await readFile(path.join(bundle, 'proxies', 'default.xml')),
  );
  assert.deepEqual(
    files.get('apiproxy/resources/oas/hello.yaml'),
    await readFile(path.join(bundle, 'resources', 'oas', 'hello.yaml')),
  );
});

test('unzip rejects data that is not a zip archive', () => {
  assert.throws(() => unzip(Buffer.from('<APIProxy/>')), /not a zip archive/);
});

test('a local bundle is read with the keys of the archive', async () => {
  const local = await readBundle(bundle, 'apis');
  assert.deepEqual(
    [...local.keys()].sort(),
    [...(await revision()).keys()].sort(),
  );
});

test('the deployed revision of an unchanged bundle does not differ', async () => {
  const remote = fingerprints(await revision());
  const local = fingerprints(await readBundle(bundle, 'apis'));
  assert.equal(differs(remote, local), false);
});

test('formatting, line endings, and the descriptor do not count as changes', async () => {
  const directory = await editedCopy('reformatted', async copy => {
    await writeFile(
      path.join(copy, 'policies', 'SA-Limit.xml'),
      [
        '<SpikeArrest enabled="true" name="SA-Limit">',
        '    <!-- reformatted by an editor -->',
        '    <DisplayName>SA &amp; Limit</DisplayName>',
        '    <Rate>30ps</Rate>',
        '    <UseEffectiveCount>true</UseEffectiveCount>',
        '</SpikeArrest>',
      ].join('\r\n'),
    );
    const proxy = path.join(copy, 'proxies', 'default.xml');
    await writeFile(
      proxy,
      (await readFile(proxy, 'utf8')).replace(/\n/g, '\r\n'),
    );
    await writeFile(
      path.join(copy, 'hello.xml'),
      '<APIProxy revision="7" name="hello"><CreatedAt>1700000000000</CreatedAt></APIProxy>',
    );
  });
  const remote = fingerprints(await revision());
  const local = fingerprints(await readBundle(directory, 'apis'));
  assert.deepEqual(compareBundles(remote, local), {
    changed: [],
    added: [],
    removed: [],
  });
});

test('changed, added, and removed files are reported', async () => {
  const directory = await editedCopy('changed', async copy => {
    const target = path.join(copy, 'targets', 'default.xml');
    const xml = await readFile(target, 'utf8');
    const edited = xml.replace(
      /<\/TargetEndpoint>\s*$/,
      '  <Description>changed</Description>\n</TargetEndpoint>\n',
    );
    assert.notEqual(edited, xml);
    await writeFile(target, edited);
    await mkdir(path.join(copy, 'resources', 'jsc'));
    await writeFile(
      path.join(copy, 'resources', 'jsc', 'new.js'),
      'var a = 1;\n',
    );
    await rm(path.join(copy, 'policies', 'RF-Fault.xml'));
  });
  const remote = fingerprints(await revision());
  const local = fingerprints(await readBundle(directory, 'apis'));
  assert.deepEqual(compareBundles(remote, local), {
    changed: ['apiproxy/targets/default.xml'],
    added: ['apiproxy/resources/jsc/new.js'],
    removed: ['apiproxy/policies/RF-Fault.xml'],
  });
  assert.equal(differs(remote, local), true);
});
