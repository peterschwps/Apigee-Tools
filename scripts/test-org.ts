// Creates a free Apigee X evaluation organization to try the dashboard
// against, fills it with the test fixtures, and deletes it again:
//
//   npx tsx scripts/test-org.ts provision PROJECT_ID [REGION]
//   npx tsx scripts/test-org.ts populate PROJECT_ID
//   npx tsx scripts/test-org.ts status PROJECT_ID
//   npx tsx scripts/test-org.ts delete PROJECT_ID --yes
//
// An evaluation organization costs nothing and Google deletes it after 60
// days. It is created without VPC peering and without internet access, so no
// billable network resources are set up. The project needs a billing account,
// and gcloud must be signed in with an account that may provision Apigee.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { gcloudRunner, tokenSource, type TokenSource } from '../src/gcloud';
import type { Kind } from '../src/protocol';
import { readBundle, type BundleFiles } from '../src/revision';

/** What the commands need from the outside, replaceable in tests. */
export type Context = {
  tokens: TokenSource;
  /** Runs gcloud with visible output and fails when gcloud fails. */
  gcloud(args: string[]): void;
  /** Runs gcloud and returns its output. */
  read(args: string[]): Promise<string>;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
};

type Operation = { name: string; done?: boolean; error?: { message?: string } };

