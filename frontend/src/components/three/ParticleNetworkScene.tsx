"use client";

import { Canvas } from "@react-three/fiber";
import ParticleNetwork from "./ParticleNetwork";

/**
 * [INPUT]: 依赖 @react-three/fiber Canvas 与 ParticleNetwork 作为场景内容
 * [OUTPUT]: 对外提供固定定位的首页 WebGL 背景场景
 * [POS]: 首页营销页背景容器，管理画布分辨率与渲染参数
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */
export default function ParticleNetworkScene() {
  return (
    <div className="fixed inset-0 -z-10">
      <Canvas
        camera={{ position: [0, 0, 5], fov: 60 }}
        dpr={[1, 1.25]}
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
