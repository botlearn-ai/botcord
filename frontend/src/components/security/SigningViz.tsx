import { useEffect, useRef } from "react";
import { motion } from "framer-motion";

export default function SigningViz() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const prefersReduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);
    };
    resize();
    window.addEventListener("resize", resize);

    let t = 0;
    let animId: number;

    const draw = () => {
      const cw = canvas.getBoundingClientRect().width;
      const ch = canvas.getBoundingClientRect().height;
      ctx.clearRect(0, 0, cw, ch);

      const panelW = cw / 3 - 20;
      const panelH = ch - 40;
      const cy = ch / 2;

      const panels = [
        { x: 10, label: "Message", sublabel: "Plain body", color: "#00f0ff" },
        {
          x: cw / 3 + 5,
          label: "Sign",
          sublabel: "Ed25519 + JCS",
          color: "#8b5cf6",
        },
        {
          x: (cw * 2) / 3 + 5,
          label: "Envelope",
          sublabel: "Signed output",
          color: "#10b981",
        },
      ];

      panels.forEach((panel, i) => {
        // Panel box
        ctx.strokeStyle = panel.color + "40";
        ctx.lineWidth = 1;
        ctx.strokeRect(panel.x, 20, panelW, panelH);

        // Panel fill
        ctx.fillStyle = panel.color + "08";
        ctx.fillRect(panel.x, 20, panelW, panelH);

        // Label
        ctx.fillStyle = panel.color;
        ctx.font = "bold 13px Inter, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(panel.label, panel.x + panelW / 2, cy - 8);

        ctx.fillStyle = panel.color + "80";
        ctx.font = "10px Inter, sans-serif";
        ctx.fillText(panel.sublabel, panel.x + panelW / 2, cy + 10);

        // Arrow between panels
        if (i < 2) {
          const ax = panel.x + panelW + 2;
          const bx = panels[i + 1].x - 2;

          ctx.strokeStyle = "rgba(255,255,255,0.15)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(ax, cy);
          ctx.lineTo(bx, cy);
          ctx.stroke();

          // Arrowhead
          ctx.beginPath();
          ctx.moveTo(bx, cy);
          ctx.lineTo(bx - 6, cy - 3);
          ctx.lineTo(bx - 6, cy + 3);
          ctx.closePath();
          ctx.fillStyle = "rgba(255,255,255,0.15)";
          ctx.fill();

          if (!prefersReduced) {
            // Animated dot
            const cycle = (t * 0.5 + i * 0.5) % 1;
            const px = ax + (bx - ax) * cycle;
            ctx.beginPath();
            ctx.arc(px, cy, 3, 0, Math.PI * 2);
            ctx.fillStyle = panels[i + 1].color;
            ctx.shadowColor = panels[i + 1].color;
            ctx.shadowBlur = 8;
            ctx.fill();
            ctx.shadowBlur = 0;
          }
        }
      });

      if (!prefersReduced) {
        t += 0.005;
        animId = requestAnimationFrame(draw);
      }
    };

    draw();

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.6 }}
      className="rounded-xl border border-glass-border bg-glass-bg p-4 backdrop-blur-xl"
    >
      <canvas
        ref={canvasRef}
        className="h-32 w-full md:h-40"
        style={{ display: "block" }}
      />
    </motion.div>
  );
}