/** Reports a failed Apigee API request with Google's message. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const api = 'https://apigee.googleapis.com/v1';
const fixtures = path.resolve(__dirname, '..', 'test', 'fixtures');
const projectPattern = /^[a-z][-a-z0-9]{4,28}[a-z0-9]$/;
const regionPattern = /^[a-z]+-[a-z]+\d+$/;

// The evaluation organization brings environment eval and group eval-group;
// the test adds a second environment in a group of its own
const testEnvironment = 'test';
const testGroup = 'test-group';
const testHostname = 'test.apigee-tools.example';

const usage = `Usage: npx tsx scripts/test-org.ts <command> PROJECT_ID

  provision PROJECT_ID [REGION]  Create a free evaluation organization (default region europe-west3)
  populate PROJECT_ID            Add a test environment and group, deploy the test fixtures
  status PROJECT_ID              Show the organization, its groups, and deployments
  delete PROJECT_ID --yes        Delete the organization`;

/** Returns the commands, bound to a context. */
export function testOrg(context: Context) {
  const { log } = context;
  const encode = encodeURIComponent;

  /** Sends a request, renewing a rejected token once, and returns the JSON body. */
  async function request<T>(
    method: string,
    resource: string,
    body?: unknown,
  ): Promise<T> {
    const send = async (token: string) => {
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
      };
      if (body !== undefined && !(body instanceof FormData)) {
        headers['content-type'] = 'application/json';
      }
      return fetch(`${api}${resource}`, {
        method,
        headers,
        body:
          body instanceof FormData || body === undefined
            ? body
            : JSON.stringify(body),
      });
    };
    let token = context.tokens.token();
    let response = await send(await token);
    if (response.status === 401) {
      token = context.tokens.renew(token);
      response = await send(await token);
    }
    const text = await response.text();
    let json: { error?: { message?: string } } = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      // Not JSON; the status line describes the failure
    }
    if (!response.ok) {
      throw new ApiError(
        response.status,
        json.error?.message || `${response.status} ${response.statusText}`,
      );
    }
    return json as T;
  }

  /** Waits until a long-running operation is done. */
  async function finish(operation: Operation, what: string): Promise<void> {
    log(`${what}…`);
    for (let current = operation; !current.done;) {
      await context.sleep(5_000);
      current = await request<Operation>('GET', `/${current.name}`);
      if (current.error) {
        throw new Error(`${what} failed: ${current.error.message}`);
      }
    }
  }

  /** Returns the organization, or nothing while it does not exist yet. */
  async function organization(project: string) {
    try {
      return await request<{ state?: string; expiresAt?: string }>(
        'GET',
        `/organizations/${encode(project)}`,
      );
    } catch (error) {
      // Apigee answers 403 for organizations that do not exist (yet)
      if (error instanceof ApiError && [403, 404].includes(error.status)) {
        return undefined;
      }
      throw error;
    }
  }

  /** Imports a bundle as a new revision and returns its number. */
  async function importBundle(
    project: string,
    kind: Kind,
    name: string,
    files: BundleFiles,
  ): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(zip(files))]), `${name}.zip`);
    const { revision } = await request<{ revision: string }>(
      'POST',
      `/organizations/${encode(project)}/${kind}?name=${encode(name)}&action=import`,
      form,
    );
    log(`Imported ${name} as revision ${revision}.`);
    return revision;
  }

  /** Deploys a revision, replacing another one in the environment. */
  async function deploy(
    project: string,
    environment: string,
    kind: Kind,
    name: string,
    revision: string,
  ): Promise<void> {
    await request(
      'POST',
      `/organizations/${encode(project)}/environments/${encode(environment)}/${kind}/${encode(name)}/revisions/${encode(revision)}/deployments?override=true`,
    );
    log(`Deploying ${name} revision ${revision} to ${environment}.`);
  }

  return {
    /** Creates the evaluation organization and waits until it is active. */
    async provision(project: string, region = 'europe-west3'): Promise<void> {
      if (!regionPattern.test(region)) {
        throw new Error(`"${region}" is not a region such as europe-west3.`);
      }
      const existing = await organization(project);
      if (existing) {
        log(`Organization ${project} exists already (${existing.state}).`);
        return;
      }

      // Without billing, enabling Apigee fails with a message that hides why
      const billing = await context.read([
        'billing',
        'projects',
        'describe',
        project,
        '--format=value(billingEnabled)',
      ]);
      if (billing.trim() !== 'True') {
        throw new Error(
          [
            `Project ${project} has no active billing account. Apigee requires one even`,
            'for the free evaluation organization, which itself costs nothing.',
            `Link an open account: gcloud billing projects link ${project} --billing-account=ACCOUNT_ID`,
            '(gcloud billing accounts list shows yours; a closed one has to be reopened',
            'in the Google Cloud console first).',
          ].join('\n'),
        );
      }
      context.gcloud([
        'services',
        'enable',
        'apigee.googleapis.com',
        'cloudkms.googleapis.com',
        `--project=${project}`,
      ]);
      // A newly enabled API takes a few minutes to reach Apigee
      for (let attempt = 1; ; attempt++) {
        try {
          await request(
            'POST',
            `/projects/${encode(project)}:provisionOrganization`,
            {
              analyticsRegion: region,
              runtimeLocation: region,
              disableVpcPeering: true,
            },
          );
          break;
        } catch (error) {
          const propagating =
            error instanceof ApiError &&
            error.status === 403 &&
            /has not been used|is disabled/i.test(error.message);
          if (!propagating || attempt === 10) throw error;
          log('Waiting until the newly enabled Apigee API is available…');
          await context.sleep(30_000);
        }
      }
      log('Provisioning started; this takes up to 40 minutes.');

      // The organization answers 403 until it is ready
      for (let minutes = 0; minutes <= 60; minutes++) {
        const current = await organization(project);
        if (current?.state === 'ACTIVE') {
          log(`Organization ${project} is active.`);
          return;
        }
        await context.sleep(60_000);
      }
      throw new Error(
        `Organization ${project} is not active after an hour; check it with the status command.`,
      );
    },

    /** Adds the test environment and group and deploys the test fixtures. */
    async populate(project: string): Promise<void> {
      const organizationPath = `/organizations/${encode(project)}`;
      // The runtime instance is still being created when the organization
      // already reports active; attachments need it ready
      let instance: string | undefined;
      for (let minutes = 0; !instance; minutes++) {
        const { instances = [] } = await request<{
          instances?: { name: string; state?: string }[];
        }>('GET', `${organizationPath}/instances`);
        if (instances[0]?.state === 'ACTIVE') {
          instance = instances[0].name;
        } else if (minutes === 60) {
          throw new Error(
            `The runtime instance of ${project} is not ready after an hour (${instances[0]?.state ?? 'missing'}).`,
          );
        } else {
          if (minutes % 5 === 0) {
            log(
              `Waiting for the runtime instance (${instances[0]?.state ?? 'not created yet'})…`,
            );
          }
          await context.sleep(60_000);
        }
      }

      // A second environment, attached to the instance and to a group of its own
      const environments = await request<string[]>(
        'GET',
        `${organizationPath}/environments`,
      );
      if (!environments.includes(testEnvironment)) {
        await finish(
          await request<Operation>('POST', `${organizationPath}/environments`, {
            name: testEnvironment,
          }),
          `Creating environment ${testEnvironment}`,
        );
      }
      const { attachments = [] } = await request<{
        attachments?: { environment: string }[];
      }>(
        'GET',
        `${organizationPath}/instances/${encode(instance)}/attachments`,
      );
      if (!attachments.some(item => item.environment === testEnvironment)) {
        await finish(
          await request<Operation>(
            'POST',
            `${organizationPath}/instances/${encode(instance)}/attachments`,
            { environment: testEnvironment },
          ),
          `Attaching ${testEnvironment} to instance ${instance}`,
        );
      }
      const { environmentGroups = [] } = await request<{
        environmentGroups?: { name: string }[];
      }>('GET', `${organizationPath}/envgroups`);
      if (!environmentGroups.some(group => group.name === testGroup)) {
        await finish(
          await request<Operation>('POST', `${organizationPath}/envgroups`, {
            name: testGroup,
            hostnames: [testHostname],
          }),
          `Creating environment group ${testGroup}`,
        );
      }
      const { environmentGroupAttachments = [] } = await request<{
        environmentGroupAttachments?: { environment: string }[];
      }>('GET', `${organizationPath}/envgroups/${testGroup}/attachments`);
      if (
        !environmentGroupAttachments.some(
          item => item.environment === testEnvironment,
        )
      ) {
        await finish(
          await request<Operation>(
            'POST',
            `${organizationPath}/envgroups/${testGroup}/attachments`,
            { environment: testEnvironment },
          ),
          `Attaching ${testEnvironment} to ${testGroup}`,
        );
      }

      // The fixture as it is matches the workspace; a changed copy in the test
      // environment must show up as "differs from local"
      const proxy = await readBundle(
        path.join(fixtures, 'bundle', 'apiproxy'),
        'apis',
      );
      const changed = new Map(proxy);
      const policy = 'apiproxy/policies/SA-Limit.xml';
      changed.set(
        policy,
        Buffer.from(
          proxy.get(policy)!.toString('utf8').replace('30ps', '40ps'),
        ),
      );
      const sharedFlow = await readBundle(
        path.join(fixtures, 'sharedflow', 'sharedflowbundle'),
        'sharedflows',
      );
      const same = await importBundle(project, 'apis', 'hello', proxy);
      const different = await importBundle(project, 'apis', 'hello', changed);
      const flow = await importBundle(
        project,
        'sharedflows',
        'traffic-shared',
        sharedFlow,
      );
      await deploy(project, 'eval', 'apis', 'hello', same);
      await deploy(project, testEnvironment, 'apis', 'hello', different);
      await deploy(project, 'eval', 'sharedflows', 'traffic-shared', flow);
      log(
        [
          '',
          'Done. Open this repository in the Extension Development Host (F5), run',
          `"Apigee Tools: Open Dashboard", and choose organization ${project}. Expected:`,
          `- hello: revision ${same} in eval matches the local bundle,`,
          `  revision ${different} in ${testEnvironment} shows "≠ local";`,
          `- traffic-shared: revision ${flow} in eval;`,
          `- groups eval-group and ${testGroup} (${testHostname}).`,
        ].join('\n'),
      );
    },

    /** Shows the organization, its groups, and its deployments. */
    async status(project: string): Promise<void> {
      const organizationPath = `/organizations/${encode(project)}`;
      const current = await organization(project);
      if (!current) {
        log(`Organization ${project} does not exist or is not ready yet.`);
        return;
      }
      const expires = current.expiresAt
        ? `, expires ${new Date(Number(current.expiresAt)).toISOString().slice(0, 10)}`
        : '';
      log(`Organization ${project}: ${current.state}${expires}`);
      const { environmentGroups = [] } = await request<{
        environmentGroups?: { name: string; hostnames?: string[] }[];
      }>('GET', `${organizationPath}/envgroups`);
      for (const group of environmentGroups) {
        log(
          `Group ${group.name}: ${(group.hostnames ?? []).join(', ') || 'no hostnames'}`,
        );
      }
      for (const sharedFlows of [false, true]) {
        const { deployments = [] } = await request<{
          deployments?: {
            environment: string;
            apiProxy: string;
            revision: string;
          }[];
        }>('GET', `${organizationPath}/deployments?sharedFlows=${sharedFlows}`);
        for (const item of deployments) {
          log(
            `${sharedFlows ? 'Shared flow' : 'API proxy'} ${item.apiProxy} revision ${item.revision} in ${item.environment}`,
          );
        }
      }
    },

    /**
     * Deletes the organization and waits until it is gone; its operation
     * disappears with it, so the organization itself is polled.
     */
    async delete(project: string): Promise<void> {
      await request('DELETE', `/organizations/${encode(project)}`);
      log(`Deleting organization ${project}…`);
      for (let attempt = 0; attempt < 20; attempt++) {
        if (!(await organization(project))) {
          log(
            `Deleted. To remove the project as well, run: gcloud projects delete ${project}`,
          );
          return;
        }
        await context.sleep(30_000);
      }
      log('Deletion is still running; check it later with the status command.');
    },
  };
}

