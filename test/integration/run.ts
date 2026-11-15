import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';
import { build } from 'esbuild';

// The engine floor from package.json, to test the oldest supported VS Code
const vscodeVersion = '1.96.0';
const root = path.resolve(__dirname, '..', '..');
const outputDirectory = path.join(root, '.cache', 'integration');

const workspaceFiles: Record<string, string> = {
  'apiproxy/policies/FC-Typo.xml':
    '<FlowCallout name="FC-Typo" enabled="flase">\n  <SharedFlowBundle>shared</SharedFlowBundle>\n</FlowCallout>\n',
  'apiproxy/policies/FC-Disable.xml':
    '<FlowCallout name="FC-Disable">\n  <SharedFlowBundle>shared</SharedFlowBundle>\n  <Bogus/>\n</FlowCallout>\n',
  'apiproxy/proxies/default.xml':
    '<ProxyEndpoint name="default">\n  <PreFlow>\n    <Request>\n      <Step>\n        <Name></Name>\n      </Step>\n    </Request>\n  </PreFlow>\n</ProxyEndpoint>\n',
};

/**
 * Returns a fake gcloud that logs each call and answers like a signed-in
 * gcloud, so the suite can tell whether and how often gcloud ran.
 */
function fakeGcloud(log: string): string {
  return `#!/bin/sh
echo "$*" >> '${log}'
case "$1 $2" in
  "auth print-access-token") echo ya29.integration ;;
  "config list") echo '{"core":{"account":"dev@example.com","project":"acme"}}' ;;
  *) echo "ERROR: unexpected gcloud call: $*" >&2; exit 1 ;;
esac
`;
}

async function main(): Promise<void> {
  // Bundle the TypeScript suite, since the extension host loads JavaScript
  const suite = path.join(outputDirectory, 'suite.js');
  await build({
    entryPoints: [path.join(__dirname, 'suite.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
    outfile: suite,
    logLevel: 'warning',
  });

  const workspace = await mkdtemp(
    path.join(tmpdir(), 'apigee-tools-integration-'),
  );
  const userData = await mkdtemp(
    path.join(tmpdir(), 'apigee-tools-user-data-'),
  );
  try {
    for (const [file, content] of Object.entries(workspaceFiles)) {
      await mkdir(path.dirname(path.join(workspace, file)), {
        recursive: true,
      });
      await writeFile(path.join(workspace, file), content);
    }

    // A local bundle that matches the deployed revision of the fake organization
    const fixtures = path.join(root, 'test', 'fixtures');
    await cp(
      path.join(fixtures, 'bundle', 'apiproxy'),
      path.join(workspace, 'hello', 'apiproxy'),
      { recursive: true },
    );

    // The dashboard runs the fake gcloud from the user settings
    const gcloudLog = path.join(userData, 'gcloud.log');
    const gcloud = path.join(userData, 'gcloud');
    await writeFile(gcloud, fakeGcloud(gcloudLog), { mode: 0o755 });
    await mkdir(path.join(userData, 'User'));
    await writeFile(
      path.join(userData, 'User', 'settings.json'),
      JSON.stringify({ 'apigeeTools.gcloudPath': gcloud }),
    );
    await runTests({
      version: vscodeVersion,
      cachePath: path.join(root, '.cache', 'vscode-test'),
      extensionDevelopmentPath: root,
      extensionTestsPath: suite,
      extensionTestsEnv: {
        APIGEE_TOOLS_GCLOUD_LOG: gcloudLog,
        APIGEE_TOOLS_REVISION_ZIP: path.join(fixtures, 'revision.zip'),
      },
      launchArgs: [
        workspace,
        '--disable-extensions',
        '--skip-welcome',
        '--skip-release-notes',
        `--user-data-dir=${userData}`,
        `--extensions-dir=${path.join(userData, 'extensions')}`,
      ],
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
