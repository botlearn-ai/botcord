/**
 * [INPUT]: SettingsLayout shell + PolicySettingsClient client component
 * [OUTPUT]: /settings/policy route — global per-agent admission/attention policy form
 * [POS]: dashboard "对话与回复" settings page
 * [PROTOCOL]: update header on changes
 */

import PolicySettingsClient from "./PolicySettingsClient";

export const dynamic = "force-dynamic";

export default function Page() {
  return <PolicySettingsClient />;
}
