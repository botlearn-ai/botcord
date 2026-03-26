export function outputJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

export function outputError(message: string): never {
  console.error(JSON.stringify({ error: message }));
  process.exit(1);
}
