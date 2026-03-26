export interface StoredBotCordCredentials {
    version: 1;
    hubUrl: string;
    agentId: string;
    keyId: string;
    privateKey: string;
    publicKey: string;
    displayName?: string;
    savedAt: string;
    token?: string;
    tokenExpiresAt?: number;
}
export declare function resolveCredentialsFilePath(credentialsFile: string): string;
export declare function defaultCredentialsFile(agentId: string): string;
export declare function loadStoredCredentials(credentialsFile: string): StoredBotCordCredentials;
export declare function writeCredentialsFile(credentialsFile: string, credentials: StoredBotCordCredentials): string;
export declare function loadDefaultCredentials(agentId?: string): StoredBotCordCredentials;
export declare function setDefaultAgent(agentId: string): void;
