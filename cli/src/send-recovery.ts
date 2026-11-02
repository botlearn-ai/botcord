import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

interface Attempt<A> {
  messageId: string;
  prepared: A;
  recoveredAt?: number;
  result?: unknown;
}

/** Retain ambiguous sends across CLI invocations; never guess that timeout means rejection. */
export async function recoverableSend<A>(options: {
  directory: string;
  key: string;
  messageId?: string;
  prepare: () => Promise<A>;
  send: (messageId: string, prepared: A) => Promise<unknown>;
  status: (messageId: string) => Promise<unknown>;
}): Promise<unknown> {
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  const file = path.join(options.directory, `${options.key}.json`);
  const lock = `${file}.lock`;
  let fd: number;
  try { fd = openSync(lock, "wx", 0o600); }
  catch (error: any) {
    if (error.code === "EEXIST") throw new Error("An identical send is already in progress. Do not send a new copy; retry after it finishes. If its process crashed, inspect the send-attempt lock before recovery.");
    throw error;
  }
  closeSync(fd);
  try {
    let attempt: Attempt<A> | undefined = existsSync(file)
      ? JSON.parse(readFileSync(file, "utf8")) : undefined;
    const save = () => {
      const temp = `${file}.${randomUUID()}.tmp`;
      writeFileSync(temp, JSON.stringify(attempt), { mode: 0o600 });
      renameSync(temp, file);
    };
    const recover = async (): Promise<unknown | undefined> => {
      try {
        const status: any = await options.status(attempt!.messageId);
        if (status?.msg_id !== attempt!.messageId || typeof status.state !== "string") {
          throw new Error("Invalid delivery status response");
        }
        const result = { queued: true, msg_id: attempt!.messageId, status: status.state, recovered: true };
        attempt!.recoveredAt = Date.now();
        attempt!.result = result;
        save();
        return result;
      } catch (error: any) {
        if (error.status === 404) return undefined;
        throw new Error(`Delivery remains unknown for message ${attempt!.messageId}. Retry the same command or query botcord status; do not send a new copy.`);
      }
    };
    if (attempt?.recoveredAt) {
      // Suppress repeated timeout-retry loops, without suppressing ordinary future messages.
      if (Date.now() - attempt.recoveredAt < 15 * 60_000) return attempt.result;
      unlinkSync(file);
      attempt = undefined;
    }
    if (attempt) {
      const recovered = await recover();
      if (recovered) return recovered;
    } else {
      attempt = { messageId: options.messageId ?? randomUUID(), prepared: await options.prepare() };
      save();
    }
    try {
      const result = await options.send(attempt.messageId, attempt.prepared);
      unlinkSync(file);
      return result;
    } catch (error: any) {
      if (typeof error.status === "number" && error.status < 500) throw error;
      const recovered = await recover();
      if (recovered) return recovered;
      throw new Error(`Send outcome unknown for message ${attempt.messageId}. The attempt is saved; retry the identical command to reuse its message ID and attachments.`);
    }
  } finally {
    unlinkSync(lock);
  }
}
