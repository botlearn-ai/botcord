"use client";

import { useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { useLanguage } from "@/lib/i18n";
import { deliveryFlow } from "@/lib/i18n/translations/protocol";

export default function DeliveryFlow() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const locale = useLanguage();
  const t = deliveryFlow[locale];

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

    const w = () => canvas.getBoundingClientRect().width;
    const h = () => canvas.getBoundingClientRect().height;

    let time = 0;
    let animId: number;

    const draw = () => {
      const cw = w();
      const ch = h();
      ctx.clearRect(0, 0, cw, ch);

      const cy = ch / 2;
      const nodeR = 20;
      const nodes = [
        { x: cw * 0.15, y: cy, label: t.alice, color: "#00f0ff" },
        { x: cw * 0.5, y: cy, label: t.hub, color: "#8b5cf6" },
        { x: cw * 0.85, y: cy, label: t.bob, color: "#10b981" },
      ];

      // Draw connection lines
      ctx.strokeStyle = "rgba(255,255,255,0.05)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(nodes[0].x + nodeR, cy);
      ctx.lineTo(nodes[1].x - nodeR, cy);
      ctx.moveTo(nodes[1].x + nodeR, cy);
      ctx.lineTo(nodes[2].x - nodeR, cy);
      ctx.stroke();
      ctx.setLineDash([]);

      // Draw nodes
      nodes.forEach((node) => {
        ctx.beginPath();
        ctx.arc(node.x, node.y, nodeR, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(10,10,15,0.8)";
        ctx.fill();
        ctx.strokeStyle = node.color;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Glow
        ctx.shadowColor = node.color;
        ctx.shadowBlur = 15;
        ctx.beginPath();
        ctx.arc(node.x, node.y, nodeR, 0, Math.PI * 2);
        ctx.strokeStyle = node.color + "40";
        ctx.stroke();
        ctx.shadowBlur = 0;

        // Label
        ctx.fillStyle = node.color;
        ctx.font = "11px Inter, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(node.label, node.x, node.y + nodeR + 18);
      });

      if (prefersReduced) {
        // Static scene — draw once, no animation loop
        return;
      }

      // Animated pulse: message traveling Alice → Hub → Bob
      const cycle = time % 3;
      let px: number;
      let py: number = cy;

      if (cycle < 1) {
        // Alice → Hub
        px =
          nodes[0].x + nodeR + (nodes[1].x - nodeR - nodes[0].x - nodeR) * cycle;
      } else if (cycle < 2) {
        // Hub processing (pulse at hub)
        const progress = cycle - 1;
        px = nodes[1].x;
        ctx.beginPath();
        ctx.arc(px, py, nodeR + 8 * Math.sin(progress * Math.PI), 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(139,92,246,${0.3 * Math.sin(progress * Math.PI)})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      } else {
        // Hub → Bob
        const progress = cycle - 2;
        px =
          nodes[1].x + nodeR + (nodes[2].x - nodeR - nodes[1].x - nodeR) * progress;
      }

      // Draw message dot
      ctx.beginPath();
      ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.fillStyle = "#00f0ff";
      ctx.shadowColor = "#00f0ff";
      ctx.shadowBlur = 12;
      ctx.fill();
      ctx.shadowBlur = 0;

      time += 0.008;
      animId = requestAnimationFrame(draw);
    };

    draw();

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("resize", resize);
    };
  }, [t]);

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
        className="h-40 w-full"
        style={{ display: "block" }}
      />
    </motion.div>
  );
}
