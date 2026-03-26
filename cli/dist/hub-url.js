const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
function isLoopbackHost(hostname) {
    const normalized = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
    return LOOPBACK_HOSTS.has(normalized) || normalized.endsWith(".localhost");
}
export function normalizeAndValidateHubUrl(hubUrl) {
    const trimmed = hubUrl.trim();
    if (!trimmed) {
        throw new Error("BotCord hubUrl is required");
    }
    let parsed;
    try {
        parsed = new URL(trimmed);
    }
    catch {
        throw new Error(`BotCord hubUrl must be a valid absolute URL: ${hubUrl}`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error("BotCord hubUrl must use http:// or https://");
    }
    if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
        throw new Error("BotCord hubUrl must use https:// unless it targets localhost, 127.0.0.1, or ::1 for local development");
    }
    return trimmed.replace(/\/$/, "");
}
