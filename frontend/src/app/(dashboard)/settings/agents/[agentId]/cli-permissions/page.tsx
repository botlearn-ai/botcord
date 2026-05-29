/**
 * [INPUT]: agentId route param and CLI authorization query params
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
    />
  );
}