/**
 * Packs bundle files into a zip archive with stored entries, as the Apigee
 * import expects a zip upload.
 */
export function zip(files: BundleFiles): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of files) {
    const fileName = Buffer.from(name, 'utf8');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(0, 8); // stored
    header.writeUInt16LE(0x21, 12); // 1980-01-01
    header.writeUInt32LE(crc32(content), 14);
    header.writeUInt32LE(content.length, 18);
    header.writeUInt32LE(content.length, 22);
    header.writeUInt16LE(fileName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    header.copy(central, 6, 4, 26);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(header, fileName, content);
    centrals.push(central, fileName);
    offset += header.length + fileName.length + content.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

async function main(): Promise<void> {
  const [command, project, option] = process.argv.slice(2);
  if (!command || !project || !projectPattern.test(project)) {
    console.error(usage);
    process.exitCode = 2;
    return;
  }
  const gcloudPath = process.env.GCLOUD ?? 'gcloud';
  const gcloud = gcloudRunner(gcloudPath);
  const commands = testOrg({
    tokens: tokenSource(gcloud),
    read: gcloud,
    gcloud: args => {
      // Windows needs a shell to run gcloud.cmd
      const result = spawnSync(gcloudPath, args, {
        stdio: 'inherit',
        shell: process.platform === 'win32',
      });
      if (result.status !== 0)
        throw new Error(`gcloud ${args.join(' ')} failed.`);
    },
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    log: line => console.log(line),
  });
  switch (command) {
    case 'provision':
      return commands.provision(project, option);
    case 'populate':
      return commands.populate(project);
    case 'status':
      return commands.status(project);
    case 'delete':
      if (option !== '--yes') {
        console.error(
          `This deletes organization ${project}. Repeat with --yes to confirm.`,
        );
        process.exitCode = 2;
        return;
      }
      return commands.delete(project);
    default:
      console.error(usage);
      process.exitCode = 2;
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
