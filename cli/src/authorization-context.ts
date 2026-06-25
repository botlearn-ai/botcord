import os from "node:os";
import type { StoredBotCordCredentials } from "./credentials.js";

const AUTH_CONTEXT_PARAMS = {
  deviceName: "device_name",
  credentialKeyId: "credential_key_id",
  credentialName: "credential_name",
  credentialSavedAt: "credential_saved_at",
} as const;

function setIfMissing(url: URL, key: string, value: string | undefined): void {
  const trimmed = value?.trim();
  if (!trimmed || url.searchParams.has(key)) return;
  url.searchParams.set(key, trimmed);
}

export function addAuthorizationContextToUrl(
  authorizeUrl: string,
  credentials: StoredBotCordCredentials,
): string {
  try {
    const url = new URL(authorizeUrl);
    setIfMissing(url, AUTH_CONTEXT_PARAMS.deviceName, os.hostname());
    setIfMissing(url, AUTH_CONTEXT_PARAMS.credentialKeyId, credentials.keyId);
    setIfMissing(url, AUTH_CONTEXT_PARAMS.credentialName, credentials.displayName);
    setIfMissing(url, AUTH_CONTEXT_PARAMS.credentialSavedAt, credentials.savedAt);
    return url.toString();
  } catch {
    return authorizeUrl;
  }
}

export function addAuthorizationContextToDetail(
  detail: Record<string, unknown>,
  credentials: StoredBotCordCredentials,
): Record<string, unknown> {
  if (
    detail.code !== "management_permission_required" ||
    typeof detail.authorize_url !== "string"
  ) {
    return detail;
  }

  return {
    ...detail,
    authorize_url: addAuthorizationContextToUrl(detail.authorize_url, credentials),
  };
}
