/**
 * [INPUT]: agentId route param, CLI authorization query params, optional credential context
 * [OUTPUT]: /settings/agents/[agentId]/cli-permissions approval page
 * [POS]: dashboard entry point for owner-approved CLI management grants
 * [PROTOCOL]: update header on changes
 */

import CliPermissionsClient from "./CliPermissionsClient";

export const dynamic = "force-dynamic";

type PageSearchParams = Record<string, string | string[] | undefined>;

function paramValues(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function firstParam(value: string | string[] | undefined): string | null {
  return paramValues(value)[0] ?? null;
}

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ agentId: string }>;
  searchParams: Promise<PageSearchParams>;
}) {
  const [{ agentId }, query] = await Promise.all([params, searchParams]);

  return (
    <CliPermissionsClient
      agentId={agentId}
      scopeParams={paramValues(query.scopes)}
      daemonInstanceId={firstParam(query.daemon_instance_id)}
      requestContext={{
        deviceName: firstParam(query.device_name) ?? firstParam(query.device),
        credentialKeyId: firstParam(query.credential_key_id) ?? firstParam(query.key_id),
        credentialName: firstParam(query.credential_name) ?? firstParam(query.credential_label),
        credentialSavedAt: firstParam(query.credential_saved_at),
      }}
    />
  );
}
