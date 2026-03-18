"use client";

import { useRef, useMemo, useEffect } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

const PARTICLE_COUNT = 150;
const CONNECTION_DISTANCE = 2.5;
const PULSE_COUNT = 20;

function isMobile() {
  return typeof window !== "undefined" && window.innerWidth < 768;
}

export default function ParticleNetwork() {
  const pointsRef = useRef<THREE.Points>(null);
  const linesRef = useRef<THREE.LineSegments>(null);
  const pulsesRef = useRef<THREE.Points>(null);
  const mousePos = useRef(new THREE.Vector2(0, 0));
  const { size } = useThree();

  const count = useMemo(
    () => (isMobile() ? Math.floor(PARTICLE_COUNT * 0.5) : PARTICLE_COUNT),
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
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, [size]);

  useFrame((_, delta) => {
    if (!pointsRef.current) return;

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
      let lineIdx = 0;
      for (let i = 0; i < count; i++) {
        for (let j = i + 1; j < count; j++) {
          const dx = pos[i * 3] - pos[j * 3];
          const dy = pos[i * 3 + 1] - pos[j * 3 + 1];
          const dz = pos[i * 3 + 2] - pos[j * 3 + 2];
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);

          if (d < CONNECTION_DISTANCE) {
            const alpha = 1 - d / CONNECTION_DISTANCE;
            const li = lineIdx * 6;

            linePositions[li] = pos[i * 3];
            linePositions[li + 1] = pos[i * 3 + 1];
            linePositions[li + 2] = pos[i * 3 + 2];
            linePositions[li + 3] = pos[j * 3];
            linePositions[li + 4] = pos[j * 3 + 1];
            linePositions[li + 5] = pos[j * 3 + 2];

            const a = alpha * 0.3;
            lineColors[li] = 0;
            lineColors[li + 1] = 0.94 * a;
            lineColors[li + 2] = 1 * a;
            lineColors[li + 3] = 0;
            lineColors[li + 4] = 0.94 * a;
            lineColors[li + 5] = 1 * a;

            lineIdx++;
          }
        }
      }

      // Zero out remaining
      for (let i = lineIdx * 6; i < linePositions.length; i++) {
        linePositions[i] = 0;
        lineColors[i] = 0;
      }

      const lineGeo = linesRef.current.geometry;
      (lineGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (lineGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
      lineGeo.setDrawRange(0, lineIdx * 2);
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
          color="#00f0ff"
          transparent
          opacity={0.8}
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
          color="#00f0ff"
          transparent
          opacity={0.9}
          sizeAttenuation
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </points>
    </group>
  );
}
