import type { TokenSource } from './gcloud';
import type { Cell, DeploymentState, Kind, Overview, Row } from './protocol';

/** Reports a failed Apigee API request with a hint on how to resolve it. */
export class ApigeeError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly hint?: string,
  ) {
    super(message);
  }
}

/** Organization fields the dashboard shows. */
type Organization = {
  name: string;
  projectId?: string;
  runtimeType?: string;
  billingType?: string;
  state?: string;
  environments?: string[];
  addonsConfig?: Record<string, { enabled?: boolean } | undefined>;
};

type Environment = { name: string; type?: string; state?: string };
type EnvironmentGroup = { name: string; hostnames?: string[] };
type Deployment = {
  environment: string;
  apiProxy: string;
  revision: string;
  deployStartTime?: string;
};

/** The status of one deployment, which list requests leave out. */
export type DeploymentStatus = {
  state?: DeploymentState | 'RUNTIME_STATE_UNSPECIFIED';
  errors?: { message?: string }[];
  routeConflicts?: {
    description?: string;
    environmentGroup?: string;
    conflictingDeployment?: { apiProxy?: string; basepath?: string };
  }[];
};

export type ApigeeClient = ReturnType<typeof apigeeClient>;

const timeoutMs = 30_000;
const globalEndpoint = 'https://apigee.googleapis.com';

// The global endpoint and both forms of data residency endpoints
const endpointPattern =
  /^https:\/\/(?:(?:[a-z0-9-]+-)?apigee\.googleapis\.com|apigee\.[a-z0-9-]+\.rep\.googleapis\.com)\/?$/;

const hints: Readonly<Record<number, string>> = {
  401: 'Sign in again with gcloud auth login, then refresh.',
  403: 'Reading Apigee needs a role such as Apigee Read-only Admin (roles/apigee.readOnlyAdmin).',
  429: 'The Apigee API quota is used up for the moment. Try again in a minute.',
};

const addonNames: Readonly<Record<string, string>> = {
  advancedApiOpsConfig: 'Advanced API Ops',
  apiSecurityConfig: 'Advanced API Security',
  analyticsConfig: 'Analytics',
  connectorsPlatformConfig: 'Connectors',
  integrationConfig: 'Integration',
  monetizationConfig: 'Monetization',
};

/** Returns the API base URL; the token is only ever sent to Apigee hosts. */
export function apiBase(endpoint?: string): string {
  if (!endpoint) return `${globalEndpoint}/v1`;
  if (!endpointPattern.test(endpoint)) {
    throw new ApigeeError(
      `gcloud overrides the Apigee endpoint with ${endpoint}, which is not an Apigee API endpoint.`,
    );
  }
  return `${endpoint.replace(/\/$/, '')}/v1`;
}

/**
 * Creates a read-only Apigee API client that sends at most `concurrency`
 * requests at a time and gives up when `signal` aborts.
 */
