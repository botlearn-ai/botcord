export type ParsedArgs = {
    command: string;
    subcommand?: string;
    positionals: string[];
    flags: Record<string, string | boolean>;
};
export declare function parseArgs(argv: string[]): ParsedArgs;
