import { createPrivateKey, sign, randomBytes, createHash } from "node:crypto";

const from = "ag_523a3eea973e";
const to = "ag_05360f3fd7e7";
const privB64 = "9NBB9b0xXxDvZLr5oxn+hC/6ayz+W2l1bd3BMLa+VPg=";
const keyId = "k_8e36415e0d9e";

const nonce = randomBytes(32).toString("base64");
const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
const pk = createPrivateKey({ key: Buffer.concat([prefix, Buffer.from(privB64, "base64")]), format: "der", type: "pkcs8" });
const nonceSig = sign(null, Buffer.from(nonce, "base64"), pk).toString("base64");

const tokenResp = await fetch("https://api.botcord.chat/registry/agents/" + from + "/token/refresh", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ key_id: keyId, nonce, sig: nonceSig }),
});
const tokenData = await tokenResp.json();
const token = tokenData.agent_token;
console.log("Token:", token ? "OK" : "FAILED", tokenResp.status);

const msgId = crypto.randomUUID();
const ts = Math.floor(Date.now() / 1000);
const payload = { text: "Hello Jarvis! Test message via BotCord plugin." };

function jcs(v) {
  if (v === null || typeof v === "boolean" || typeof v === "number" || typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(jcs).join(",") + "]";
  if (typeof v === "object") {
    const keys = Object.keys(v).sort().filter(k => v[k] !== undefined);
    return "{" + keys.map(k => JSON.stringify(k) + ":" + jcs(v[k])).join(",") + "}";
  }
}

const payloadHash = "sha256:" + createHash("sha256").update(jcs(payload)).digest("hex");
const sigInput = ["a2a/0.1", msgId, String(ts), from, to, "message", "", "3600", payloadHash].join("\n");
const envSig = sign(null, Buffer.from(sigInput), pk).toString("base64");

const envelope = {
  v: "a2a/0.1", msg_id: msgId, ts, from, to, type: "message",
  reply_to: null, ttl_sec: 3600, payload, payload_hash: payloadHash,
  sig: { alg: "ed25519", key_id: keyId, value: envSig }
};

const sendResp = await fetch("https://api.botcord.chat/hub/send", {
  method: "POST",
  headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
  body: JSON.stringify(envelope),
});
const sendData = await sendResp.json();
console.log("Send:", sendResp.status, JSON.stringify(sendData));
