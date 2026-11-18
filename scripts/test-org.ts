// Creates a free Apigee X evaluation organization to try the dashboard
// against, deploys the sample shop from test/sample-shop into it, and deletes
// it again:
//
//   npx tsx scripts/test-org.ts provision PROJECT_ID [REGION]
//   npx tsx scripts/test-org.ts populate PROJECT_ID
//   npx tsx scripts/test-org.ts status PROJECT_ID
//   npx tsx scripts/test-org.ts conflict PROJECT_ID on|off
//   npx tsx scripts/test-org.ts delete PROJECT_ID --yes
//
// An evaluation organization costs nothing and Google deletes it after 60
// days. It is created without VPC peering and without internet access, so no
// billable network resources are set up. The project needs a billing account,
// and GCloud must be signed in with an account that may provision Apigee.
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import {
  gcloudCommand,
  GcloudError,
  gcloudInvocation,
  gcloudRunner,
  tokenSource,
  type TokenSource,
} from '../src/gcloud';
import { apigeeClient } from '../src/apigee';
import { readXml } from '../src/bundle';
import type { Kind } from '../src/protocol';
import {
  bundleDirectory,
  differs,
  fingerprints,
  readBundle,
  unzip,
  type BundleFiles,
} from '../src/revision';
import { parseXml } from '../src/xml';

/** What the commands need from the outside, replaceable in tests. */
export type Context = {
  tokens: TokenSource;
  /** Runs GCloud with visible output and fails when GCloud fails. */
  gcloud(args: string[]): void;
  /** Runs GCloud and returns its output. */
  read(args: string[]): Promise<string>;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
};

type Operation = { name: string; done?: boolean; error?: { message?: string } };

/** The state, errors, and route conflicts of one deployment. */
type Status = {
  state?: string;
  errors?: { message?: string }[];
  routeConflicts?: {
    environmentGroup?: string;
    conflictingDeployment?: { apiProxy?: string; environment?: string };
  }[];
};

/** A proxy or shared flow of the sample, named like the dashboard names it. */
type SampleBundle = { kind: Kind; name: string; directory: string };

/** Reports a failed Apigee API request with Google's message. */
class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const api = 'https://apigee.googleapis.com/v1';
const sample = path.resolve(
  __dirname,
  '..',
  'test',
  'sample-shop',
  'src',
  'main',
  'apigee',
);
const projectPattern = /^[a-z][-a-z0-9]{4,28}[a-z0-9]$/;
const regionPattern = /^[a-z]+-[a-z]+\d+$/;

// The evaluation organization brings environment eval and group eval-group;
// the test adds a second environment in a group of its own
const evalEnvironment = 'eval';
const evalGroup = 'eval-group';
const testEnvironment = 'test';
const testGroup = 'test-group';
const testHostname = 'test.apigee-tools.example';

// What the Cloud Code files of the sample cannot express. Drafts stay local;
// history holds older revisions as edits of the local files, oldest first, so
// that revision 1 is the first entry; pins name the revisions an environment
// runs instead of the newest one
export const drafts = new Set(['reviews', 'audit-draft']);
export const history: Record<string, ((files: BundleFiles) => void)[]> = {
  'catalog-v2': ['2.0', '2.1', '2.2'].map(version => files => {
    edit(
      files,
      'apiproxy/policies/AM-CatalogVersion.xml',
      '>2.3<',
      `>${version}<`,
    );
    edit(
      files,
      'apiproxy/resources/jsc/page-links.js',
      'var pageSizeLimit = 100;',
      'var pageSizeLimit = 50;',
    );
  }),
  // Before the order validation, a header policy took its place
  'orders-v1': [
    files => {
      edit(
        files,
        'apiproxy/proxies/default.xml',
        '<Name>JS-ValidateOrder</Name>',
        '<Name>AM-LegacyOrderHeader</Name>',
      );
      files.delete('apiproxy/policies/JS-ValidateOrder.xml');
      files.set(
        'apiproxy/policies/AM-LegacyOrderHeader.xml',
        Buffer.from(legacyOrderHeader),
      );
    },
  ],
  'security-baseline': [
    files =>
      edit(
        files,
        'sharedflowbundle/policies/SA-PerApp.xml',
        '<Rate>50ps</Rate>',
        '<Rate>30ps</Rate>',
      ),
  ],
};
const legacyOrderHeader = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<AssignMessage continueOnError="false" enabled="true" name="AM-LegacyOrderHeader">
    <DisplayName>AM-LegacyOrderHeader</DisplayName>
    <Set>
        <Headers>
            <Header name="x-order-source">legacy-checkout</Header>
        </Headers>
    </Set>
    <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
    <AssignTo createNew="false" transport="http" type="request"/>
