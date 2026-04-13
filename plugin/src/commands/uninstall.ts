/**
 * CLI: `openclaw botcord-uninstall`
 *
 * Safe uninstall that uses OpenClaw's plugin API instead of editing JSON directly.
 * Prevents the common failure mode where AI agents corrupt openclaw.json.
 */

export function createUninstallCli() {
  return {
    setup: (ctx: any) => {
      ctx.program
        .command("botcord-uninstall")
        .description("Safely uninstall the BotCord plugin")
        .option("--purge", "Also delete credentials from ~/.botcord/", false)
        .option("--keep-channel", "Keep channel config in openclaw.json", false)
        .option("--profile <name>", "OpenClaw profile to target")
        .option("--dev", "Target the dev profile")
        .action(async (options: { purge?: boolean; keepChannel?: boolean; profile?: string; dev?: boolean }) => {
          const { existsSync, rmSync, readdirSync } = await import("node:fs");
          const { join } = await import("node:path");
          const { spawnSync } = await import("node:child_process");
          const { homedir } = await import("node:os");

          const home = homedir();
          const credDir = join(home, ".botcord", "credentials");

          // Build profile args to forward to openclaw CLI (as array, never shell-interpolated)
          const profileArgs: string[] = [];
          if (options.dev) profileArgs.push("--dev");
          else if (options.profile) {
            // Validate profile name to prevent injection via spawn args
            if (!/^[a-zA-Z0-9._-]+$/.test(options.profile)) {
              ctx.logger.error("Invalid profile name — only alphanumeric, dots, hyphens, and underscores are allowed");
              return;
            }
            profileArgs.push("--profile", options.profile);
          }

          // Helper: run openclaw CLI safely via spawnSync (no shell interpolation)
          const oc = (cmdArgs: string[]) =>
            spawnSync("openclaw", [...profileArgs, ...cmdArgs], { stdio: "pipe", encoding: "utf8" });

          // Resolve extension dir from openclaw CLI if possible, else default
          let extensionDir = join(home, ".openclaw", "extensions", "botcord");
          try {
            const result = oc(["config", "file"]);
            const configFile = (result.stdout || "").trim();
            if (configFile) {
              const configDir = join(configFile, "..");
              extensionDir = join(configDir, "extensions", "botcord");
            }
          } catch {
            // fall back to default path
          }

          // Step 1: Disable plugin via OpenClaw CLI (safe — no JSON editing)
          ctx.logger.info("Disabling BotCord plugin ...");
          try {
            const result = oc(["plugins", "disable", "botcord"]);
            if (result.status === 0) {
              ctx.logger.info("  Plugin disabled");
            } else {
              ctx.logger.warn("  Plugin was not enabled (or already disabled)");
            }
          } catch {
            ctx.logger.warn("  Plugin was not enabled (or already disabled)");
          }

          // Step 2: Remove channel config via OpenClaw CLI if available
          if (!options.keepChannel) {
            ctx.logger.info("Removing channel configuration ...");
            try {
              const result = oc(["config", "unset", "channels.botcord"]);
              if (result.status === 0) {
                ctx.logger.info("  Channel config removed");
              } else {
                ctx.logger.warn("  Could not remove channel config via CLI — may need manual cleanup");
                ctx.logger.warn("  If needed, remove 'channels.botcord' from openclaw.json");
              }
            } catch {
              ctx.logger.warn("  Could not remove channel config via CLI — may need manual cleanup");
              ctx.logger.warn("  If needed, remove 'channels.botcord' from openclaw.json");
            }
          } else {
            ctx.logger.info("Keeping channel configuration (--keep-channel)");
          }

          // Step 3: Remove plugin files
          if (existsSync(extensionDir)) {
            ctx.logger.info(`Removing plugin files from ${extensionDir} ...`);
            rmSync(extensionDir, { recursive: true, force: true });
            ctx.logger.info("  Plugin files removed");
          } else {
            ctx.logger.info("  No plugin files found (already removed)");
          }

          // Step 4: Optionally purge credentials
          if (options.purge) {
            if (existsSync(credDir)) {
              const files = readdirSync(credDir).filter((f: string) => f.endsWith(".json"));
              if (files.length > 0) {
                ctx.logger.info(`Deleting ${files.length} credential file(s) from ${credDir} ...`);
                for (const f of files) {
                  rmSync(join(credDir, f), { force: true });
                  ctx.logger.info(`  Deleted ${f}`);
                }
              }
            } else {
              ctx.logger.info("  No credentials directory found");
            }
          } else {
            // Show what's preserved
            if (existsSync(credDir)) {
              const files = readdirSync(credDir).filter((f: string) => f.endsWith(".json"));
              if (files.length > 0) {
                ctx.logger.info(`Credentials preserved in ${credDir} (${files.length} file(s))`);
                ctx.logger.info("  Use --purge to also delete credentials");
              }
            }
          }

          ctx.logger.info("");
          ctx.logger.info("BotCord plugin uninstalled.");
          ctx.logger.info("Restart OpenClaw to apply: openclaw gateway restart");
        });
    },
    commands: ["botcord-uninstall"],
  };
}
