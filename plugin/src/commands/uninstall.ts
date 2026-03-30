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
          const { execSync } = await import("node:child_process");
          const { homedir } = await import("node:os");

          const home = homedir();
          const credDir = join(home, ".botcord", "credentials");

          // Build profile flags to forward to openclaw CLI
          const profileFlags: string[] = [];
          if (options.dev) profileFlags.push("--dev");
          else if (options.profile) profileFlags.push("--profile", options.profile);
          const pfx = profileFlags.length > 0 ? ` ${profileFlags.join(" ")}` : "";

          // Resolve extension dir from openclaw CLI if possible, else default
          let extensionDir = join(home, ".openclaw", "extensions", "botcord");
          try {
            const configFile = execSync(`openclaw${pfx} config file`, { stdio: "pipe", encoding: "utf8" }).trim();
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
            execSync(`openclaw${pfx} plugins disable botcord`, { stdio: "pipe" });
            ctx.logger.info("  Plugin disabled");
          } catch {
            ctx.logger.warn("  Plugin was not enabled (or already disabled)");
          }

          // Step 2: Remove channel config via OpenClaw CLI if available
          if (!options.keepChannel) {
            ctx.logger.info("Removing channel configuration ...");
            try {
              // Use openclaw config unset to safely remove the channel entry
              execSync(`openclaw${pfx} config unset channels.botcord`, { stdio: "pipe" });
              ctx.logger.info("  Channel config removed");
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
