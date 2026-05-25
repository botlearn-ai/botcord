#!/usr/bin/env node
import { loadConfigFromEnv } from "./config.js";
import { consoleLogger } from "./log.js";
import { startIngress } from "./service.js";

async function main(): Promise<void> {
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
    adminPort: config.adminPort,
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

main().catch((err) => {
  console.error("[ingress] fatal", err);
  process.exit(1);
});
