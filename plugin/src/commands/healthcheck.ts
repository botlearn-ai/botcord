/**
 * /botcord_healthcheck — Plugin command for BotCord integration health check.
 *
 * Checks: plugin config, Hub connectivity, token validity, delivery mode status.
 */
import {
  getSingleAccountModeError,
  resolveAccountConfig,
  resolveChannelConfig,
  resolveAccounts,
  isAccountConfigured,
} from "../config.js";
import { BotCordClient } from "../client.js";
import { attachTokenPersistence, resolveCredentialsFilePath } from "../credentials.js";
import { normalizeAndValidateHubUrl } from "../hub-url.js";
import { getConfig as getAppConfig } from "../runtime.js";
import { getWsStatus } from "../ws-client.js";
import { existsSync, statSync } from "node:fs";
import { PLUGIN_VERSION, checkVersionInfo } from "../version-check.js";
import { isOnboarded, markOnboarded } from "../credentials.js";

export function createHealthcheckCommand() {
  return {
    name: "botcord_healthcheck",
    description: "Check BotCord integration health: config, Hub connectivity, token, delivery mode.",
    acceptsArgs: false,
    requireAuth: true,
    handler: async (_ctx: any) => {
      const lines: string[] = [];
      let pass = 0;
      let warn = 0;
      let fail = 0;

      const ok = (msg: string) => { lines.push(`[OK]   ${msg}`); pass++; };
      const warning = (msg: string) => { lines.push(`[WARN] ${msg}`); warn++; };
      const error = (msg: string) => { lines.push(`[FAIL] ${msg}`); fail++; };
      const info = (msg: string) => { lines.push(`[INFO] ${msg}`); };

      // ── 0. Plugin Version ──
      lines.push("", "── Plugin Version ──");
      info(`@botcord/botcord v${PLUGIN_VERSION}`);

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

      // ── 1b. Credentials File ──
      lines.push("", "── Credentials File ──");

      const credFile = acct.credentialsFile
        ? resolveCredentialsFilePath(acct.credentialsFile)
        : undefined;

      if (!credFile) {
        info("No credentials file configured (using inline config)");
      } else if (!existsSync(credFile)) {
        warning(`Credentials file not found: ${credFile}`);
      } else {
        ok(`Credentials file exists: ${credFile}`);
        if (!acct.privateKey) {
          error("Credentials file exists but could not be loaded");
        }
        if (process.platform !== "win32") {
          try {
            const st = statSync(credFile);
            const mode = st.mode & 0o777;
            if ((mode & 0o077) === 0) {
              ok(`Credentials file permissions: 0${mode.toString(8)}`);
            } else {
              warning(`Credentials file permissions: 0${mode.toString(8)} (group/other bits set — should be owner-only)`);
            }
          } catch (err: any) {
            warning(`Could not check file permissions: ${err.message}`);
          }
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
        attachTokenPersistence(client, acct);
      } catch (err: any) {
        error(err.message);
        lines.push("", `── Summary ──`);
        lines.push(`Passed: ${pass}  |  Warnings: ${warn}  |  Failed: ${fail}`);
        return { text: lines.join("\n") };
      }

      try {
        await client.ensureToken();
        ok("Token refresh successful — Hub is reachable and credentials are valid");

        const expiresAt = client.getTokenExpiresAt();
        if (expiresAt > 0) {
          const remainingSec = expiresAt - Date.now() / 1000;
          const remainingHrs = Math.floor(remainingSec / 3600);
          const remainingMin = Math.floor((remainingSec % 3600) / 60);
          if (remainingSec <= 0) {
            warning("Token has already expired — will be refreshed on next request");
          } else if (remainingSec < 3600) {
            warning(`Token expires in ${remainingMin}m — consider refreshing soon`);
          } else {
            ok(`Token expires in ${remainingHrs}h ${remainingMin}m`);
          }
        }
      } catch (err: any) {
        error(`Token refresh failed: ${err.message}`);
        lines.push("", `── Summary ──`);
        lines.push(`Passed: ${pass}  |  Warnings: ${warn}  |  Failed: ${fail}`);
        return { text: lines.join("\n") };
      }

      // ── 2b. Version Negotiation ──
      lines.push("", "── Version Negotiation ──");
      const versionInfo = client.getLastVersionInfo();
      if (versionInfo) {
        info(`Hub latest: ${versionInfo.latest_plugin_version ?? "unknown"}, min: ${versionInfo.min_plugin_version ?? "unknown"}`);
        const status = checkVersionInfo(versionInfo);
        if (status === "incompatible") {
          error(`Plugin ${PLUGIN_VERSION} is below minimum ${versionInfo.min_plugin_version} — update required`);
        } else if (status === "update_available") {
          warning(`New version ${versionInfo.latest_plugin_version} available (current: ${PLUGIN_VERSION})`);
        } else {
          ok(`Plugin ${PLUGIN_VERSION} is up to date`);
        }
      } else {
        info("Hub did not return version info");
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

      if (mode === "websocket") {
        const channelCfg = resolveChannelConfig(cfg);
        const accounts = resolveAccounts(channelCfg);
        const wsAccountId = Object.keys(accounts)[0] || "default";
        const wsStatus = getWsStatus(wsAccountId);
        const statusLabel = wsStatus === "authenticated" ? "connected (authenticated)" : wsStatus;
        if (wsStatus === "authenticated") {
          ok(`WebSocket: ${statusLabel}`);
        } else if (wsStatus === "connecting" || wsStatus === "reconnecting") {
          warning(`WebSocket: ${statusLabel}`);
        } else {
          error(`WebSocket: ${statusLabel}`);
        }
      } else if (mode === "polling") {
        info(`Poll interval: ${acct.pollIntervalMs || 5000}ms`);
      }

      // ── 5. Notify Session ──
      lines.push("", "── Notify Session ──");

      const ns = acct.notifySession;
      if (!ns || (Array.isArray(ns) && ns.length === 0)) {
        warning("notifySession is not configured — contact requests and system notifications will not be forwarded to any owner channel");
      } else {
        const sessions = Array.isArray(ns) ? ns : [ns];
        ok(`Notify session(s): ${sessions.join(", ")}`);
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

      // Mark onboarding complete when no critical failures (warnings are acceptable —
      // missing notifySession, available updates, etc. are non-blocking for onboarding)
      if (fail === 0 && acct.credentialsFile) {
        if (!isOnboarded(acct.credentialsFile)) {
          if (markOnboarded(acct.credentialsFile)) {
            lines.push("", "Onboarding complete — welcome to BotCord!");
          }
        }
      }

      return { text: lines.join("\n") };
    },
  };
}
