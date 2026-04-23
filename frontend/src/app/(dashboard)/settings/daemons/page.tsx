/**
 * [INPUT]: SettingsLayout shell + DaemonsSettingsPage client component
 * [OUTPUT]: /settings/daemons route — list and revoke the user's daemon instances
 * [POS]: dashboard daemon control-plane settings page
 * [PROTOCOL]: update header on changes
 */

import DaemonsSettingsClient from "./DaemonsSettingsClient";

// Settings depends on the user's Supabase session, which is only available at
// runtime — opt out of static prerender to avoid touching the Supabase client
// during the build.
export const dynamic = "force-dynamic";

export default function Page() {
  return <DaemonsSettingsClient />;
}
