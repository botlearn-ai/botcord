/**
 * [OUTPUT]: /desktop/install route — Suspense wrapper for DesktopInstallClient
 * [POS]: browser leg of the Desktop DMG auth flow
 * [PROTOCOL]: update when desktop deep-link params change
 */

import { Suspense } from "react";
import { Loader2 } from "lucide-react";
import DesktopInstallClient from "./DesktopInstallClient";

function Loading() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-deep-black px-4 text-text-primary">
      <Loader2 className="h-6 w-6 animate-spin text-neon-cyan" />
    </main>
  );
}

export default function DesktopInstallPage() {
  return (
    <Suspense fallback={<Loading />}>
      <DesktopInstallClient />
    </Suspense>
  );
}
