import path from 'node:path';
import { lint } from '../src/linter';
import { loadSpecifications } from '../src/spec';

export const repositoryRoot = path.resolve(__dirname, '..');
export const specs = loadSpecifications(repositoryRoot);
export const fixtureBundle = path.join(
  __dirname,
  'fixtures',
  'bundle',
  'apiproxy',
);
export const policyFile = path.join(fixtureBundle, 'policies', 'Test.xml');
export const proxyFile = path.join(fixtureBundle, 'proxies', 'test.xml');
export const sharedFlowBundle = path.join(
  __dirname,
  'fixtures',
  'sharedflow',
  'sharedflowbundle',
);
export const sharedFlowFile = path.join(
  sharedFlowBundle,
  'sharedflows',
  'test.xml',
);
export const sharedFlowManifest = path.join(sharedFlowBundle, 'test.xml');
export const sharedFlowPolicyFile = path.join(
  sharedFlowBundle,
  'policies',
  'Test.xml',
);

/**
 * Lints like `lint`, but ignores AX114, since most tests use generic file paths
 * unrelated to each policy's name.
 */
export const lintIgnoringFileName: typeof lint = (
  xml,
  filePath,
  specs,
  ignored = new Set(),
) => lint(xml, filePath, specs, new Set([...ignored, 'AX114']));
