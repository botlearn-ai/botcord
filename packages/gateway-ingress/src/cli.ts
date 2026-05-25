#!/usr/bin/env node
import { runMigrateCli } from "./cli/migrate-from-daemon.js";
import { loadConfigFromEnv } from "./config.js";
import { consoleLogger } from "./log.js";
import { startIngress } from "./service.js";

const TOP_LEVEL_HELP = `botcord-gateway-ingress

Commands:
  start       Run the ingress service (default).
  migrate     One-shot import of daemon-side third-party gateway secrets
              + config into the ingress store. See 'migrate --help'.
  -h, --help  Show this message.
`;

async function startCommand(): Promise<void> {
  const config = loadConfigFromEnv();
  if (!config.ingressSecret) {
    console.error(
      "[ingress] BOTCORD_INGRESS_SECRET is required (matching Hub's CLOUD_GATEWAY_INGRESS_SECRET)",
    );
    process.exit(2);
  }
  consoleLogger.info("ingress booting", {
    hubUrl: config.hubUrl,
    dataDir: config.dataDir,
    healthPort: config.healthPort,
  });
  const service = await startIngress({ config });

  const shutdown = async (signal: string) => {
    consoleLogger.info("ingress shutting down", { signal });
    try {
      await service.shutdown(signal);
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

async function main(): Promise<void> {
  const [, , maybeCmd, ...rest] = process.argv;
  if (maybeCmd === "migrate") {
    const code = await runMigrateCli(rest);
    process.exit(code);
  }
  if (maybeCmd === "-h" || maybeCmd === "--help") {
    console.log(TOP_LEVEL_HELP);
    process.exit(0);
  }
  // Default + explicit "start" behavior preserved for backward compat with
  // existing systemd unit files / Docker entrypoints.
  await startCommand();
}

main().catch((err) => {
  console.error("[ingress] fatal", err);
  process.exit(1);
});
