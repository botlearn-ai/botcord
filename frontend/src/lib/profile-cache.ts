/** Profiles that disappeared or are no longer authorized must not stay actionable from cache. */
export function isProfileUnavailable(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("status" in error)) return false;
  return [401, 403, 404, 410].includes(Number(error.status));
}

/** A bounded, memory-only cache. Each owner scope gets independent requests and data. */
export function createProfileCache<T>(fetchProfile: (id: string) => Promise<T>, limit = 40) {
  let owner: string | null = null;
  let generation = 0;
  const values = new Map<string, T>();
  const pending = new Map<string, Promise<T>>();
  const clear = () => {
    generation += 1;
    values.clear();
    pending.clear();
  };
  const enter = (scope: string) => {
    if (scope !== owner) {
      clear();
      owner = scope;
    }
  };
  return {
    clear,
    get(scope: string, id: string) {
      enter(scope);
      return values.get(id);
    },
    load(scope: string, id: string): Promise<T> {
      enter(scope);
      const existing = pending.get(id);
      if (existing) return existing;
      const epoch = generation;
      const request = fetchProfile(id).then((profile) => {
        if (generation === epoch && owner === scope) {
          values.delete(id);
          values.set(id, profile);
          if (values.size > limit) values.delete(values.keys().next().value!);
        }
        return profile;
      }).catch((error: unknown) => {
        if (generation === epoch && owner === scope && isProfileUnavailable(error)) values.delete(id);
        throw error;
      }).finally(() => {
        if (pending.get(id) === request) pending.delete(id);
      });
      pending.set(id, request);
      return request;
    },
  };
}
