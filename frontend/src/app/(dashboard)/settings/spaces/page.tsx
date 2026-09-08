import { Suspense } from "react";
import TeamSpacesPage from "@/components/team/TeamSpacesPage";

export default function SpacesPage() {
  return (
    <Suspense fallback={<p role="status">Loading…</p>}>
      <TeamSpacesPage />
    </Suspense>
  );
}
