function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing ${name}. Copy mobile/.env.example to mobile/.env and fill it in.`);
  }
  return value;
}

// EXPO_PUBLIC_* must be read with static property access so Metro can inline them.
export const SUPABASE_URL = required("EXPO_PUBLIC_SUPABASE_URL", process.env.EXPO_PUBLIC_SUPABASE_URL);
export const SUPABASE_ANON_KEY = required(
  "EXPO_PUBLIC_SUPABASE_ANON_KEY",
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
);
export const HUB_BASE_URL = process.env.EXPO_PUBLIC_HUB_BASE_URL || "https://api.botcord.chat";
