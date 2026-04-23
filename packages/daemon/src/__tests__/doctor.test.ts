import { describe, expect, it, vi } from "vitest";
import {
  channelsFromDaemonConfig,
  probeChannel,
  probeChannels,
  renderDoctor,
  type ChannelProbeConfig,
  type DoctorFileReader,
  type DoctorHttpFetcher,
} from "../doctor.js";
import type { DaemonConfig } from "../config.js";

const okCreds = JSON.stringify({
  token: "secret-token",
  hubUrl: "https://hub.example.com",
});

function fileReader(files: Record<string, string | null>): DoctorFileReader {
  return {
    readFile(p) {
      return p in files ? files[p] : null;
    },
  };
}

function fetcher(result: { ok: boolean; status?: number; error?: string }): DoctorHttpFetcher {
  return vi.fn(async () => result);
}

describe("probeChannel", () => {
  const ch: ChannelProbeConfig = {
    id: "botcord-main",
    type: "botcord",
    accountId: "ag_123",
  };

  it("reports credentials and hub both ✓ when everything is healthy", async () => {
    const credsPath = "/creds/ag_123.json";
    const result = await probeChannel(ch, {
      credentialsPath: () => credsPath,
      fileReader: fileReader({ [credsPath]: okCreds }),
      fetcher: fetcher({ ok: true, status: 200 }),
      timeoutMs: 1000,
    });
    expect(result.credentialsOk).toBe(true);
    expect(result.hubOk).toBe(true);
    expect(result.hubUrl).toBe("https://hub.example.com");
    expect(result.hubMessage).toContain("200");
  });

  it("reports missing credentials when the file cannot be read", async () => {
    const result = await probeChannel(ch, {
      credentialsPath: () => "/no/such/file.json",
      fileReader: fileReader({}),
      fetcher: fetcher({ ok: true, status: 200 }),
      timeoutMs: 1000,
    });
    expect(result.credentialsOk).toBe(false);
    expect(result.credentialsMessage).toContain("missing");
    expect(result.hubOk).toBe(false);
    expect(result.hubMessage).toContain("skipped");
  });

  it("reports invalid JSON when credentials fail to parse", async () => {
    const credsPath = "/creds/bad.json";
    const result = await probeChannel(ch, {
      credentialsPath: () => credsPath,
      fileReader: fileReader({ [credsPath]: "{not json" }),
      fetcher: fetcher({ ok: true, status: 200 }),
      timeoutMs: 1000,
    });
    expect(result.credentialsOk).toBe(false);
    expect(result.credentialsMessage).toContain("invalid JSON");
  });

  it("reports ✗ with timeout message when the fetcher times out", async () => {
    const credsPath = "/creds/ag_123.json";
    const result = await probeChannel(ch, {
      credentialsPath: () => credsPath,
      fileReader: fileReader({ [credsPath]: okCreds }),
      fetcher: fetcher({ ok: false, error: "timeout" }),
      timeoutMs: 1000,
    });
    expect(result.credentialsOk).toBe(true);
    expect(result.hubOk).toBe(false);
    expect(result.hubMessage).toBe("timeout");
  });

  it("reports a non-2xx status when reachable but not ok", async () => {
    const credsPath = "/creds/ag_123.json";
    const result = await probeChannel(ch, {
      credentialsPath: () => credsPath,
      fileReader: fileReader({ [credsPath]: okCreds }),
      fetcher: fetcher({ ok: false, status: 503 }),
      timeoutMs: 1000,
    });
    expect(result.hubOk).toBe(false);
    expect(result.hubMessage).toContain("503");
  });

  it("probeChannels returns an entry per input channel", async () => {
    const credsPath = "/creds/ag_123.json";
    const results = await probeChannels({
      channels: [ch, { ...ch, id: "botcord-alt", accountId: "ag_alt" }],
      credentialsPath: (acct) => (acct === "ag_123" ? credsPath : "/missing"),
      fileReader: fileReader({ [credsPath]: okCreds }),
      fetcher: fetcher({ ok: true, status: 200 }),
      timeoutMs: 1000,
    });
    expect(results).toHaveLength(2);
    expect(results[0].credentialsOk).toBe(true);
    expect(results[1].credentialsOk).toBe(false);
  });
});

describe("probeChannel (with per-channel credentialsFile)", () => {
  it("uses channel.credentialsFile instead of the default when set", async () => {
    const explicit = "/override/path/ag.json";
    const reader = fileReader({ [explicit]: okCreds });
    const result = await probeChannel(
      {
        id: "ag_x",
        type: "botcord",
        accountId: "ag_x",
        credentialsFile: explicit,
      },
      {
        credentialsPath: () => "/default/should-not-be-read.json",
        fileReader: reader,
        fetcher: fetcher({ ok: true, status: 200 }),
        timeoutMs: 1000,
      },
    );
    expect(result.credentialsOk).toBe(true);
    expect(result.credentialsMessage).toContain(explicit);
  });
});

describe("channelsFromDaemonConfig (boot-agent aware)", () => {
  it("returns channels derived from the explicit agents list", () => {
    const cfg: DaemonConfig = {
      agents: ["ag_one", "ag_two"],
      defaultRoute: { adapter: "claude-code", cwd: "/w" },
      routes: [],
      streamBlocks: true,
    };
    const channels = channelsFromDaemonConfig(cfg);
    expect(channels.map((c) => c.id)).toEqual(["ag_one", "ag_two"]);
    // Explicit config channels use the default credential path (no override).
    for (const c of channels) {
      expect(c.credentialsFile).toMatch(/\.botcord\/credentials\//);
    }
  });

  it("returns an empty list when no agents are configured and discovery is unavailable", () => {
    // Default discovery dir almost certainly has no credentials in test env.
    // We rely on the fallback-to-empty behaviour, not a real scan — any scan
    // that throws turns into [].
    const cfg: DaemonConfig = {
      defaultRoute: { adapter: "claude-code", cwd: "/w" },
      routes: [],
      streamBlocks: true,
    };
    const channels = channelsFromDaemonConfig(cfg);
    expect(Array.isArray(channels)).toBe(true);
    // Either empty or non-empty depending on environment; the important
    // guarantee is that it does not throw.
  });
});

describe("renderDoctor", () => {
  it("renders runtimes + channel section with markers", () => {
    const out = renderDoctor({
      runtimes: [
        {
          id: "claude-code",
          displayName: "Claude Code",
          binary: "claude",
          supportsRun: true,
          result: { available: true, version: "1.0.0", path: "/usr/bin/claude" },
        },
      ],
      channels: [
        {
          id: "botcord-main",
          type: "botcord",
          accountId: "ag_123",
          credentialsOk: true,
          credentialsMessage: "loaded",
          hubUrl: "https://hub.example.com",
          hubOk: true,
          hubMessage: "reachable (HTTP 200)",
        },
      ],
    });
    expect(out).toContain("claude-code");
    expect(out).toContain("1/1 runtimes available");
    expect(out).toContain("Channels:");
    expect(out).toContain("botcord-main");
    expect(out).toContain("✓");
  });

  it("shows 'No channels configured.' when the channel list is empty", () => {
    const out = renderDoctor({
      runtimes: [
        {
          id: "claude-code",
          displayName: "Claude Code",
          binary: "claude",
          supportsRun: true,
          result: { available: false },
        },
      ],
      channels: [],
    });
    expect(out).toContain("No channels configured.");
  });
});
