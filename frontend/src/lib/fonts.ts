import { Geist, Geist_Mono } from "next/font/google";

// VI v1.0: Geist for Latin UI and display text, Geist Mono for IDs and code.
// CJK falls back to the system stack defined in the VI tokens.
export const geistSans = Geist({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

export const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});