export function apigeeClient(
  tokens: TokenSource,
  base: string,
  {
    signal,
    concurrency = 4,
  }: { signal?: AbortSignal; concurrency?: number } = {},
) {
  const limit = limiter(concurrency);
  const encode = encodeURIComponent;
  const organization = (name: string) => `/organizations/${encode(name)}`;

  /** Sends a request with a token; network failures become API errors. */
  async function send(url: string, token: string, accept: string) {
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      return await fetch(url, {
        headers: { authorization: `Bearer ${token}`, accept },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (timeout.aborted) {
        throw new ApigeeError(
          `The Apigee API did not answer within ${timeoutMs / 1000} seconds.`,
        );
      }
      throw new ApigeeError(
        `Cannot reach ${new URL(url).host}.`,
        undefined,
        'Check the network connection and the proxy settings.',
      );
    }
  }

  /** Requests a path and renews the token once if it was rejected. */
  const get = (path: string, accept = 'application/json') =>
    limit(async () => {
      const url = `${base}${path}`;
      let token = tokens.token();
      let response = await send(url, await token, accept);
      if (response.status === 401) {
        token = tokens.renew(token);
        response = await send(url, await token, accept);
      }
      if (!response.ok) throw await responseError(response);
      return response;
    });

  const json = async <T>(path: string): Promise<T> =>
    (await (await get(path)).json()) as T;

  /** Collects the items of all pages of a list request. */
  async function pages<T>(path: string, key: string): Promise<T[]> {
    const items: T[] = [];
    let pageToken = '';
    do {
      const query = pageToken ? `?pageToken=${encode(pageToken)}` : '';
      const page = await json<Record<string, unknown>>(`${path}${query}`);
      items.push(...((page[key] as T[] | undefined) ?? []));
      pageToken = (page.nextPageToken as string | undefined) ?? '';
    } while (pageToken);
    return items;
  }

  return {
    /** Returns the names of the organizations the account can access. */
    async organizations(): Promise<string[]> {
      const list = await json<{ organizations?: { organization: string }[] }>(
        '/organizations',
      );
      return (list.organizations ?? []).map(entry => entry.organization);
    },

    organization: (name: string) => json<Organization>(organization(name)),

    environment: (name: string, environment: string) =>
      json<Environment>(
        `${organization(name)}/environments/${encode(environment)}`,
      ),

    environmentGroups: (name: string) =>
      pages<EnvironmentGroup>(
        `${organization(name)}/envgroups`,
        'environmentGroups',
      ),

    /** Returns the names of the environments attached to a group. */
    async attachedEnvironments(name: string, group: string): Promise<string[]> {
      const attachments = await pages<{ environment: string }>(
        `${organization(name)}/envgroups/${encode(group)}/attachments`,
        'environmentGroupAttachments',
      );
      return attachments.map(attachment => attachment.environment);
    },

    /** Returns the names of all proxies or shared flows. */
    async names(name: string, kind: Kind): Promise<string[]> {
      const list = await json<{
        proxies?: { name: string }[];
        sharedFlows?: { name: string }[];
      }>(`${organization(name)}/${kind}`);
      return (list.proxies ?? list.sharedFlows ?? []).map(item => item.name);
    },

    /** Returns the deployments of all proxies or shared flows, without status. */
    async deployments(name: string, kind: Kind): Promise<Deployment[]> {
      const list = await json<{ deployments?: Deployment[] }>(
        `${organization(name)}/deployments?sharedFlows=${kind === 'sharedflows'}`,
      );
      return list.deployments ?? [];
    },

    deploymentStatus: (
      name: string,
      environment: string,
      kind: Kind,
      resource: string,
      revision: string,
    ) =>
      json<DeploymentStatus>(
        `${organization(name)}/environments/${encode(environment)}/${kind}/${encode(resource)}/revisions/${encode(revision)}/deployments`,
      ),

    /** Downloads a revision as a bundle zip. */
    async bundle(
      name: string,
      kind: Kind,
      resource: string,
      revision: string,
    ): Promise<Buffer> {
      const response = await get(
        `${organization(name)}/${kind}/${encode(resource)}/revisions/${encode(revision)}?format=bundle`,
        '*/*',
      );
      return Buffer.from(await response.arrayBuffer());
    },
  };
}

/** Loads the organization with its environments and environment groups. */
export async function loadOverview(
  client: ApigeeClient,
  name: string,
): Promise<Overview> {
  const organization = await client.organization(name);
  const [environments, groups] = await Promise.all([
    Promise.all(
      (organization.environments ?? []).map(environment =>
        client.environment(name, environment),
      ),
    ),
    client.environmentGroups(name).then(list =>
      Promise.all(
        list.map(async group => ({
          name: group.name,
          hostnames: group.hostnames ?? [],
          environments: (
            await client.attachedEnvironments(name, group.name)
          ).sort(),
        })),
      ),
    ),
  ]);
  return {
    name: organization.name,
    projectId: organization.projectId ?? organization.name,
    runtimeType: organization.runtimeType,
    billingType: organization.billingType,
    state: organization.state,
    addons: Object.entries(organization.addonsConfig ?? {})
      .filter(([, addon]) => addon?.enabled)
      .map(([key]) => addonNames[key] ?? key)
      .sort(),
    environments: environments
      .map(({ name, type, state }) => ({ name, type, state }))
      .sort(byName),
    groups: groups.sort(byName),
  };
}

/**
 * Loads every proxy and shared flow with its deployed revision per
 * environment. List requests carry no status; `applyStatus` adds it.
 */
export async function loadRows(
  client: ApigeeClient,
  name: string,
): Promise<Row[]> {
  const kinds: Kind[] = ['apis', 'sharedflows'];
  const lists = await Promise.all(
    kinds.map(kind =>
      Promise.all([client.names(name, kind), client.deployments(name, kind)]),
    ),
  );
  const rows: Row[] = [];
  kinds.forEach((kind, index) => {
    const [names, deployments] = lists[index];
    const rowsByName = new Map<string, Row>(
      names.map(resource => [
        resource,
        { kind, name: resource, local: false, cells: {} },
      ]),
    );
    for (const deployment of deployments) {
      const row = rowsByName.get(deployment.apiProxy) ?? {
        kind,
        name: deployment.apiProxy,
        local: false,
        cells: {},
      };
      rowsByName.set(row.name, row);

      // During a redeployment two revisions may be listed; the newer one wins
      const deployedAt = Number(deployment.deployStartTime) || undefined;
      const current = row.cells[deployment.environment];
      if (current && (current.deployedAt ?? 0) > (deployedAt ?? 0)) continue;
      row.cells[deployment.environment] = {
        revision: deployment.revision,
        deployedAt,
      };
    }
    rows.push(...[...rowsByName.values()].sort(byName));
  });
  return rows;
}

/** Copies a deployment status into its cell, reduced to readable messages. */
export function applyStatus(cell: Cell, status: DeploymentStatus): void {
  cell.state =
    status.state === 'READY' ||
    status.state === 'PROGRESSING' ||
    status.state === 'ERROR'
      ? status.state
      : undefined;
  cell.errors = (status.errors ?? [])
    .map(error => error.message ?? '')
    .filter(Boolean);
  cell.routeConflicts = (status.routeConflicts ?? []).map(
    conflict =>
      conflict.description ??
      `Base path ${conflict.conflictingDeployment?.basepath ?? '?'} conflicts with ${conflict.conflictingDeployment?.apiProxy ?? 'another deployment'} in ${conflict.environmentGroup ?? 'an environment group'}.`,
  );
}

/**
 * Picks the deployments whose status to load: those of local bundles first,
 * then the most recently deployed, at most `limit`.
 */
export function statusTargets(
  rows: readonly Row[],
  limit: number,
): { row: Row; environment: string }[] {
  const deployedAt = (target: { row: Row; environment: string }) =>
    target.row.cells[target.environment].deployedAt ?? 0;
  return rows
    .flatMap(row =>
      Object.keys(row.cells).map(environment => ({ row, environment })),
    )
    .sort(
      (a, b) =>
        Number(b.row.local) - Number(a.row.local) ||
        deployedAt(b) - deployedAt(a),
    )
    .slice(0, limit);
}

/** Runs at most `size` tasks at a time; a finished task hands over its slot. */
function limiter(size: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active < size) active++;
    else await new Promise<void>(resolve => waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

/** Builds an error from a failed response and Google's error body. */
async function responseError(response: Response): Promise<ApigeeError> {
  const body = (await response.json().catch(() => undefined)) as
    { error?: { message?: string } } | undefined;
  return new ApigeeError(
    body?.error?.message || `${response.status} ${response.statusText}`,
    response.status,
    hints[response.status],
  );
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name);
}
