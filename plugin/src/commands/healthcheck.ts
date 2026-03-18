/**
 * /botcord_healthcheck — Plugin command for BotCord integration health check.
 *
 * Checks: plugin config, Hub connectivity, token validity, delivery mode status.
 */
import {
  getSingleAccountModeError,
  resolveAccountConfig,
  isAccountConfigured,
} from "../config.js";
import { BotCordClient } from "../client.js";
import { normalizeAndValidateHubUrl } from "../hub-url.js";
import { getConfig as getAppConfig } from "../runtime.js";

export function createHealthcheckCommand() {
  return {
    name: "botcord_healthcheck",
    description: "Check BotCord integration health: config, Hub connectivity, token, delivery mode.",
    acceptsArgs: false,
    requireAuth: true,
    handler: async () => {
      const lines: string[] = [];
      let pass = 0;
      let warn = 0;
      let fail = 0;

      const ok = (msg: string) => { lines.push(`[OK]   ${msg}`); pass++; };
      const warning = (msg: string) => { lines.push(`[WARN] ${msg}`); warn++; };
      const error = (msg: string) => { lines.push(`[FAIL] ${msg}`); fail++; };
      const info = (msg: string) => { lines.push(`[INFO] ${msg}`); };

      // ── 1. Plugin Configuration ──
      lines.push("", "── Plugin Configuration ──");

      const cfg = getAppConfig();
      if (!cfg) {
        error("No OpenClaw configuration available");
        return { text: lines.join("\n") };
      }
      const singleAccountError = getSingleAccountModeError(cfg);
      if (singleAccountError) {
        error(singleAccountError);
        return { text: lines.join("\n") };
      }

      const acct = resolveAccountConfig(cfg);

      if (!acct.hubUrl) {
        error("hubUrl is not configured");
      } else {
        try {
          const normalizedHubUrl = normalizeAndValidateHubUrl(acct.hubUrl);
          ok(`Hub URL: ${normalizedHubUrl}`);
          if (normalizedHubUrl.startsWith("http://")) {
            warning("Hub URL uses loopback HTTP; this is acceptable only for local development");
          }
        } catch (err: any) {
          error(err.message);
        }
      }

      if (acct.credentialsFile) {
        info(`Credentials file: ${acct.credentialsFile}`);
        if (!acct.privateKey) {
          error("credentialsFile is configured but could not be loaded");
        }
      }

      if (!acct.agentId) {
        error("agentId is not configured");
      } else {
        ok(`Agent ID: ${acct.agentId}`);
      }

      if (!acct.keyId) {
        error("keyId is not configured");
      } else {
        ok(`Key ID: ${acct.keyId}`);
      }

      if (!acct.privateKey) {
        error("privateKey is not configured");
      } else {
        ok("Private key: configured");
      }

      if (!isAccountConfigured(acct)) {
        error("Plugin is not fully configured — cannot proceed with connectivity checks");
        lines.push("", `── Summary ──`);
        lines.push(`Passed: ${pass}  |  Warnings: ${warn}  |  Failed: ${fail}`);
        return { text: lines.join("\n") };
      }

      // ── 2. Hub Connectivity & Token ──
      lines.push("", "── Hub Connectivity ──");

      let client: BotCordClient;
      try {
        client = new BotCordClient(acct);
      } catch (err: any) {
        error(err.message);
        lines.push("", `── Summary ──`);
        lines.push(`Passed: ${pass}  |  Warnings: ${warn}  |  Failed: ${fail}`);
        return { text: lines.join("\n") };
      }

      try {
        await client.ensureToken();
        ok("Token refresh successful — Hub is reachable and credentials are valid");
      } catch (err: any) {
        error(`Token refresh failed: ${err.message}`);
        lines.push("", `── Summary ──`);
        lines.push(`Passed: ${pass}  |  Warnings: ${warn}  |  Failed: ${fail}`);
        return { text: lines.join("\n") };
      }

      // ── 3. Agent Resolution ──
      lines.push("", "── Agent Identity ──");

      try {
        const resolved = await client.resolve(client.getAgentId());
        if (resolved && typeof resolved === "object") {
          const r = resolved as Record<string, unknown>;
          ok(`Agent resolved: ${r.display_name || r.agent_id}`);
          if (r.bio) info(`Bio: ${r.bio}`);
          if (Array.isArray(r.endpoints) && r.endpoints.length > 0) {
            info(`Registered endpoints on Hub: ${r.endpoints.length}`);
          }
        }
      } catch (err: any) {
        error(`Agent resolution failed: ${err.message}`);
      }

      // ── 4. Delivery Mode ──
      lines.push("", "── Delivery Mode ──");

      const mode = acct.deliveryMode || "websocket";
      ok(`Delivery mode: ${mode}`);

      if (mode === "polling") {
        info(`Poll interval: ${acct.pollIntervalMs || 5000}ms`);
      }

      // ── Summary ──
      lines.push("", "── Summary ──");
      const total = pass + warn + fail;
      lines.push(`Passed: ${pass}  |  Warnings: ${warn}  |  Failed: ${fail}  |  Total: ${total}`);

      if (fail > 0) {
        lines.push("", "Some checks FAILED. Please fix the issues above.");
      } else if (warn > 0) {
        lines.push("", "All critical checks passed, but there are warnings to review.");
      } else {
        lines.push("", "All checks passed. BotCord is ready!");
      }

      return { text: lines.join("\n") };
    },
  };
}
