/**
 * Phase 1.6 architecture spike — NON-PRODUCTION reference code.
 * The render projection boundary: worker mesh payload → Three.js GPU buffers →
 * R3F scene, in deterministic demand-mode rendering (fixed camera, fixed
 * lights, no antialias, preserveDrawingBuffer for screenshots).
 * See docs/architecture/spike-findings.md.
 */

import { Canvas, invalidate, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { CadMeshPayload } from "./protocol";

const CAMERA_POSITION: readonly [number, number, number] = [46, 34, 48];
const LIGHT_A_POSITION: readonly [number, number, number] = [60, 80, 40];
const LIGHT_B_POSITION: readonly [number, number, number] = [-50, -20, -60];

function CadModel({ mesh }: { mesh: CadMeshPayload }) {
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const interleaved = new THREE.InterleavedBuffer(
      mesh.positions,
      mesh.numProp,
    );
    g.setAttribute(
      "position",
      new THREE.InterleavedBufferAttribute(interleaved, 3, 0),
    );
    if (mesh.numProp >= 6) {
      // Kernel-computed solid-frame normals (Manifold.calculateNormals):
      // exact per-face normals with sharp edges split, so planar faces shade
      // flat and creases stay crisp — never averaged across edges.
      g.setAttribute(
        "normal",
        new THREE.InterleavedBufferAttribute(interleaved, 3, 3),
      );
    } else {
      g.computeVertexNormals();
    }
    g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    return g;
  }, [mesh]);
  useEffect(() => {
    return () => {
      geometry.dispose();
    };
  }, [geometry]);
  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial color="#8aadf4" metalness={0.15} roughness={0.55} />
    </mesh>
  );
}

/**
 * Renders exactly one demand frame per applied result, then stamps the
 * rendered volume onto the page root so tests can prove that the pixels on
 * screen belong to the geometry the numbers describe.
 */
function SettleProbe({ volume }: { volume: number }) {
  const stampedVolume = useRef<number | undefined>(undefined);
  useFrame(() => {
    if (stampedVolume.current === volume) {
      return;
    }
    stampedVolume.current = volume;
    document
      .getElementById("spike-root")
      ?.setAttribute("data-cad-rendered-volume", volume.toFixed(3));
  });
  useEffect(() => {
    invalidate();
  }, [volume]);
  return null;
}

export function CadScene({
  mesh,
  volume,
}: {
  mesh: CadMeshPayload;
  volume: number;
}) {
  return (
    <Canvas
      frameloop="demand"
      dpr={1}
      gl={{ antialias: false, preserveDrawingBuffer: true }}
      camera={{ position: CAMERA_POSITION, fov: 40 }}
    >
      <ambientLight intensity={1.2} />
      <directionalLight position={LIGHT_A_POSITION} intensity={2.0} />
      <directionalLight position={LIGHT_B_POSITION} intensity={0.6} />
      <CadModel mesh={mesh} />
      <SettleProbe volume={volume} />
    </Canvas>
  );
}
