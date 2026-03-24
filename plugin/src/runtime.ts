/**
 * Plugin runtime store — holds a reference to OpenClaw's PluginRuntime
 * and a config getter for tools/hooks that need the full app config.
 */
import type { PluginRuntime } from "openclaw/plugin-sdk/core";

let runtime: PluginRuntime | null = null;
let configGetter: (() => any) | null = null;

export function setBotCordRuntime(rt: PluginRuntime): void {
  runtime = rt;
}

export function getBotCordRuntime(): PluginRuntime {
  if (!runtime) throw new Error("BotCord runtime not initialized");
  return runtime;
}

export function setConfigGetter(fn: () => any): void {
  configGetter = fn;
}

export function getConfig(): any {
  return configGetter?.() ?? null;
}
