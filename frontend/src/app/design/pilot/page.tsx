import { notFound } from "next/navigation";
import type { Metadata } from "next";
import PilotGallery from "./PilotGallery";
export const metadata: Metadata = { title: "BotCord UI · Migration pilot", robots: { index: false, follow: false } };
export default function PilotPage() {
  if (process.env.NODE_ENV !== "development" && process.env.VERCEL_ENV !== "preview") notFound();
  return <PilotGallery />;
}