</AssignMessage>
`;
export const pins: Record<string, Record<string, number>> = {
  test: { 'catalog-v2': 2, 'orders-v1': 1, 'security-baseline': 1 },
};

// The payments target server authenticates with keys that Apigee generates,
// so no private key is part of the repository; one alias expires soon
const keystore = {
  environment: evalEnvironment,
  name: 'payments-mtls',
  reference: 'payments-keystore',
  aliases: { 'payments-client': 365, 'payments-client-expiring': 14 },
};
const maps: Record<string, Record<string, Record<string, string>>> = {
  eval: {
    'shop-settings': {
      'feature.new-checkout': 'true',
      'orders.max-items': '50',
    },
  },
  test: {
    'shop-settings': {
      'feature.new-checkout': 'false',
      'orders.max-items': '20',
    },
  },
};
const revokedApp = 'mobile-app';

const usage = `Usage: npx tsx scripts/test-org.ts <command> PROJECT_ID

  provision PROJECT_ID [REGION]  Create a free evaluation organization (default region europe-west3)
  populate PROJECT_ID            Add a test environment and group, deploy the sample shop
  status PROJECT_ID              Show the organization, its groups, and deployments
  conflict PROJECT_ID on|off     Attach test to eval-group as well, which causes route conflicts
  delete PROJECT_ID --yes        Delete the organization`;

/** Returns the commands, bound to a context. */
export function testOrg(context: Context) {
  const { log } = context;
  const encode = encodeURIComponent;
  const client = apigeeClient(context.tokens, api);

  /**
   * Sends a request and returns the JSON body. A change that another running
   * operation locks out, such as provisioning still attaching an environment,
   * is retried for up to 20 minutes.
   */
  async function request<T>(
    method: string,
    resource: string,
    body?: unknown,
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await send<T>(method, resource, body);
      } catch (error) {
        const locked =
          method !== 'GET' &&
          error instanceof ApiError &&
          /locked by another operation/i.test(error.message);
        if (!locked || attempt === 40) throw error;
        if (attempt % 5 === 1) {
          log('Waiting for another operation of the organization to finish…');
        }
        await context.sleep(30_000);
      }
    }
  }

  /** Sends a request, renewing a rejected token once, and returns the JSON body. */
  async function send<T>(
    method: string,
    resource: string,
    body?: unknown,
  ): Promise<T> {
    const attempt = async (token: string) => {
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
    let response = await attempt(await token);
    if (response.status === 401) {
      token = context.tokens.renew(token);
      response = await attempt(await token);
    }
    const text = await response.text();
    let json: {
      error?: {
        message?: string;
        details?: {
          violations?: { filename?: string; description?: string }[];
        }[];
      };
    } = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      // Not JSON; the status line describes the failure
    }
    if (!response.ok) {
      // A rejected import lists each problem with its file
      const violations = (json.error?.details ?? [])
        .flatMap(detail => detail.violations ?? [])
        .map(
          violation =>
            `\n  ${violation.filename ?? '?'}: ${violation.description ?? ''}`,
        )
        .join('');
      throw new ApiError(
        response.status,
        `${json.error?.message || `${response.status} ${response.statusText}`}${violations}`,
      );
    }
    return json as T;
  }

  /** Waits until a long-running operation is done. */
  async function finish(operation: Operation, what: string): Promise<void> {
    log(`${what}…`);
    let current = operation;
    while (!current.done) {
      await context.sleep(5_000);
      current = await request<Operation>('GET', `/${operation.name}`);
    }
    if (current.error) {
      throw new Error(`${what} failed: ${current.error.message}`);
    }
  }

  /** Returns the organization, or nothing while it does not exist yet. */
  async function organization(project: string) {
    try {
      return await request<{
        state?: string;
        expiresAt?: string;
        billingType?: string;
      }>('GET', `/organizations/${encode(project)}`);
    } catch (error) {
      // Apigee answers 403 for organizations that do not exist (yet)
      if (error instanceof ApiError && [403, 404].includes(error.status)) {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Fails unless the organization exists and is an evaluation organization,
   * so that a mistyped project ID never changes or deletes a paid one.
   */
  async function evaluationOrganization(project: string): Promise<void> {
    const current = await organization(project);
    if (!current) {
      throw new Error(
        `Organization ${project} does not exist or is not ready yet; check it with the status command.`,
      );
    }
    if (current.billingType !== 'EVALUATION') {
      throw new Error(
        `Organization ${project} is ${current.billingType ?? 'of an unknown type'}, not an evaluation organization; this script changes only evaluation organizations.`,
      );
    }
  }

  /** Waits until a deployment is ready or failed and returns its status. */
  async function settled(
    project: string,
    environment: string,
    kind: Kind,
    name: string,
    revision: string,
  ): Promise<Status> {
    for (let attempt = 0; attempt < 60; attempt++) {
      const status = await request<Status>(
        'GET',
        `/organizations/${encode(project)}/environments/${encode(environment)}/${kind}/${encode(name)}/revisions/${encode(revision)}/deployments`,
      );
      if (status.state === 'READY' || status.state === 'ERROR') return status;
      await context.sleep(10_000);
    }
    return { state: 'still not ready after ten minutes' };
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

  /** Creates an entity and returns false when it exists already. */
  async function create(resource: string, body?: unknown): Promise<boolean> {
    try {
      await request('POST', resource, body);
      return true;
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.status === 409 || /already exists/i.test(error.message))
      ) {
        return false;
      }
      throw error;
    }
  }

  /** Returns the attachment of an environment to a group, if there is one. */
  async function attachment(
    project: string,
    group: string,
    environment: string,
  ): Promise<{ name: string } | undefined> {
    const { environmentGroupAttachments = [] } = await request<{
      environmentGroupAttachments?: { name: string; environment: string }[];
    }>(
      'GET',
      `/organizations/${encode(project)}/envgroups/${encode(group)}/attachments`,
    );
    return environmentGroupAttachments.find(
      item => item.environment === environment,
    );
  }

  /** Attaches an environment to a group unless it is attached already. */
  async function attach(
    project: string,
    group: string,
    environment: string,
  ): Promise<void> {
    if (await attachment(project, group, environment)) return;
    await finish(
      await request<Operation>(
        'POST',
        `/organizations/${encode(project)}/envgroups/${encode(group)}/attachments`,
        { environment },
      ),
      `Attaching ${environment} to ${group}`,
    );
  }

  /** Returns the revisions of a proxy or shared flow; none if it is missing. */
  async function revisions(
    project: string,
    kind: Kind,
    name: string,
  ): Promise<number[]> {
    try {
      const list = await request<string[]>(
        'GET',
        `/organizations/${encode(project)}/${kind}/${encode(name)}/revisions`,
      );
      return list.map(Number);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return [];
      throw error;
    }
  }

  /**
   * Imports a sample bundle: first the history revisions that are missing,
   * then the local files unless the newest revision equals them. Returns the
   * newest revision.
   */
  async function sync(project: string, bundle: SampleBundle): Promise<string> {
    const local = await readBundle(bundle.directory, bundle.kind);
    const changes = history[bundle.name] ?? [];
    let newest = Math.max(
      0,
      ...(await revisions(project, bundle.kind, bundle.name)),
    );

    // Only missing revisions are built, so that a later local edit of a line
    // that the history changes does not stop populate
    for (const change of changes.slice(newest)) {
      const files = new Map(local);
      change(files);
      newest = Number(
        await importBundle(project, bundle.kind, bundle.name, files),
      );
    }

    // The comparison is the dashboard's, so the import shows as matching
    if (newest > changes.length) {
      const remote = unzip(
        await client.bundle(project, bundle.kind, bundle.name, String(newest)),
      );
      if (!differs(fingerprints(remote), fingerprints(local))) {
        return String(newest);
      }
    }
    return importBundle(project, bundle.kind, bundle.name, local);
  }

  /**
   * Creates what the deployments of an environment depend on: the keystore
   * with its reference, target servers, resource files, and KVMs.
   */
  async function configure(project: string, environment: string) {
    const base = `/organizations/${encode(project)}/environments/${encode(environment)}`;
    const folder = path.join(sample, 'environments', environment);
    if (keystore.environment === environment) {
      await create(`${base}/keystores`, { name: keystore.name });
      for (const [alias, days] of Object.entries(keystore.aliases)) {
        await create(
          `${base}/keystores/${encode(keystore.name)}/aliases?format=selfsignedcert&alias=${encode(alias)}`,
          {
            keySize: '2048',
            sigAlg: 'SHA256withRSA',
            subject: { commonName: `${alias}.shop.example` },
            certValidityInDays: days,
          },
        );
      }
      await create(`${base}/references`, {
        name: keystore.reference,
        refers: keystore.name,
        resourceType: 'KeyStore',
      });
    }

    // Cloud Code calls two fields of a target server differently
    const servers = await readJson<{ enabled?: boolean; tlsInfo?: unknown }[]>(
      path.join(folder, 'targetservers.json'),
    );
    for (const { enabled, tlsInfo, ...server } of servers) {
      await create(`${base}/targetservers`, {
        ...server,
        isEnabled: enabled,
        sSLInfo: tlsInfo,
      });
    }

    // Resource files lie in resourcefiles/TYPE/NAME
    const resources = path.join(folder, 'resourcefiles');
    for (const type of await visible(resources)) {
      for (const name of await visible(path.join(resources, type))) {
        const content = await readFile(path.join(resources, type, name));
        const form = new FormData();
        form.append('file', new Blob([new Uint8Array(content)]), name);
        await create(
          `${base}/resourcefiles?type=${encode(type)}&name=${encode(name)}`,
          form,
        );
      }
    }
    for (const [map, entries] of Object.entries(maps[environment] ?? {})) {
      await create(`${base}/keyvaluemaps`, { name: map, encrypted: true });
      for (const [name, value] of Object.entries(entries)) {
        await create(`${base}/keyvaluemaps/${encode(map)}/entries`, {
          name,
          value,
        });
      }
    }
  }

  /**
   * Deploys the sample bundles of a kind as each environment's
   * deployments.json lists them and waits for them. Rejected and failed
   * deployments are returned rather than thrown, since the sample has some.
   */
  async function deployAll(
    project: string,
    kind: Kind,
    newest: ReadonlyMap<string, string>,
  ): Promise<string[]> {
    const { deployments = [] } = await request<{
      deployments?: {
        environment: string;
        apiProxy: string;
        revision: string;
      }[];
    }>(
      'GET',
      `/organizations/${encode(project)}/deployments?sharedFlows=${kind === 'sharedflows'}`,
    );
    const problems: string[] = [];
    const started: [string, string, string][] = [];
    for (const environment of [evalEnvironment, testEnvironment]) {
      const listed = await readJson<{
        proxies?: (string | { name: string })[];
        sharedflows?: (string | { name: string })[];
      }>(path.join(sample, 'environments', environment, 'deployments.json'));
      const entries =
        (kind === 'apis' ? listed.proxies : listed.sharedflows) ?? [];
      for (const entry of entries) {
        const name = typeof entry === 'string' ? entry : entry.name;
        const revision =
          pins[environment]?.[name]?.toString() ??
          newest.get(`${kind}/${name}`);
        if (!revision) {
          throw new Error(
            `${environment}/deployments.json lists ${name}, which the sample does not contain.`,
          );
        }
        const running = deployments.some(
          item =>
            item.environment === environment &&
            item.apiProxy === name &&
            item.revision === revision,
        );
        if (running) continue;
        try {
          await deploy(project, environment, kind, name, revision);
          started.push([environment, name, revision]);
        } catch (error) {
          problems.push(
            `${name} revision ${revision} in ${environment} was rejected: ${(error as Error).message}`,
          );
        }
      }
    }
    for (const [environment, name, revision] of started) {
      const status = await settled(project, environment, kind, name, revision);
      if (status.state !== 'READY') {
        const errors = (status.errors ?? []).map(error => error.message);
        problems.push(
          `${name} revision ${revision} in ${environment} is ${status.state}${errors.length ? `: ${errors.join('; ')}` : ''}`,
        );
      }
    }
    return problems;
  }

  /** Attaches the shared flows that an environment's flowhooks.json names. */
  async function hook(project: string, environment: string): Promise<void> {
    const hooks = await readJson<Record<string, unknown>>(
      path.join(sample, 'environments', environment, 'flowhooks.json'),
    );
    for (const [point, flowHook] of Object.entries(hooks)) {
      await request(
        'PUT',
        `/organizations/${encode(project)}/environments/${encode(environment)}/flowhooks/${encode(point)}`,
        flowHook,
      );
    }
  }

  /** Creates the API products, developers, and apps of the sample. */
  async function consumers(project: string): Promise<void> {
    const base = `/organizations/${encode(project)}`;
    const folder = path.join(sample, 'tests', 'shop');
    const products = await readJson<object[]>(
      path.join(folder, 'products.json'),
    );
    for (const product of products) {
      await create(`${base}/apiproducts`, product);
    }
    const developers = await readJson<object[]>(
      path.join(folder, 'developers.json'),
    );
    for (const developer of developers) {
      await create(`${base}/developers`, developer);
    }
    const apps = await readJson<{ name: string; developerEmail: string }[]>(
      path.join(folder, 'developerapps.json'),
    );
    for (const { developerEmail, ...app } of apps) {
      // Cloud Code writes unset fields as empty strings
      const body = Object.fromEntries(
        Object.entries(app).filter(([, value]) => value !== ''),
      );
      const developer = `${base}/developers/${encode(developerEmail)}/apps`;
      await create(developer, body);

      // Checked every run, in case an earlier one stopped before revoking
      if (app.name === revokedApp) {
        const { status } = await request<{ status?: string }>(
          'GET',
          `${developer}/${encode(app.name)}`,
        );
        if (status !== 'revoked') {
          await request(
            'POST',
            `${developer}/${encode(app.name)}?action=revoke`,
          );
        }
      }
    }
  }

  /** Shows the organization, its groups, and each deployment's status. */
  async function status(project: string): Promise<void> {
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
      const { environmentGroupAttachments = [] } = await request<{
        environmentGroupAttachments?: { environment: string }[];
      }>(
        'GET',
        `${organizationPath}/envgroups/${encode(group.name)}/attachments`,
      );
      const environments = environmentGroupAttachments
        .map(item => item.environment)
        .join(', ');
      log(
        `Group ${group.name} (${environments || 'no environments'}): ${(group.hostnames ?? []).join(', ') || 'no hostnames'}`,
      );
    }
    for (const kind of ['apis', 'sharedflows'] as const) {
      const { deployments = [] } = await request<{
        deployments?: {
          environment: string;
          apiProxy: string;
          revision: string;
        }[];
      }>(
        'GET',
        `${organizationPath}/deployments?sharedFlows=${kind === 'sharedflows'}`,
      );
      deployments.sort(
        (a, b) =>
          a.apiProxy.localeCompare(b.apiProxy) ||
          a.environment.localeCompare(b.environment),
      );
      for (const item of deployments) {
        const details = await request<Status>(
          'GET',
          `${organizationPath}/environments/${encode(item.environment)}/${kind}/${encode(item.apiProxy)}/revisions/${encode(item.revision)}/deployments`,
        ).catch((error: Error): Status => ({
          state: `unknown (${error.message})`,
        }));
        const notes = [
          ...(details.errors ?? []).map(error => error.message),
          ...(details.routeConflicts ?? []).map(
            conflict =>
              `route conflict with ${conflict.conflictingDeployment?.apiProxy} in ${conflict.conflictingDeployment?.environment} (${conflict.environmentGroup})`,
          ),
        ];
        log(
          `${kind === 'apis' ? 'API proxy' : 'Shared flow'} ${item.apiProxy} revision ${item.revision} in ${item.environment}: ${details.state ?? 'unknown'}${notes.length ? ` - ${notes.join('; ')}` : ''}`,
        );
      }
    }
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
      let operation: Operation | undefined;
      for (let attempt = 1; ; attempt++) {
        try {
          operation = await request<Operation>(
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
          if (error instanceof ApiError && error.status === 409) {
            log('Provisioning is already running.');
            break;
          }
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

      // The organization answers 403 until it is ready; a failed provisioning
      // shows in its operation, and other errors are worth another try
      for (let minutes = 0; minutes <= 60; minutes++) {
        const current = await organization(project).catch((error: Error) => {
          if (error instanceof GcloudError) throw error;
          log(`Checking failed (${error.message}); trying again.`);
          return undefined;
        });
        if (current?.state === 'ACTIVE') {
          log(`Organization ${project} is active.`);
          return;
        }
        const progress =
          operation &&
          (await request<Operation>('GET', `/${operation.name}`).catch(
            () => undefined,
          ));
        if (progress?.error) {
          throw new Error(`Provisioning failed: ${progress.error.message}`);
        }
        await context.sleep(60_000);
      }
      throw new Error(
        `Organization ${project} is not active after an hour; check it with the status command.`,
      );
    },

    /** Adds the test environment and group and deploys the sample shop. */
    async populate(project: string): Promise<void> {
      await evaluationOrganization(project);
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
        if (environments.length >= 2) {
          throw new Error(
            `${project} already has two environments (${environments.join(', ')}), the limit of an evaluation organization.`,
          );
        }
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
      await attach(project, testGroup, testEnvironment);
      if (await attachment(project, evalGroup, testEnvironment)) {
        throw new Error(
          `Route conflicts are on; turn them off first: npx tsx scripts/test-org.ts conflict ${project} off`,
        );
      }

      // Dependencies first, since a deployment that lacks one is rejected
      for (const environment of [evalEnvironment, testEnvironment]) {
        await configure(project, environment);
      }
      const newest = new Map<string, string>();
      for (const bundle of await sampleBundles()) {
        if (drafts.has(bundle.name)) continue;
        newest.set(
          `${bundle.kind}/${bundle.name}`,
          await sync(project, bundle),
        );
      }

      // Flow hooks need their shared flows deployed, proxies their callouts;
      // problems collected so far are shown even when a later step fails
      const problems: string[] = [];
      try {
        problems.push(...(await deployAll(project, 'sharedflows', newest)));
        for (const environment of [evalEnvironment, testEnvironment]) {
          await hook(project, environment);
        }
        problems.push(...(await deployAll(project, 'apis', newest)));
        await consumers(project);
        log('');
        await status(project);
      } finally {
        if (problems.length) {
          log('');
          log(
            'Not ready; test/sample-shop/README.md lists the intended failures:',
          );
          for (const problem of problems) log(`- ${problem}`);
        }
      }
    },

    status,

    /**
     * Attaches the test environment to eval-group as well, or detaches it
     * again. Every base path deployed in both environments then conflicts.
     */
    async conflict(project: string, setting: string): Promise<void> {
      if (setting !== 'on' && setting !== 'off') {
        throw new Error('Choose on or off: conflict PROJECT_ID on|off');
      }
      await evaluationOrganization(project);
      if (setting === 'on') {
        await attach(project, evalGroup, testEnvironment);
        log('Route conflicts are on; status shows them.');
        return;
      }
      const attached = await attachment(project, evalGroup, testEnvironment);
      if (attached) {
        await finish(
          await request<Operation>(
            'DELETE',
            `/organizations/${encode(project)}/envgroups/${evalGroup}/attachments/${encode(attached.name)}`,
          ),
          `Detaching ${testEnvironment} from ${evalGroup}`,
        );
      }
      log('Route conflicts are off.');
    },

    /**
     * Deletes the organization and waits until it is gone; its operation
     * disappears with it, so the organization itself is polled.
     */
    async delete(project: string): Promise<void> {
      await evaluationOrganization(project);
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

/** Lists the sample's bundles, named after their descriptors. */
export async function sampleBundles(): Promise<SampleBundle[]> {
  const bundles: SampleBundle[] = [];
  for (const kind of ['sharedflows', 'apis'] as const) {
    const parent = path.join(sample, kind === 'apis' ? 'apiproxies' : kind);
    for (const folder of await visible(parent)) {
      const directory = path.join(parent, folder, bundleDirectory(kind));
      const descriptor = (await visible(directory)).find(file =>
        file.endsWith('.xml'),
      );
      const name = descriptor
        ? parseXml(
            await readXml(path.join(directory, descriptor)),
          ).root?.attributes.find(attribute => attribute.name === 'name')?.value
        : undefined;
      bundles.push({ kind, name: name || folder, directory });
    }
  }
  return bundles;
}

/** Replaces text in a bundle file and fails when the text is missing. */
export function edit(
  files: BundleFiles,
  file: string,
  from: string,
  to: string,
): void {
  const content = files.get(file)?.toString('utf8');
  if (!content?.includes(from)) {
    throw new Error(`${file} does not contain "${from}".`);
  }
  files.set(file, Buffer.from(content.replace(from, to)));
}

/** Lists a directory without hidden entries; none when it is missing. */
async function visible(directory: string): Promise<string[]> {
  const names = await readdir(directory).catch((): string[] => []);
  return names.filter(name => !name.startsWith('.')).sort();
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
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
      // The same invocation as the dashboard's, including cmd.exe on Windows
      const run = gcloudInvocation(gcloudCommand(gcloudPath), args);
      const result = spawnSync(run.file, run.args, {
        stdio: 'inherit',
        shell: run.shell,
        cwd: homedir(),
      });
      if (result.status !== 0) {
        throw new Error(
          `gcloud ${args.join(' ')} failed${result.error ? `: ${result.error.message}` : '.'}`,
        );
      }
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
    case 'conflict':
      return commands.conflict(project, option ?? '');
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
    const cause = (error as { cause?: Error }).cause?.message;
    console.error(
      error instanceof Error ? error.message : error,
      cause ? `(${cause})` : '',
    );
    process.exitCode = 1;
  });
}
