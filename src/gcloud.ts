import { execFile, type ExecFileException } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

/** Runs GCloud with the given arguments and resolves to its standard output. */
export type Gcloud = (args: readonly string[]) => Promise<string>;

/** Hands out the access token and renews it once for concurrent rejections. */
export type TokenSource = {
  token(): Promise<string>;
  renew(stale: Promise<string>): Promise<string>;
};

/** What the dashboard reads from the GCloud configuration. */
export type GcloudConfig = {
  account?: string;
  project?: string;
  /** Apigee API endpoint override, which data residency organizations set. */
  endpoint?: string;
};

/** Reports why GCloud could not run or could not provide credentials. */
export class GcloudError extends Error {
  constructor(
    readonly reason: 'missing' | 'signedOut' | 'failed',
    message: string,
  ) {
    super(message);
  }
}

const timeoutMs = 30_000;

// Names of GCloud configurations: lower-case letters, digits, and hyphens
const configurationPattern = /^[a-z][-a-z0-9]*$/;

// Characters that cmd.exe interprets even inside double quotes
const unsafeForCmd = /["%!\r\n]/;

// Access tokens are URL-safe; other output is not a token
const tokenPattern = /^[\w.-]+$/;

// GCloud's wording when the account has to sign in (again)
const signedOutPattern =
  /gcloud auth login|active account|credentialed accounts|reauthenticat/i;

/** Returns whether a name is a valid GCloud configuration name. */
export function isConfigurationName(name: string): boolean {
  return configurationPattern.test(name);
}

/**
 * Returns how to start GCloud: directly on macOS and Linux, and on Windows as
 * one quoted command line for cmd.exe, which Node needs to run `gcloud.cmd`.
 */
export function gcloudInvocation(
  path: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[]; shell: boolean } {
  if (platform !== 'win32') {
    return { file: path, args: [...args], shell: false };
  }
  if ([path, ...args].some(part => unsafeForCmd.test(part))) {
    throw new GcloudError(
      'failed',
      `The GCloud path "${path}" contains characters that cmd.exe cannot take.`,
    );
  }
  return { file: [`"${path}"`, ...args].join(' '), args: [], shell: true };
}

/**
 * Creates a runner for GCloud. It starts in the home directory, so that cmd.exe
 * never picks up a `gcloud` file from a workspace, and it never waits for a
 * prompt.
 */
export function gcloudRunner(setting: string, configuration = ''): Gcloud {
  if (configuration && !isConfigurationName(configuration)) {
    throw new GcloudError(
      'failed',
      `"${configuration}" is not a valid GCloud configuration name.`,
    );
  }
  const extra = configuration ? [`--configuration=${configuration}`] : [];
  return args =>
    new Promise((resolveOutput, reject) => {
      const path = gcloudCommand(setting);
      // The invocation rejects paths that cmd.exe cannot take
      const invocation = gcloudInvocation(path, [...args, ...extra]);
      const child = execFile(
        invocation.file,
        invocation.args,
        {
          cwd: homedir(),
          env: { ...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: '1' },
          shell: invocation.shell,
          timeout: timeoutMs,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error) reject(gcloudError(error, stderr, path));
          else resolveOutput(stdout);
        },
      );
      child.stdin?.end();
    });
}

/** Keeps the access token in memory only; failures are not cached. */
export function tokenSource(gcloud: Gcloud): TokenSource {
  let current: Promise<string> | undefined;
  const fetchToken = (): Promise<string> => {
    const pending = gcloud(['auth', 'print-access-token']).then(output => {
      const token = output.trim();
      if (!tokenPattern.test(token)) {
        throw new GcloudError(
          'failed',
          'GCloud did not print an access token.',
        );
      }
      return token;
    });
    pending.catch(() => {
      if (current === pending) current = undefined;
    });
    current = pending;
    return pending;
  };
  return {
    token: () => current ?? fetchToken(),
    // Concurrent rejections of the same token renew it only once
    renew: stale => (current && current !== stale ? current : fetchToken()),
  };
}

/** Reads the account, the project, and the Apigee endpoint override. */
export async function gcloudConfig(gcloud: Gcloud): Promise<GcloudConfig> {
  const output = await gcloud(['config', 'list', '--format=json']);
  let config: {
    core?: { account?: string; project?: string };
    api_endpoint_overrides?: { apigee?: string };
  };
  try {
    config = JSON.parse(output);
  } catch {
    throw new GcloudError(
      'failed',
      'GCloud printed an unreadable configuration.',
    );
  }
  return {
    account: config.core?.account,
    project: config.core?.project,
    endpoint: config.api_endpoint_overrides?.apigee,
  };
}

/**
 * Resolves the configured command, or GCloud on PATH, to an executable file.
 * Explicit paths are relative to the home directory and may start with ~.
 * Only absolute PATH entries are searched, never the current directory.
 * Windows launchers need their full path so they find their SDK resources.
 */
export function gcloudCommand(setting: string): string {
  const command = setting || 'gcloud';
  const expanded =
    command === '~' || /^~[\\/]/.test(command)
      ? join(homedir(), command.slice(2))
      : command;
  const explicitPath = /[\\/]/.test(expanded)
    ? resolve(homedir(), expanded)
    : undefined;
  const candidates = explicitPath
    ? [explicitPath]
    : (process.env.PATH ?? '')
        .split(delimiter)
        .map(directory => directory.replace(/^"(.*)"$/, '$1'))
        .filter(directory => isAbsolute(directory))
        .map(directory => join(directory, expanded));
  const windows = process.platform === 'win32';
  // Do not select the extensionless Unix script shipped beside `gcloud.cmd`.
  const endings = windows
    ? /\.(?:com|exe|bat|cmd)$/i.test(expanded)
      ? ['']
      : (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter(ending => /^\.(?:com|exe|bat|cmd)$/i.test(ending))
    : [''];
  for (const candidate of candidates) {
    for (const ending of endings) {
      const file = candidate + ending;
      try {
        if (!statSync(file).isFile()) continue;
        accessSync(file, windows ? constants.F_OK : constants.X_OK);
        return file;
      } catch {
        // Try the next executable in PATH order.
      }
    }
  }
  throw new GcloudError(
    'missing',
    `GCloud was not found ("${explicitPath ?? command}").`,
  );
}

/** Translates a failed GCloud run into a reason the dashboard can act on. */
function gcloudError(
  error: ExecFileException,
  stderr: string,
  path: string,
): GcloudError {
  if (error.code === 'ENOENT') {
    return new GcloudError('missing', `GCloud was not found ("${path}").`);
  }
  if (signedOutPattern.test(stderr)) {
    return new GcloudError('signedOut', 'GCloud has no valid sign-in.');
  }
  if (error.killed) {
    return new GcloudError(
      'failed',
      `GCloud did not finish within ${timeoutMs / 1000} seconds.`,
    );
  }
  const lines = stderr.trim().split(/\r?\n/);
  const message = lines.find(line => line.startsWith('ERROR:')) ?? lines.at(-1);
  return new GcloudError('failed', message || error.message);
}
