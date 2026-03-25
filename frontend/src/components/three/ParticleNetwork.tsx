"use client";

import { useRef, useMemo, useEffect } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

/**
 * [INPUT]: 依赖 @react-three/fiber 的 useFrame/useThree 与 three 的 BufferGeometry 能力
 * [OUTPUT]: 对外提供 ParticleNetwork 背景网络粒子组件
 * [POS]: 首页 GL 背景主动画层，负责粒子、连线与脉冲的低成本渲染
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */
const PARTICLE_COUNT = 110;
const CONNECTION_DISTANCE = 2.5;
const PULSE_COUNT = 14;
const CONNECTION_UPDATE_INTERVAL = 1 / 30;
const CELL_BIAS = 64;

function packCellKey(x: number, y: number, z: number) {
  return (x + CELL_BIAS) | ((y + CELL_BIAS) << 8) | ((z + CELL_BIAS) << 16);
}

function isMobile() {
  return typeof window !== "undefined" && window.innerWidth < 768;
}

export default function ParticleNetwork() {
  const pointsRef = useRef<THREE.Points>(null);
  const linesRef = useRef<THREE.LineSegments>(null);
  const pulsesRef = useRef<THREE.Points>(null);
  const mousePos = useRef(new THREE.Vector2(0, 0));
  const connectionTickRef = useRef(0);
  const hiddenRef = useRef(false);
  const { size } = useThree();

  const count = useMemo(
    () => (isMobile() ? Math.floor(PARTICLE_COUNT * 0.55) : PARTICLE_COUNT),
    []
  );
  const pulseCount = useMemo(
    () => (isMobile() ? Math.floor(PULSE_COUNT * 0.5) : PULSE_COUNT),
    []
  );

  const particles = useMemo(() => {
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 8;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 6;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 4;
      velocities[i * 3] = (Math.random() - 0.5) * 0.003;
      velocities[i * 3 + 1] = (Math.random() - 0.5) * 0.003;
      velocities[i * 3 + 2] = (Math.random() - 0.5) * 0.002;
    }
    return { positions, velocities };
  }, [count]);

  const pulseData = useMemo(() => {
    const positions = new Float32Array(pulseCount * 3);
    const progress = new Float32Array(pulseCount);
    const edges = new Int32Array(pulseCount * 2);
    for (let i = 0; i < pulseCount; i++) {
      progress[i] = Math.random();
      edges[i * 2] = Math.floor(Math.random() * count);
      edges[i * 2 + 1] = Math.floor(Math.random() * count);
    }
    return { positions, progress, edges };
  }, [pulseCount, count]);

  const maxConnections = (count * (count - 1)) / 2;
  const linePositions = useMemo(
    () => new Float32Array(maxConnections * 6),
    [maxConnections]
  );
  const lineColors = useMemo(
    () => new Float32Array(maxConnections * 6),
    [maxConnections]
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      mousePos.current.x = (e.clientX / size.width) * 2 - 1;
      mousePos.current.y = -(e.clientY / size.height) * 2 + 1;
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => window.removeEventListener("mousemove", onMove);
  }, [size]);

  useEffect(() => {
    const onVisibilityChange = () => {
      hiddenRef.current = document.hidden;
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    onVisibilityChange();
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  useFrame((_, delta) => {
    if (!pointsRef.current) return;
    if (hiddenRef.current) return;

    const pos = particles.positions;
    const vel = particles.velocities;

    // Update particle positions
    for (let i = 0; i < count; i++) {
      const ix = i * 3;
      pos[ix] += vel[ix];
      pos[ix + 1] += vel[ix + 1];
      pos[ix + 2] += vel[ix + 2];

      // Mouse attraction
      const dx = mousePos.current.x * 4 - pos[ix];
      const dy = mousePos.current.y * 3 - pos[ix + 1];
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 3) {
        const force = 0.0003 / (dist + 0.1);
        pos[ix] += dx * force;
        pos[ix + 1] += dy * force;
      }

      // Boundary wrap
      if (pos[ix] > 5) pos[ix] = -5;
      if (pos[ix] < -5) pos[ix] = 5;
      if (pos[ix + 1] > 4) pos[ix + 1] = -4;
      if (pos[ix + 1] < -4) pos[ix + 1] = 4;
      if (pos[ix + 2] > 3) pos[ix + 2] = -3;
      if (pos[ix + 2] < -3) pos[ix + 2] = 3;
    }

    (
      pointsRef.current.geometry.attributes.position as THREE.BufferAttribute
    ).needsUpdate = true;

    // Update connections
    if (linesRef.current) {
      connectionTickRef.current += delta;
      if (connectionTickRef.current >= CONNECTION_UPDATE_INTERVAL) {
        connectionTickRef.current = 0;
        const maxDistanceSq = CONNECTION_DISTANCE * CONNECTION_DISTANCE;
        const invCellSize = 1 / CONNECTION_DISTANCE;
        const grid = new Map<number, number[]>();
        let lineIdx = 0;

        for (let i = 0; i < count; i++) {
          const ix = i * 3;
          const cx = Math.floor(pos[ix] * invCellSize);
          const cy = Math.floor(pos[ix + 1] * invCellSize);
          const cz = Math.floor(pos[ix + 2] * invCellSize);
          const key = packCellKey(cx, cy, cz);
          const bucket = grid.get(key);
          if (bucket) {
            bucket.push(i);
            continue;
          }
          grid.set(key, [i]);
        }

        for (let i = 0; i < count; i++) {
          const ix = i * 3;
          const px = pos[ix];
          const py = pos[ix + 1];
          const pz = pos[ix + 2];
          const cx = Math.floor(px * invCellSize);
          const cy = Math.floor(py * invCellSize);
          const cz = Math.floor(pz * invCellSize);

          for (let ox = -1; ox <= 1; ox++) {
            for (let oy = -1; oy <= 1; oy++) {
              for (let oz = -1; oz <= 1; oz++) {
                const key = packCellKey(cx + ox, cy + oy, cz + oz);
                const bucket = grid.get(key);
                if (!bucket) continue;

                for (let bi = 0; bi < bucket.length; bi++) {
                  const j = bucket[bi];
                  if (j <= i) continue;

                  const jx = j * 3;
                  const dx = px - pos[jx];
                  const dy = py - pos[jx + 1];
                  const dz = pz - pos[jx + 2];
                  const dSq = dx * dx + dy * dy + dz * dz;
                  if (dSq > maxDistanceSq) continue;

                  const alpha = 1 - dSq / maxDistanceSq;
                  const li = lineIdx * 6;

                  linePositions[li] = px;
                  linePositions[li + 1] = py;
                  linePositions[li + 2] = pz;
                  linePositions[li + 3] = pos[jx];
                  linePositions[li + 4] = pos[jx + 1];
                  linePositions[li + 5] = pos[jx + 2];

                  const a = alpha * 0.12;
                  lineColors[li] = 0;
                  lineColors[li + 1] = 0.72 * a;
                  lineColors[li + 2] = 0.78 * a;
                  lineColors[li + 3] = 0;
                  lineColors[li + 4] = 0.72 * a;
                  lineColors[li + 5] = 0.78 * a;
                  lineIdx++;
                }
              }
            }
          }
        }

        const lineGeo = linesRef.current.geometry;
        (lineGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
        (lineGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
        lineGeo.setDrawRange(0, lineIdx * 2);
      }
    }

    // Update pulses
    if (pulsesRef.current) {
      const pp = pulseData.positions;
      const prog = pulseData.progress;
      const edges = pulseData.edges;

      for (let i = 0; i < pulseCount; i++) {
        prog[i] += delta * 0.5;
        if (prog[i] > 1) {
          prog[i] = 0;
          edges[i * 2] = Math.floor(Math.random() * count);
          edges[i * 2 + 1] = Math.floor(Math.random() * count);
        }

        const a = edges[i * 2];
        const b = edges[i * 2 + 1];
        const t = prog[i];

        pp[i * 3] = pos[a * 3] + (pos[b * 3] - pos[a * 3]) * t;
        pp[i * 3 + 1] =
          pos[a * 3 + 1] + (pos[b * 3 + 1] - pos[a * 3 + 1]) * t;
        pp[i * 3 + 2] =
          pos[a * 3 + 2] + (pos[b * 3 + 2] - pos[a * 3 + 2]) * t;
      }

      (
        pulsesRef.current.geometry.attributes.position as THREE.BufferAttribute
      ).needsUpdate = true;
    }

    // Slow rotation
    if (pointsRef.current.parent) {
      pointsRef.current.parent.rotation.y += delta * 0.02;
    }
  });

  return (
    <group>
      {/* Particle nodes */}
      <points ref={pointsRef}>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            args={[particles.positions, 3]}
          />
        </bufferGeometry>
        <pointsMaterial
          size={0.04}
          color="#6aaeb5"
          transparent
          opacity={0.42}
          sizeAttenuation
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </points>

      {/* Connection lines */}
      <lineSegments ref={linesRef}>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            args={[linePositions, 3]}
          />
          <bufferAttribute
            attach="attributes-color"
            args={[lineColors, 3]}
          />
        </bufferGeometry>
        <lineBasicMaterial
          vertexColors
          transparent
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </lineSegments>

      {/* Pulse particles */}
      <points ref={pulsesRef}>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            args={[pulseData.positions, 3]}
          />
        </bufferGeometry>
        <pointsMaterial
          size={0.06}
          color="#7ebbc2"
          transparent
          opacity={0.45}
          sizeAttenuation
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </points>
    </group>
  );
}
