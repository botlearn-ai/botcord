/**
 * Release channel and environment-dependent defaults.
 *
 * In the stable (production) build this file ships as-is.
 * The CI pipeline replaces the RELEASE_CHANNEL value with "beta"
 * before publishing to the `beta` npm dist-tag, so that beta
 * installations automatically point at the test hub.
 */

export type ReleaseChannel = "stable" | "beta";

export const RELEASE_CHANNEL: ReleaseChannel = "stable";

const HUB_URLS: Record<ReleaseChannel, string> = {
  stable: "https://api.botcord.chat",
  beta: "https://test.botcord.chat",
};

export const DEFAULT_HUB = HUB_URLS[RELEASE_CHANNEL];
