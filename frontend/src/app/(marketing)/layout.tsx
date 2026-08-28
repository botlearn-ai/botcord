import Navbar from "@/components/layout/Navbar";
import Footer from "@/components/layout/Footer";

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      {/* Light-mode only: gives the marketing pages the depth the dark theme
          gets from the particle mesh. Sits under the hero scene (-z-10). */}
      <div className="marketing-canvas pointer-events-none fixed inset-0 -z-20" aria-hidden="true" />
      <Navbar />
      <main>{children}</main>
      <Footer />
    </>
  );
}
