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
  /** Base paths that environment groups route to the deployment. */
  basePaths?: string[];
  /** The proxy type, which sets the price of a call under pay-as-you-go. */
  proxyType?: 'STANDARD' | 'EXTENSIBLE';
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
  environments: {
    name: string;
    type?: string;
    state?: string;
    /** Pay-as-you-go configures add-ons per environment. */
    addons?: string[];
  }[];
  groups: { name: string; hostnames: string[]; environments: string[] }[];
};

/** Where an environment runs a shared flow for every proxy. */
export type FlowHookPoint =
  | 'PreProxyFlowHook'
  | 'PreTargetFlowHook'
  | 'PostTargetFlowHook'
  | 'PostProxyFlowHook';

/** A custom attribute of a developer, app group, app, or API product. */
export type Attribute = { name: string; value: string };

/** Who owns apps: a developer or an app group. */
export type Owner = {
  /** `developer/<developerId>` or `appgroup/<name>`. */
  id: string;
  kind: 'developer' | 'appGroup';
  /** The developer's email, or the app group's name. */
  name: string;
  /** First and last name, or the app group's display name. */
  displayName?: string;
  /** Absent when only an app names the owner. */
  status?: 'active' | 'inactive';
  createdAt?: number;
  attributes: Attribute[];
};

/** An API key of an app; the key itself never leaves the extension host. */
export type ApiKey = {
  /** The last four characters of the key. */
  hint: string;
  status?: 'approved' | 'revoked';
  issuedAt?: number;
  /** Absent for keys that never expire. */
  expiresAt?: number;
  /** The API products the key is for, with the approval of each. */
  products: { name: string; status?: 'approved' | 'pending' | 'revoked' }[];
};

export type App = {
  id: string;
  name: string;
  /** The owner's id, or empty when Apigee names none. */
  owner: string;
  status?: 'approved' | 'revoked';
  createdAt?: number;
  attributes: Attribute[];
  keys: ApiKey[];
};

export type Product = {
  name: string;
  displayName?: string;
  approvalType?: 'auto' | 'manual';
  /** Empty when the product is available in every environment. */
  environments: string[];
  /** Its proxies, including those that its operations name. */
  proxies: string[];
  /** The quota, such as "100 per 1 minute". */
  quota?: string;
  attributes: Attribute[];
};

/** Who uses what in an organization; loaded only for the Relationships tab. */
export type Relationships = {
  organization: string;
  owners: Owner[];
  /** Absent when the list could not be read; a note says why. */
  apps?: App[];
  products?: Product[];
  /** Shared flows that FlowCallout policies call, by `kind/name/revision`. */
  calls: Record<string, string[]>;
  /** The shared flows attached to flow hooks, by environment. */
  hooks: Record<string, Partial<Record<FlowHookPoint, string>>>;
  notes: Note[];
};

/** A bundle in the workspace. */
export type LocalBundle = {
  kind: Kind;
  name: string;
  /** Workspace-relative path of the bundle directory. */
  path: string;
};

/** A notice above the tabs: something that needs attention, or a remark. */
export type Note = { tone: 'warning' | 'info'; text: string };

/** Why the dashboard cannot show data, and what may help. */
export type Problem = {
  reason:
    'gcloudMissing' | 'gcloudFailed' | 'signedOut' | 'noOrganization' | 'api';
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
  notes?: Note[];
};

/** An API key by its app and its position among the app's keys. */
export type KeyRef = { app: string; key: number };

/** Signs of the flow view, by their key in the dashboard's signs. */
export type FlowSign = 'warning' | 'error' | 'unknown' | 'differs' | 'none';

/** A step of a flow: the policy it runs. */
export type FlowStep = {
  /** Stays the same across rebuilds, so that focus can stay on the step. */
  key: string;
  /** Where it opens: an index into the places that the host keeps. */
  at: number;
  /** The policy's name. */
  name: string;
  /** The policy's type; absent when the bundle has no such policy. */
  type?: string;
  condition?: string;
  sign?: FlowSign;
  /** Whether it shows muted, such as a disabled policy. */
  muted?: boolean;
  /** Further facts for its tooltip and screen readers. */
  facts: string[];
};

