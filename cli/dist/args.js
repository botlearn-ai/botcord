export function parseArgs(argv) {
    const flags = {};
    const positionals = [];
    let i = 0;
    while (i < argv.length) {
        const arg = argv[i];
        if (arg === "--") {
            positionals.push(...argv.slice(i + 1));
            break;
        }
        if (arg.startsWith("--")) {
            const eqIdx = arg.indexOf("=");
            if (eqIdx !== -1) {
                flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
            }
            else {
                const next = argv[i + 1];
                if (next !== undefined && !next.startsWith("-")) {
                    flags[arg.slice(2)] = next;
                    i++;
                }
                else {
                    flags[arg.slice(2)] = true;
                }
            }
        }
        else if (arg === "-h") {
            flags["help"] = true;
        }
        else if (arg.startsWith("-") && arg.length === 2) {
            const next = argv[i + 1];
            if (next !== undefined && !next.startsWith("-")) {
                flags[arg.slice(1)] = next;
                i++;
            }
            else {
                flags[arg.slice(1)] = true;
            }
        }
        else {
            positionals.push(arg);
        }
        i++;
    }
    const command = positionals.shift() || "";
    let subcommand;
    if (positionals.length > 0 && !positionals[0].startsWith("-")) {
        subcommand = positionals.shift();
    }
    return { command, subcommand, positionals, flags };
}
