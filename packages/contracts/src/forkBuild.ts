/**
 * Defaults for a build of this fork, which ships separately from upstream T3 Code: it sends no
 * product analytics to upstream, never offers, downloads, or installs upstream's releases, and
 * never links to upstream's hosted app.
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
 * Where copied thread and prompt links point. Upstream falls back to its own hosted app; here a
 * link goes through the hosted app the build names, else the web origin serving the client. The
 * desktop and mobile apps have no web origin, so they get no web link.
 */
export function forkShareLinkOrigin(
  hostedAppUrl: string | undefined,
  servedFrom: string | undefined,
): string | undefined {
  if (hostedAppUrl) return hostedAppUrl;
  if (servedFrom === undefined || !URL.canParse(servedFrom)) return undefined;
  const url = new URL(servedFrom);
  return url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined;
}
