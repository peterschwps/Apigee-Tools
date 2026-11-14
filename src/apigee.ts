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

  /**
   * Requests a path and reads the body, renewing the token once if it was
   * rejected. Network failures and timeouts, also while the body arrives,
   * become API errors.
   */
  const get = (path: string, accept = 'application/json') =>
    limit(async (): Promise<Buffer> => {
      const url = `${base}${path}`;
      const timeout = AbortSignal.timeout(timeoutMs);
      const send = (token: string) =>
        fetch(url, {
          headers: { authorization: `Bearer ${token}`, accept },
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      try {
        let token = tokens.token();
        let response = await send(await token);
        if (response.status === 401) {
          token = tokens.renew(token);
          response = await send(await token);
        }
        const body = Buffer.from(await response.arrayBuffer());
        if (!response.ok) throw responseError(response, body);
        return body;
      } catch (error) {
        throw requestError(error, url, timeout);
      }
    });

  /** Translates failures of fetch; other errors pass through unchanged. */
  function requestError(error: unknown, url: string, timeout: AbortSignal) {
    const fetchFailure =
      error instanceof TypeError || error instanceof DOMException;
    if (signal?.aborted || !fetchFailure) return error;
    const hint = 'Check the network connection and the proxy settings.';
    if (timeout.aborted) {
      return new ApigeeError(
        `The Apigee API did not answer within ${timeoutMs / 1000} seconds.`,
        undefined,
        hint,
      );
    }
    // The cause tells a refused connection from a certificate problem
    const cause = (error as { cause?: { message?: string } }).cause?.message;
    return new ApigeeError(
      `Cannot reach ${new URL(url).host}${cause ? ` (${cause})` : ''}.`,
      undefined,
      hint,
    );
  }

  const json = async <T>(path: string): Promise<T> =>
    JSON.parse((await get(path)).toString('utf8')) as T;

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

    /** Returns the add-ons of an environment under pay-as-you-go. */
    environmentAddons: (name: string, environment: string) =>
      json<NonNullable<Organization['addonsConfig']>>(
        `${organization(name)}/environments/${encode(environment)}/addonsConfig`,
      ),

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
      return get(
        `${organization(name)}/${kind}/${encode(resource)}/revisions/${encode(revision)}?format=bundle`,
        '*/*',
      );
    },
  };
}

/** Loads the organization with its environments and environment groups. */
export async function loadOverview(
  client: ApigeeClient,
  name: string,
): Promise<Overview> {
  const organization = await client.organization(name);
  const payAsYouGo = organization.billingType === 'PAYG';
  const [environments, groups] = await Promise.all([
    Promise.all(
      (organization.environments ?? []).map(async environment => {
        const [details, addons] = await Promise.all([
          client.environment(name, environment),
          // Missing permissions for add-ons must not break the overview
          payAsYouGo
            ? client.environmentAddons(name, environment).catch(() => undefined)
            : undefined,
        ]);
        return { ...details, ...(addons && { addons: enabledAddons(addons) }) };
      }),
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
    addons: enabledAddons(organization.addonsConfig ?? {}),
    environments: environments
      .map(({ name, type, state, addons }) => ({
        name,
        type,
        state,
        ...(addons && { addons }),
      }))
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

/** Returns the readable names of the enabled add-ons. */
function enabledAddons(
  config: NonNullable<Organization['addonsConfig']>,
): string[] {
  return Object.entries(config)
    .filter(([, addon]) => addon?.enabled)
    .map(([key]) => addonNames[key] ?? key)
    .sort();
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
function responseError(response: Response, body: Buffer): ApigeeError {
  let message: string | undefined;
  try {
    const parsed = JSON.parse(body.toString('utf8')) as {
      error?: { message?: string };
    };
    message = parsed.error?.message;
  } catch {
    // Not a Google error body; the status line describes the failure
  }
  return new ApigeeError(
    message || `${response.status} ${response.statusText}`,
    response.status,
    hints[response.status],
  );
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name);
}
