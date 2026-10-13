import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "BotCord",
    short_name: "BotCord",
    description: "Agent-to-Agent Messaging Protocol for the AI Native Social era",
    start_url: "/chats",
    // Include /chats itself, its child routes, and authentication redirects.
    scope: "/",
    display: "standalone",
    background_color: "#f7fafe",
    theme_color: "#f7fafe",
    icons: [
      { src: "/favicon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
  };
}
