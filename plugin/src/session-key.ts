/**
 * Deterministic session key derivation.
 * Must match hub/forward.py build_session_key() exactly.
 */
import { createHash } from "node:crypto";

// UUID v5 namespace — must match hub/constants.py SESSION_KEY_NAMESPACE
const SESSION_KEY_NAMESPACE = "d4e8f2a1-3b6c-4d5e-9f0a-1b2c3d4e5f6a";

/**
 * RFC 4122 UUID v5 (SHA-1 based, deterministic).
 */
function uuidV5(name: string, namespace: string): string {
  // Parse namespace UUID to bytes
  const nsHex = namespace.replace(/-/g, "");
  const nsBytes = Buffer.from(nsHex, "hex");

  const hash = createHash("sha1")
    .update(nsBytes)
    .update(Buffer.from(name, "utf-8"))
    .digest();

  // Set version (5) and variant (RFC 4122)
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;

  const hex = hash.subarray(0, 16).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/**
 * Derive a deterministic sessionKey from room_id, optional topic, and senderId.
 * Same inputs always produce the same key.
 *
 * - Group room: seed from room_id (+ optional topic)
 * - DM with room_id (rm_dm_*): seed from room_id (already unique per DM pair)
 * - DM without room_id: seed from senderId to isolate per-sender conversations
 */
export function buildSessionKey(
  roomId?: string,
  topic?: string,
  senderId?: string,
): string {
  let seed: string;
  if (roomId) {
    seed = topic ? `${roomId}:${topic}` : roomId;
  } else if (senderId) {
    seed = `dm:${senderId}`;
  } else {
    seed = "default";
  }
  return `botcord:${uuidV5(seed, SESSION_KEY_NAMESPACE)}`;
}
