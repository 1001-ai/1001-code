/**
 * Defaults for a build of this fork, which ships separately from upstream T3 Code: it sends no
 * product analytics to upstream and never offers, downloads, or installs upstream's releases.
 * Upstream's code reads these at the seams listed in fork/README.md.
 */

/** Shown wherever upstream would check for, offer, or install a T3 Code update. */
export const FORK_UPDATES_MESSAGE = "Updates for this build are managed separately.";

/** Shown where upstream would download a release archive from its public releases. */
export const FORK_RELEASE_DOWNLOAD_MESSAGE = `This build does not download T3 Code releases. ${FORK_UPDATES_MESSAGE}`;

/**
 * Upstream sends product analytics to its own ingest unless switched off. Here they are off, and
 * `T3CODE_TELEMETRY_ENABLED=true` only sends them to a host and project key the operator names.
 */
export const FORK_ANALYTICS_DEFAULTS = { enabled: false, host: "", key: "" } as const;

export function forkAnalyticsEnabled(config: {
  readonly enabled: boolean;
  readonly posthogHost: string;
  readonly posthogKey: string;
}): boolean {
  return config.enabled && config.posthogHost.trim() !== "" && config.posthogKey.trim() !== "";
}

/**
 * The release source a download may use: only one someone named, through
 * `T3CODE_RELEASE_BASE_URL` or a managed policy's mirror. Upstream falls back to its own releases.
 */
export function forkReleaseSource(named: string | null | undefined): string | undefined {
  const source = named?.trim();
  return source === undefined || source === "" ? undefined : source;
}

/**
 * The production desktop app's own identity, so it installs and runs beside upstream's T3 Code
 * without sharing its bundle id, data, port or links. Development keeps upstream's values.
 */
export const FORK_DESKTOP = {
  productName: "1001 Code",
  appId: "ai.1001.code",
  homeDirName: ".1001-code",
  userDataDirName: "1001-code",
  /** The backend always listens here; the app refuses to start when it is taken. */
  backendPort: 14774,
  /** OS URL scheme and renderer origin (`<scheme>://app`). */
  scheme: "code1001",
} as const;

/**
 * Backend settings a desktop build bakes in from its build environment, as defaults that a
 * variable set when the app starts still overrides.
 */
const FORK_BUILD_ENV_DEFAULT_NAMES = ["T3CODE_LINEAR_CLIENT_ID", "T3CODE_TEAM_CATALOG"] as const;

const nonEmpty = (value: string | undefined): value is string =>
  value !== undefined && value.trim() !== "";

/** The baked defaults the environment does not already set, limited to the names above. */
export function forkBuildEnvDefaults(
  baked: Readonly<Record<string, string | undefined>>,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return Object.fromEntries(
    FORK_BUILD_ENV_DEFAULT_NAMES.flatMap((name) => {
      const value = baked[name];
      return nonEmpty(value) && !nonEmpty(env[name]) ? [[name, value]] : [];
    }),
  );
}

/**
 * Variables a dev app hands the shells it starts. A desktop build that inherits them bakes dev
 * origins into the web bundle or, with `T3CODE_DESKTOP_DEV`, starts the dev Electron.
 */
const FORK_BUILD_DEV_ENV_NAMES = [
  "T3CODE_DESKTOP_DEV",
  "VITE_DEV_SERVER_URL",
  "VITE_HTTP_URL",
  "VITE_WS_URL",
] as const;

/** The dev app variables set in a build environment; a desktop build refuses to run with any. */
export function forkBuildDevEnvNames(env: Readonly<Record<string, string | undefined>>): string[] {
  return FORK_BUILD_DEV_ENV_NAMES.filter((name) => nonEmpty(env[name]));
}
