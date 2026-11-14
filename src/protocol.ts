// State and messages shared by the dashboard's extension host and webview.
// Types only, so that both sides can import this module.

/** Deployable bundle kinds, named like their Apigee API collections. */
export type Kind = 'apis' | 'sharedflows';

/** Deployment states that the Apigee API reports. */
export type DeploymentState = 'READY' | 'PROGRESSING' | 'ERROR';

/** The deployment of one revision in one environment. */
export type Cell = {
  revision: string;
  /** Deployment start in milliseconds since the epoch. */
  deployedAt?: number;
  /** Absent until the status has been loaded. */
  state?: DeploymentState;
  errors?: string[];
  routeConflicts?: string[];
  /** Whether the revision differs from the local bundle; absent if unknown. */
  drift?: boolean;
};

/** A proxy or shared flow with its deployments by environment name. */
export type Row = {
  kind: Kind;
  name: string;
  /** Whether the workspace contains a bundle of this kind and name. */
  local: boolean;
  cells: Record<string, Cell>;
};

/** The organization with its environments and environment groups. */
export type Overview = {
  name: string;
  projectId: string;
  runtimeType?: string;
  billingType?: string;
  state?: string;
  addons: string[];
  environments: { name: string; type?: string; state?: string }[];
  groups: { name: string; hostnames: string[]; environments: string[] }[];
};

/** A bundle in the workspace with the findings of the linter. */
export type LocalBundle = {
  kind: Kind;
  name: string;
  /** Workspace-relative path of the bundle directory. */
  path: string;
  errors: number;
  warnings: number;
};

/** Why the dashboard cannot show data, and what may help. */
export type Problem = {
  reason: 'gcloudMissing' | 'signedOut' | 'noOrganization' | 'api';
  message: string;
  hint?: string;
};

/** Everything the webview renders; the host always sends all of it. */
export type Snapshot = {
  trusted: boolean;
  /** False for a restored panel until the user asks for data. */
  requested: boolean;
  loading: boolean;
  account?: string;
  organizations: string[];
  organization?: string;
  overview?: Overview;
  rows?: Row[];
  bundles?: LocalBundle[];
  problem?: Problem;
  /** Additional information, such as deployments without a status check. */
  note?: string;
};

export type HostMessage = { type: 'snapshot'; snapshot: Snapshot };

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'organization'; name: string }
  | { type: 'compare'; kind: Kind; name: string; environment: string }
  | { type: 'openBundle'; path: string }
  | { type: 'signIn' }
  | { type: 'settings' }
  | { type: 'trust' };
