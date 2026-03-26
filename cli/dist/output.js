export function outputJson(data) {
    console.log(JSON.stringify(data, null, 2));
}
export function outputError(message) {
    console.error(JSON.stringify({ error: message }));
    process.exit(1);
}
