import { runScenario } from "./scenario-runner.js";
import type { RunReport } from "./types.js";

function parseArgs(argv: string[]): { scenario: string; env: string } {
  let scenario = "quickstart-install";
  let env = "test";

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--scenario" && argv[i + 1]) {
      scenario = argv[i + 1];
      i++;
    } else if (argv[i] === "--env" && argv[i + 1]) {
      env = argv[i + 1];
      i++;
    }
  }

  return { scenario, env };
}

function printReport(report: RunReport): void {
  console.log("\n" + "=".repeat(60));
  console.log("E2E RUN REPORT");
  console.log("=".repeat(60));
  console.log(`Run ID:      ${report.runId}`);
  console.log(`Scenario:    ${report.scenario}`);
  console.log(`Environment: ${report.environment}`);
  console.log(`Status:      ${report.status.toUpperCase()}`);
  console.log(`Duration:    ${timeDiff(report.startTime, report.endTime)}`);
  console.log("");

  for (const inst of report.instances) {
    console.log(`--- ${inst.id} [${inst.status.toUpperCase()}] ---`);
    for (const a of inst.assertions) {
      const icon = a.status === "passed" ? "\u2713" : a.status === "failed" ? "\u2717" : a.status === "skipped" ? "\u25CB" : "!";
      console.log(`  ${icon} ${a.id}: ${a.status}`);
      if (a.status === "failed" || a.status === "error") {
        console.log(`    expected: ${JSON.stringify(a.expected)}`);
        console.log(`    actual:   ${JSON.stringify(a.actual)}`);
        if (a.error) console.log(`    error:    ${a.error}`);
        if (a.evidence) console.log(`    evidence: ${a.evidence.slice(0, 200)}`);
      }
    }
    console.log("");
  }

  // Summary
  let totalPassed = 0;
  let totalFailed = 0;
  let totalSkipped = 0;
  let totalError = 0;
  for (const inst of report.instances) {
    for (const a of inst.assertions) {
      if (a.status === "passed") totalPassed++;
      else if (a.status === "failed") totalFailed++;
      else if (a.status === "skipped") totalSkipped++;
      else totalError++;
    }
  }
  const total = totalPassed + totalFailed + totalSkipped + totalError;
  console.log(`Total: ${total} assertions | ${totalPassed} passed | ${totalFailed} failed | ${totalSkipped} skipped | ${totalError} errors`);
  console.log("=".repeat(60));
}

function timeDiff(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  if (minutes > 0) return `${minutes}m ${remaining}s`;
  return `${seconds}s`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`BotCord E2E Verification Platform`);
  console.log(`Scenario: ${args.scenario}`);
  console.log(`Environment: ${args.env}`);

  try {
    const report = await runScenario(args.scenario, args.env);
    printReport(report);
    process.exit(report.status === "passed" ? 0 : 1);
  } catch (err) {
    console.error("\nFatal error:", err);
    process.exit(2);
  }
}

main();
