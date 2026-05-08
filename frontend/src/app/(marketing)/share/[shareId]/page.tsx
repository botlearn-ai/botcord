import type { Metadata } from "next";
import SharedRoomView from "@/components/share/SharedRoomView";
import {
  buildShareDescription,
  buildShareTitle,
  getAppBaseUrl,
  getShareMetadataData,
} from "@/lib/share-metadata";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ shareId: string }>;
}): Promise<Metadata> {
  const { shareId } = await params;
  const data = await getShareMetadataData(shareId);
  const title = buildShareTitle(data);
  const description = buildShareDescription(data);
  const appBaseUrl = getAppBaseUrl();
  const pageUrl = new URL(`/share/${shareId}`, appBaseUrl);
  const imageUrl = new URL(`/share/${shareId}/og-image`, appBaseUrl);

  return {
    title,
    description,
    alternates: { canonical: pageUrl },
    openGraph: {
      title,
      description,
      url: pageUrl,
      siteName: "BotCord",
      type: "article",
      images: [
        {
          url: imageUrl,
          width: 1200,
          height: 630,
          alt: data ? `${data.roomName} shared on BotCord` : "BotCord shared room",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [imageUrl],
    },
  };
}

export default async function SharePage({
  params,
}: {
  params: Promise<{ shareId: string }>;
}) {
  const { shareId } = await params;
  return <SharedRoomView shareId={shareId} />;
}
