"use client";

import { Canvas } from "@react-three/fiber";
import ParticleNetwork from "./ParticleNetwork";

export default function ParticleNetworkScene() {
  return (
    <div className="fixed inset-0 -z-10">
      <Canvas
        camera={{ position: [0, 0, 5], fov: 60 }}
        dpr={[1, 1.5]}
        gl={{
          antialias: false,
          alpha: true,
          powerPreference: "high-performance",
        }}
        style={{ background: "transparent" }}
      >
        <ParticleNetwork />
      </Canvas>
    </div>
  );
}
