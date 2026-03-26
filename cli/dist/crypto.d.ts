import type { BotCordMessageEnvelope, MessageType } from "./types.js";
export declare function jcsCanonicalize(value: unknown): string | undefined;
export declare function computePayloadHash(payload: Record<string, unknown>): string;
export declare function signChallenge(privateKeyB64: string, challengeB64: string): string;
export declare function derivePublicKey(privateKeyB64: string): string;
export declare function buildSignedEnvelope(params: {
    from: string;
    to: string;
    type: MessageType;
    payload: Record<string, unknown>;
    privateKey: string;
    keyId: string;
    replyTo?: string | null;
    ttlSec?: number;
    topic?: string | null;
    goal?: string | null;
}): BotCordMessageEnvelope;
export declare function generateKeypair(): {
    privateKey: string;
    publicKey: string;
    pubkeyFormatted: string;
};