/** A case of a first-match group: a conditional flow, route, or fault rule. */
export type FlowCase = {
  key: string;
  at?: number;
  /** Its position in evaluation order; absent for No Match. */
  number?: number;
  name: string;
  /** What it matches, in short, such as "POST /orders". */
  summary?: string;
  condition?: string;
  /** Where a route rule sends the request. */
  destination?: string;
  sign?: FlowSign;
  muted?: boolean;
  /** For route rules: whether the view follows this route to its target. */
  followed?: boolean;
  facts: string[];
  steps: FlowStep[];
};

/** A part of an endpoint: a list of steps, or a first-match group. */
export type FlowSegment = {
  /** Apigee's element name, such as PreFlow or DefaultFaultRule. */
  label: string;
  facts: string[];
} & ({ steps: FlowStep[] } | { cases: FlowCase[] });

/** A stage of a band, in the order in which Apigee runs it. */
export type FlowItem =
  | { kind: 'client'; key: string; basePath?: string }
  | {
      kind: 'hook';
      key: string;
      point: FlowHookPoint;
      /** The shared flow attached to the hook. */
      sharedFlow: string;
      /** Its revision deployed in the environment. */
      revision?: string;
      sign?: FlowSign;
      facts: string[];
    }
  | {
      kind: 'endpoint';
      key: string;
      at: number;
      role: 'proxy' | 'target' | 'shared';
      name: string;
      sign?: FlowSign;
      facts: string[];
      segments: FlowSegment[];
    }
  | {
      kind: 'routes';
      key: string;
      /** The proxy endpoint whose route rules these are, by position. */
      endpoint: number;
      cases: FlowCase[];
    }
  | {
      kind: 'backend';
      key: string;
      at?: number;
      text: string;
      sign?: FlowSign;
      facts: string[];
    };

/** The stages of one way through an endpoint, such as the request. */
export type FlowBand = {
  kind: 'request' | 'response' | 'event' | 'error' | 'after' | 'steps';
  /** Remarks under the band's heading. */
  facts: string[];
  items: FlowItem[];
};

/** A proxy endpoint from the client to the backend and back, or a shared flow. */
export type FlowMap = { key: string; title: string; bands: FlowBand[] };

/** Where the flow view reads a bundle: the workspace, or an environment. */
export type FlowSource = {
  /** Empty for the workspace, else the environment's name. */
  id: string;
  label: string;
};

/** What the flow view shows: the flow of one bundle. */
export type FlowView = {
  /** Counts the models; places of other versions are ignored. */
  version: number;
  kind: Kind;
  name: string;
  /** Workspace-relative path of the local copy; absent without one. */
  path?: string;
  /** The source shown, by its id. */
  source: string;
  sources: FlowSource[];
  organization?: string;
  /** Whether environments can be chosen, or what keeps them from it. */
  environments:
    'ready' | 'untrusted' | 'unloaded' | 'loading' | 'problem' | 'undeployed';
  problem?: Problem;
  /** The deployment shown, in an environment. */
  cell?: Cell;
  /** How many files differ from the local copy, in an environment. */
  changes?: number;
  maps: FlowMap[];
  notes: Note[];
};

export type HostMessage =
  | { type: 'snapshot'; snapshot: Snapshot }
  // Apart from the snapshot, which is posted often, since it can be large
  | { type: 'relationships'; relationships: Relationships }
  // Pin or Unpin from the context menu of a node in the graph; empty unpins
  | { type: 'pin'; node: string }
  // The answer to a key search: where the key is, if any app has it
  | { type: 'keyOwner'; found?: KeyRef }
  | { type: 'flow'; flow: FlowView };

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'organization'; name: string }
  | { type: 'compare'; kind: Kind; name: string; environment: string }
  | { type: 'details'; kind: Kind; name: string }
  // The Relationships tab was opened and needs its data
  | { type: 'relationships' }
  | { type: 'findKey'; key: string }
  | { type: 'copyKey'; app: string; key: number }
  | { type: 'openBundle'; path: string }
  // The flow view: open a place of a model, or follow another route rule
  | { type: 'flowOpen'; version: number; at: number }
  | { type: 'flowRoute'; version: number; endpoint: number; route: number }
  | { type: 'flowSource'; source: string }
  // Shows the flow of a proxy or shared flow, in an environment if given
  | { type: 'showFlow'; kind: Kind; name: string; environment?: string }
  | { type: 'signIn' }
  | { type: 'settings' }
  | { type: 'trust' };
