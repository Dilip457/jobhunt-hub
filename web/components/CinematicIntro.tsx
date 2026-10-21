"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { getRole } from "@/lib/roles";
import type { RoleSlug } from "@/lib/types";
import { prefetchRole } from "@/lib/prefetch";
import { ArrowRightIcon, PlayIcon, SparkIcon } from "./Icons";
import RoleDestinations from "./RoleDestinations";
import StaticIntro from "./StaticIntro";

type Phase = "loading" | "greeting" | "reveal" | "approach" | "selecting" | "departing" | "transition";

const SEEN_KEY = "jobhunt-intro-seen";
const MODEL_URL = "/models/student/student.glb";

const SELECTOR_Z = -3.4;
const WALK_SPEED = 1.5;
const WALK_CYCLE_DISTANCE = 1.8;
const TRAVEL_RAMP = 0.4;
const GREETING_MS = 1900;
const REVEAL_SECONDS = 2.9;

const GATE_POSITIONS: Record<RoleSlug, THREE.Vector3> = {
  genai: new THREE.Vector3(-3.45, 0, -9.0),
  data: new THREE.Vector3(0, 0, -9.65),
  uiux: new THREE.Vector3(3.45, 0, -9.0),
};

const GATE_COLORS: Record<RoleSlug, number> = {
  genai: 0xff304f,
  data: 0x287bff,
  uiux: 0xffffff,
};

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

function smoothstep(value: number): number {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
}

function easeInOutCubic(value: number): number {
  return value < 0.5 ? 4 * value * value * value : 1 - Math.pow(-2 * value + 2, 3) / 2;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpAngle(a: number, b: number, t: number): number {
  const delta = ((((b - a + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI;
  return a + delta * t;
}

function dampAngle(current: number, target: number, dt: number, lambda: number): number {
  return lerpAngle(current, target, 1 - Math.exp(-lambda * dt));
}

function travelDuration(distance: number): number {
  return distance / WALK_SPEED + TRAVEL_RAMP;
}

function travelProfile(elapsed: number, distance: number) {
  const total = travelDuration(distance);
  const t = clamp(elapsed, 0, total);
  let covered = 0;
  let speed = 0;
  if (t < TRAVEL_RAMP) {
    const a = WALK_SPEED / TRAVEL_RAMP;
    covered = 0.5 * a * t * t;
    speed = a * t;
  } else if (t < total - TRAVEL_RAMP) {
    covered = WALK_SPEED * (t - TRAVEL_RAMP / 2);
    speed = WALK_SPEED;
  } else {
    const remaining = total - t;
    const a = WALK_SPEED / TRAVEL_RAMP;
    covered = distance - 0.5 * a * remaining * remaining;
    speed = a * remaining;
  }
  return { covered: clamp(covered, 0, distance), speed, total, done: t >= total - 0.001 };
}

function roundedRectShape(width: number, height: number, radius: number): THREE.Shape {
  const shape = new THREE.Shape();
  const x = -width / 2;
  const y = -height / 2;
  const r = Math.min(radius, width / 2, height / 2);
  shape.moveTo(x + r, y);
  shape.lineTo(x + width - r, y);
  shape.absarc(x + width - r, y + r, r, -Math.PI / 2, 0);
  shape.lineTo(x + width, y + height - r);
  shape.absarc(x + width - r, y + height - r, r, 0, Math.PI / 2);
  shape.lineTo(x + r, y + height);
  shape.absarc(x + r, y + height - r, r, Math.PI / 2, Math.PI);
  shape.lineTo(x, y + r);
  shape.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
  return shape;
}

function frameGeometry(width: number, height: number, radius: number, thickness: number, depth: number) {
  const outer = roundedRectShape(width, height, radius);
  outer.holes.push(roundedRectShape(width - thickness * 2, height - thickness * 2, Math.max(0.08, radius - thickness)));
  return new THREE.ExtrudeGeometry(outer, { depth, bevelEnabled: false, curveSegments: 10 });
}

function createGlasses(): THREE.Group {
  const group = new THREE.Group();
  group.name = "student-glasses";
  const frameMaterial = new THREE.MeshStandardMaterial({
    color: 0x05060a,
    roughness: 0.3,
    metalness: 0.58,
  });
  const lensMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x83b8ff,
    transparent: true,
    opacity: 0.055,
    roughness: 0.04,
    metalness: 0.08,
    side: THREE.DoubleSide,
    depthWrite: false,
  });

  for (const x of [-2.35, 2.35]) {
    const frame = new THREE.Mesh(frameGeometry(4.6, 2.9, 1.25, 0.22, 0.17), frameMaterial);
    frame.position.set(x, 8.85, 9.8);
    frame.renderOrder = 3;
    group.add(frame);
    const lens = new THREE.Mesh(new THREE.ShapeGeometry(roundedRectShape(4.16, 2.46, 1.08), 12), lensMaterial);
    lens.position.set(x, 8.85, 9.82);
    lens.renderOrder = 2;
    group.add(lens);
  }

  const bridge = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.24, 0.22), frameMaterial);
  bridge.position.set(0, 8.98, 9.8);
  group.add(bridge);

  for (const side of [-1, 1]) {
    const temple = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.19, 8.2), frameMaterial);
    temple.position.set(side * 4.65, 8.85, 5.8);
    temple.rotation.x = 0.04;
    group.add(temple);
    const ear = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.33, 0.2), frameMaterial);
    ear.position.set(side * 4.65, 8.65, 1.9);
    group.add(ear);
  }

  return group;
}

function createIdleClip(root: THREE.Object3D, walkClip: THREE.AnimationClip): THREE.AnimationClip {
  const sampleMixer = new THREE.AnimationMixer(root);
  const sampleAction = sampleMixer.clipAction(walkClip);
  sampleAction.play();
  sampleMixer.setTime(0);

  const frames = [
    { time: 0, breath: 0, sway: 0 },
    { time: 1.6, breath: 1, sway: 1 },
    { time: 3.2, breath: 0, sway: 0 },
  ];
  const tracks: THREE.KeyframeTrack[] = [];
  const breathAxis = new THREE.Euler();
  const breathQuat = new THREE.Quaternion();

  root.traverse((object) => {
    const bone = object as THREE.Bone;
    if (!bone.isBone) return;
    const base = bone.quaternion.clone();
    const values: number[] = [];
    for (const frame of frames) {
      const q = base.clone();
      if (bone.name === "Spine01" || bone.name === "Spine02" || bone.name === "Spine") {
        breathAxis.set(frame.breath * 0.012, frame.sway * 0.003, 0);
        breathQuat.setFromEuler(breathAxis);
        q.multiply(breathQuat);
      } else if (bone.name === "neck" || bone.name === "Head") {
        breathAxis.set(frame.sway * 0.004, frame.sway * 0.012, 0);
        breathQuat.setFromEuler(breathAxis);
        q.multiply(breathQuat);
      }
      values.push(q.x, q.y, q.z, q.w);
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, [0, 1.6, 3.2], values));
  });

  const hips = root.getObjectByName("Hips");
  if (hips) {
    const base = hips.position.clone();
    tracks.push(
      new THREE.VectorKeyframeTrack(
        "Hips.position",
        [0, 1.6, 3.2],
        [base.x, base.y, base.z, base.x, base.y + 0.002, base.z, base.x, base.y, base.z],
      ),
    );
  }

  sampleAction.stop();
  sampleMixer.uncacheRoot(root);
  return new THREE.AnimationClip("student-idle", 3.2, tracks);
}

interface SceneController {
  setPhase: (phase: Phase, jump?: boolean) => void;
  jumpToSelecting: () => void;
  walkTo: (role: RoleSlug) => void;
}

interface Gate {
  role: RoleSlug;
  group: THREE.Group;
  strips: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>[];
  ring: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  shards: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>[];
  light: THREE.PointLight;
  glow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
}

interface Props {
  onComplete?: (role: RoleSlug) => void;
}

export default function CinematicIntro({ onComplete }: Props) {
  const router = useRouter();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<SceneController | null>(null);
  const phaseRef = useRef<Phase>("loading");
  const timersRef = useRef<number[]>([]);
  const completeRef = useRef(false);

  const [reduced] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });
  const [seen] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(SEEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [phase, setPhase] = useState<Phase>(seen ? "selecting" : "loading");
  const [selected, setSelected] = useState<RoleSlug | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  const clearTimers = useCallback(() => {
    timersRef.current.forEach((timer) => window.clearTimeout(timer));
    timersRef.current = [];
  }, []);

  const schedule = useCallback((delay: number, callback: () => void) => {
    const timer = window.setTimeout(callback, delay);
    timersRef.current.push(timer);
  }, []);

  useEffect(() => {
    phaseRef.current = phase;
    controllerRef.current?.setPhase(phase);
  }, [phase]);

  useEffect(() => clearTimers, [clearTimers]);

  const markSeen = useCallback(() => {
    try {
      window.localStorage.setItem(SEEN_KEY, "1");
    } catch {
      // localStorage can be unavailable in private modes.
    }
  }, []);

  const complete = useCallback(
    (role: RoleSlug) => {
      if (completeRef.current) return;
      completeRef.current = true;
      markSeen();
      void prefetchRole(role);
      if (onComplete) onComplete(role);
      else router.push(`/jobs/${role}`);
    },
    [markSeen, onComplete, router],
  );

  const skipToRoles = useCallback(() => {
    clearTimers();
    markSeen();
    setPhase("selecting");
    controllerRef.current?.jumpToSelecting();
  }, [clearTimers, markSeen]);

  const skipJourney = useCallback(() => {
    if (selected) {
      clearTimers();
      complete(selected);
      return;
    }
    skipToRoles();
  }, [clearTimers, complete, selected, skipToRoles]);

  const handleSceneReady = useCallback(() => {
    setReady(true);
    if (phaseRef.current === "selecting") {
      controllerRef.current?.setPhase("selecting", true);
      return;
    }
    if (reduced) return;

    setPhase("greeting");
    schedule(GREETING_MS, () => {
      setPhase("reveal");
    });
    const approachSeconds = travelDuration(Math.abs(SELECTOR_Z)) + 0.95;
    schedule(GREETING_MS + REVEAL_SECONDS * 1000, () => {
      setPhase("approach");
    });
    schedule(GREETING_MS + REVEAL_SECONDS * 1000 + approachSeconds * 1000, () => {
      setPhase("selecting");
    });
  }, [reduced, schedule]);

  // If the model/WebGL takes too long, fall back to the accessible static intro.
  useEffect(() => {
    if (reduced || failed || ready) return;
    const timer = window.setTimeout(() => {
      if (!ready) setFailed(true);
    }, 12000);
    return () => window.clearTimeout(timer);
  }, [failed, ready, reduced]);

  useEffect(() => {
    if (reduced || failed) return;
    let disposed = false;
    let raf = 0;
    let renderer: THREE.WebGLRenderer | null = null;
    let pmrem: THREE.PMREMGenerator | null = null;
    let envTarget: THREE.WebGLRenderTarget | null = null;
    let scene: THREE.Scene | null = null;
    let cleanupListeners = () => undefined;

    const cleanup = () => {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      cleanupListeners();
      if (scene) {
        scene.traverse((object) => {
          const mesh = object as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.geometry?.dispose();
          const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          materials.forEach((material) => {
            if (!material) return;
            const record = material as unknown as Record<string, unknown>;
            Object.values(record).forEach((value) => {
              if (value instanceof THREE.Texture) value.dispose();
            });
            material.dispose();
          });
        });
      }
      envTarget?.dispose();
      pmrem?.dispose();
      renderer?.dispose();
      controllerRef.current = null;
    };

    async function init() {
      const canvas = canvasRef.current;
      if (!canvas) return;

      try {
        renderer = new THREE.WebGLRenderer({
          canvas,
          antialias: true,
          alpha: false,
          powerPreference: "high-performance",
        });
      } catch {
        setFailed(true);
        return;
      }

      if (disposed) return;

      const isMobile = window.innerWidth < 760;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isMobile ? 1.25 : 1.6));
      renderer.setSize(window.innerWidth, window.innerHeight, false);
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.0;
      renderer.outputColorSpace = THREE.SRGBColorSpace;

      scene = new THREE.Scene();
      scene.background = new THREE.Color(0x05060a);
      scene.fog = new THREE.FogExp2(0x05060a, isMobile ? 0.034 : 0.029);

      const camera = new THREE.PerspectiveCamera(34, window.innerWidth / window.innerHeight, 0.04, 120);

      try {
        pmrem = new THREE.PMREMGenerator(renderer);
        const room = new RoomEnvironment();
        envTarget = pmrem.fromScene(room, 0.04);
        scene.environment = envTarget.texture;
        scene.environmentIntensity = isMobile ? 0.22 : 0.3;
        room.dispose?.();
        pmrem.dispose();
        pmrem = null;
      } catch {
        // Environment reflections are a nice-to-have.
      }

      scene.add(new THREE.HemisphereLight(0x9eb6ff, 0x08090d, 0.62));
      const key = new THREE.DirectionalLight(0xffe8df, 1.55);
      key.position.set(-2.5, 4.5, 4);
      scene.add(key);
      const rim = new THREE.DirectionalLight(0x6694ff, 1.1);
      rim.position.set(1.8, 3.5, -4.5);
      scene.add(rim);
      const fill = new THREE.DirectionalLight(0xffdfd2, 0.5);
      fill.position.set(0.8, 2.2, 4.2);
      scene.add(fill);
      const redLight = new THREE.PointLight(0xff304f, 12, 8, 2);
      redLight.position.set(-2.8, 1.6, 1.4);
      scene.add(redLight);
      const blueLight = new THREE.PointLight(0x287bff, 12, 8, 2);
      blueLight.position.set(2.8, 1.5, 1.4);
      scene.add(blueLight);
      const faceFill = new THREE.PointLight(0xffeadf, isMobile ? 2.2 : 3.2, 4.2, 2);
      faceFill.position.set(0.35, 1.78, 1.05);
      scene.add(faceFill);

      const floorMaterial = new THREE.MeshStandardMaterial({
        color: 0x04050a,
        roughness: 0.28,
        metalness: 0.58,
        envMapIntensity: 0.7,
      });
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), floorMaterial);
      floor.rotation.x = -Math.PI / 2;
      scene.add(floor);

      const grid = new THREE.GridHelper(90, 90, 0x1b2a45, 0x0c111c);
      grid.position.y = 0.008;
      const gridMaterial = grid.material as THREE.Material;
      gridMaterial.transparent = true;
      gridMaterial.opacity = 0.18;
      scene.add(grid);

      const path = new THREE.Group();
      scene.add(path);
      const pathMaterial = new THREE.MeshStandardMaterial({
        color: 0x060810,
        roughness: 0.3,
        metalness: 0.55,
        envMapIntensity: 0.75,
      });
      const runway = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.035, 20), pathMaterial);
      runway.position.set(0, 0.018, -8.2);
      path.add(runway);

      const curbMaterial = new THREE.MeshStandardMaterial({
        color: 0x0b0e16,
        roughness: 0.35,
        metalness: 0.6,
      });
      [-1.48, 1.48].forEach((x) => {
        const curb = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 20), curbMaterial);
        curb.position.set(x, 0.04, -8.2);
        path.add(curb);
      });

      const edgeRed = new THREE.Mesh(
        new THREE.BoxGeometry(0.026, 0.025, 20),
        new THREE.MeshStandardMaterial({
          color: 0xff304f,
          emissive: 0xff304f,
          emissiveIntensity: 0.5,
          roughness: 0.25,
        }),
      );
      edgeRed.position.set(-1.53, 0.045, -8.2);
      path.add(edgeRed);
      const edgeBlue = new THREE.Mesh(
        new THREE.BoxGeometry(0.026, 0.025, 20),
        new THREE.MeshStandardMaterial({
          color: 0x287bff,
          emissive: 0x287bff,
          emissiveIntensity: 0.5,
          roughness: 0.25,
        }),
      );
      edgeBlue.position.set(1.53, 0.045, -8.2);
      path.add(edgeBlue);

      const markers: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>[] = [];
      for (let index = 0; index < 26; index += 1) {
        const markerMaterial = new THREE.MeshStandardMaterial({
          color: 0x0b1020,
          emissive: 0x1d4d8a,
          emissiveIntensity: 0.25,
          roughness: 0.3,
          metalness: 0.4,
        });
        const marker = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.014, 0.06), markerMaterial);
        marker.position.set(0, 0.048, 1.0 - index * 0.62);
        path.add(marker);
        markers.push(marker);
      }

      const gates: Gate[] = [];
      const gateRoles = Object.keys(GATE_POSITIONS) as RoleSlug[];

      function addGate(role: RoleSlug) {
        const position = GATE_POSITIONS[role];
        const color = GATE_COLORS[role];
        const group = new THREE.Group();
        group.position.copy(position);
        scene?.add(group);

        const frameMaterial = new THREE.MeshStandardMaterial({
          color: 0x090c13,
          roughness: 0.38,
          metalness: 0.62,
          envMapIntensity: 0.7,
        });
        const stripMaterial = new THREE.MeshStandardMaterial({
          color: 0x05060a,
          emissive: color,
          emissiveIntensity: 0.55,
          roughness: 0.28,
          metalness: 0.25,
        });

        const dais = new THREE.Mesh(new THREE.CylinderGeometry(1.85, 2.0, 0.12, 40), frameMaterial);
        dais.position.y = 0.06;
        group.add(dais);
        const daisRing = new THREE.Mesh(
          new THREE.TorusGeometry(1.72, 0.032, 8, 56),
          stripMaterial.clone(),
        );
        daisRing.rotation.x = Math.PI / 2;
        daisRing.position.y = 0.13;
        group.add(daisRing);

        const pillarGeometry = new THREE.BoxGeometry(0.17, 3.85, 0.42);
        const stripGeometry = new THREE.BoxGeometry(0.028, 3.2, 0.028);
        const strips: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>[] = [];
        strips.push(daisRing);
        for (const side of [-1, 1]) {
          const pillar = new THREE.Mesh(pillarGeometry, frameMaterial);
          pillar.position.set(side * 1.18, 1.925, 0);
          group.add(pillar);
          const strip = new THREE.Mesh(stripGeometry, stripMaterial.clone());
          strip.position.set(side * 1.075, 1.73, 0.235);
          group.add(strip);
          strips.push(strip);
          const innerStrip = new THREE.Mesh(new THREE.BoxGeometry(0.018, 2.6, 0.05), stripMaterial.clone());
          innerStrip.position.set(side * 1.055, 1.72, 0.07);
          group.add(innerStrip);
          strips.push(innerStrip);
        }

        const arch = new THREE.Mesh(new THREE.TorusGeometry(1.18, 0.085, 8, 40, Math.PI), frameMaterial);
        arch.position.y = 3.85;
        group.add(arch);
        const archStrip = new THREE.Mesh(new THREE.TorusGeometry(1.18, 0.024, 6, 40, Math.PI), stripMaterial.clone());
        archStrip.position.set(0, 3.85, 0.225);
        group.add(archStrip);
        strips.push(archStrip);

        const outerArch = new THREE.Mesh(new THREE.TorusGeometry(1.48, 0.016, 6, 48, Math.PI), stripMaterial.clone());
        outerArch.position.set(0, 3.85, -0.08);
        group.add(outerArch);

        const portal = new THREE.Mesh(
          new THREE.PlaneGeometry(2.12, 3.55),
          new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.045,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            side: THREE.DoubleSide,
          }),
        );
        portal.position.set(0, 1.98, 0.04);
        group.add(portal);

        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(0.54, 0.018, 8, 48),
          new THREE.MeshStandardMaterial({
            color: 0x05060a,
            emissive: color,
            emissiveIntensity: 0.6,
            roughness: 0.22,
          }),
        );
        ring.position.set(0, 2.2, 0.28);
        group.add(ring);

        const core = new THREE.Mesh(
          new THREE.SphereGeometry(0.085, 16, 12),
          new THREE.MeshStandardMaterial({
            color: 0x05060a,
            emissive: color,
            emissiveIntensity: 2.2,
            roughness: 0.2,
          }),
        );
        core.position.set(0, 2.2, 0.32);
        group.add(core);

        const shards: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>[] = [];
        for (let index = 0; index < 4; index += 1) {
          const shard = new THREE.Mesh(
            new THREE.BoxGeometry(0.25, 0.035, 0.035),
            stripMaterial.clone(),
          );
          const angle = (index / 4) * Math.PI * 2;
          shard.position.set(Math.cos(angle) * 1.7, 1.35 + index * 0.42, 0.1 + Math.sin(angle) * 0.2);
          shard.rotation.z = angle * 0.6;
          group.add(shard);
          shards.push(shard);
        }

        const light = new THREE.PointLight(color, 1.8, 5.2, 2);
        light.position.set(0, 2.0, 0.55);
        group.add(light);

        const glow = new THREE.Mesh(
          new THREE.PlaneGeometry(4.2, 4.2),
          new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.055,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          }),
        );
        glow.rotation.x = -Math.PI / 2;
        glow.position.y = 0.145;
        group.add(glow);

        gates.push({ role, group, strips, ring, shards, light, glow });
      }

      gateRoles.forEach(addGate);

      const monoliths: Array<[number, number, number, number, number, number]> = [
        [-6.4, -3.8, 1.2, 5.2, 1.2, 0xff304f],
        [-9.5, -10.8, 1.8, 9.2, 1.8, 0x287bff],
        [7.0, -4.8, 1.3, 5.8, 1.3, 0x287bff],
        [10.4, -12.4, 2.0, 10.4, 2.0, 0xff304f],
        [-13.5, -17.5, 2.5, 13, 2.3, 0x287bff],
        [14.2, -18.5, 2.4, 12, 2.4, 0xff304f],
        [-5.8, -18.0, 1.6, 8.0, 1.6, 0xff304f],
        [6.0, -20.5, 1.8, 8.8, 1.8, 0x287bff],
      ];

      monoliths.forEach(([x, z, width, height, depth, color]) => {
        const material = new THREE.MeshStandardMaterial({
          color: 0x070910,
          roughness: 0.58,
          metalness: 0.32,
        });
        const monolith = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
        monolith.position.set(x, height / 2, z);
        scene?.add(monolith);

        const strip = new THREE.Mesh(
          new THREE.BoxGeometry(0.026, height * 0.8, 0.026),
          new THREE.MeshStandardMaterial({
            color: 0x05060a,
            emissive: color,
            emissiveIntensity: 0.45,
            roughness: 0.3,
          }),
        );
        strip.position.set(x - width / 2 - 0.015, height / 2, z + depth / 2 + 0.015);
        scene?.add(strip);
      });

      const holoWall = new THREE.Mesh(
        new THREE.PlaneGeometry(34, 15),
        new THREE.MeshBasicMaterial({
          color: 0x0b1c38,
          transparent: true,
          opacity: 0.1,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      holoWall.position.set(0, 6.5, -25);
      scene.add(holoWall);

      const particleCount = isMobile ? 120 : 260;
      const positions = new Float32Array(particleCount * 3);
      for (let index = 0; index < particleCount; index += 1) {
        positions[index * 3] = (Math.random() - 0.5) * 28;
        positions[index * 3 + 1] = Math.random() * 9;
        positions[index * 3 + 2] = -26 + Math.random() * 28;
      }
      const particleGeometry = new THREE.BufferGeometry();
      particleGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      const particles = new THREE.Points(
        particleGeometry,
        new THREE.PointsMaterial({
          color: 0x8fb3ff,
          size: isMobile ? 0.022 : 0.018,
          transparent: true,
          opacity: 0.42,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      scene.add(particles);

      function makeShadowTexture(): THREE.CanvasTexture {
        const shadowCanvas = document.createElement("canvas");
        shadowCanvas.width = 128;
        shadowCanvas.height = 128;
        const context = shadowCanvas.getContext("2d");
        if (context) {
          const gradient = context.createRadialGradient(64, 64, 4, 64, 64, 64);
          gradient.addColorStop(0, "rgba(0,0,0,0.62)");
          gradient.addColorStop(0.55, "rgba(0,0,0,0.28)");
          gradient.addColorStop(1, "rgba(0,0,0,0)");
          context.fillStyle = gradient;
          context.fillRect(0, 0, 128, 128);
        }
        return new THREE.CanvasTexture(shadowCanvas);
      }

      const shadowTexture = makeShadowTexture();
      const shadow = new THREE.Mesh(
        new THREE.PlaneGeometry(1.7, 1.7),
        new THREE.MeshBasicMaterial({
          map: shadowTexture,
          transparent: true,
          depthWrite: false,
          opacity: 0.8,
        }),
      );
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.y = 0.012;
      scene.add(shadow);

      let model: THREE.Object3D | null = null;
      let animationClips: THREE.AnimationClip[] = [];
      try {
        const gltf = await new GLTFLoader().loadAsync(MODEL_URL);
        model = gltf.scene;
        animationClips = gltf.animations;
      } catch {
        if (!disposed) setFailed(true);
        return;
      }

      if (disposed || !model) {
        if (!disposed) setFailed(true);
        return;
      }
      model.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.frustumCulled = false;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        materials.forEach((material) => {
          if (!material) return;
          const standard = material as THREE.MeshStandardMaterial;
          standard.envMapIntensity = 0.75;
          standard.needsUpdate = true;
        });
      });

      const head = model.getObjectByName("Head");
      if (head) head.add(createGlasses());

      const character = new THREE.Group();
      character.add(model);
      scene.add(character);

      const walkClip =
        animationClips.find((clip) => /walk/i.test(clip.name)) ?? animationClips[0];
      if (!walkClip) {
        setFailed(true);
        return;
      }

      const idleClip = createIdleClip(character, walkClip);
      const mixer = new THREE.AnimationMixer(character);
      const walkAction = mixer.clipAction(walkClip);
      const idleAction = mixer.clipAction(idleClip);
      walkAction.play();
      idleAction.play();
      walkAction.setEffectiveWeight(0);
      idleAction.setEffectiveWeight(1);
      mixer.update(0);

      const state = {
        phase: phaseRef.current,
        phaseStart: performance.now() / 1000,
        selected: null as RoleSlug | null,
        walkBlend: 0,
        speed: 0,
      };

      const closePosition = new THREE.Vector3(0, 1.62, isMobile ? 1.08 : 0.88);
      const closeLook = new THREE.Vector3(0, 1.595, 0);
      const widePosition = new THREE.Vector3(0.3, isMobile ? 2.2 : 2.05, isMobile ? 7.9 : 6.4);
      const wideLook = new THREE.Vector3(0.1, 1.02, -2.0);
      const selectorPosition = new THREE.Vector3(isMobile ? 1.55 : 2.7, isMobile ? 2.05 : 2.05, isMobile ? 2.4 : 1.2);
      const selectorLook = new THREE.Vector3(isMobile ? 0 : 0.12, isMobile ? 1.24 : 1.12, SELECTOR_Z - 0.15);
      const faceCameraAngle = Math.atan2(selectorPosition.x, selectorPosition.z - SELECTOR_Z);

      const desiredPosition = widePosition.clone();
      const desiredLook = wideLook.clone();
      const currentLook = closeLook.clone();
      const tempVector = new THREE.Vector3();
      const tempLook = new THREE.Vector3();

      function applyPhase(next: Phase, jump = false) {
        const previous = state.phase;
        state.phase = next;
        state.phaseStart = performance.now() / 1000 - (jump ? 10 : 0);
        if (next === "greeting" || next === "reveal") {
          character.position.set(0, 0, 0);
          character.rotation.y = 0;
          state.walkBlend = 0;
        } else if (next === "approach") {
          character.position.set(0, 0, 0);
          character.rotation.y = 0;
          state.walkBlend = 0;
        } else if (next === "selecting") {
          character.position.set(0, 0, SELECTOR_Z);
          if (jump) {
            character.rotation.y = faceCameraAngle;
            state.walkBlend = 0;
          }
        } else if (next === "departing" && previous !== "departing") {
          character.position.set(0, 0, SELECTOR_Z);
          state.walkBlend = 0;
        } else if (next === "transition") {
          const destination = state.selected ? GATE_POSITIONS[state.selected] : GATE_POSITIONS.data;
          character.position.set(destination.x, 0, destination.z);
          state.walkBlend = 0;
        }
        if (jump && next === "selecting") {
          desiredPosition.copy(selectorPosition);
          desiredLook.copy(selectorLook);
        }
      }

      applyPhase(state.phase, state.phase === "selecting");

      camera.position.copy(state.phase === "selecting" ? selectorPosition : closePosition);
      currentLook.copy(state.phase === "selecting" ? selectorLook : closeLook);
      camera.lookAt(currentLook);

      function updateCharacter(dt: number, time: number) {
        const phaseTime = time - state.phaseStart;
        let moving = false;
        let speed = 0;

        if (state.phase === "approach") {
          const travel = travelProfile(phaseTime, Math.abs(SELECTOR_Z));
          character.position.z = -travel.covered;
          moving = !travel.done;
          speed = travel.speed;
          const turn = easeInOutCubic(clamp(phaseTime / 1.05));
          character.rotation.y = lerpAngle(0, Math.PI, turn);
          if (travel.done) {
            const settle = smoothstep(clamp((phaseTime - travel.total) / 0.9));
            character.rotation.y = lerpAngle(Math.PI, faceCameraAngle, settle);
          }
        } else if (state.phase === "departing") {
          const destination = state.selected ? GATE_POSITIONS[state.selected] : GATE_POSITIONS.data;
          const distance = Math.hypot(destination.x, destination.z - SELECTOR_Z);
          const travel = travelProfile(phaseTime, distance);
          const ratio = distance > 0 ? travel.covered / distance : 1;
          character.position.x = lerp(0, destination.x, ratio);
          character.position.z = lerp(SELECTOR_Z, destination.z, ratio);
          moving = !travel.done;
          speed = travel.speed;
          const targetAngle = Math.atan2(destination.x, destination.z - SELECTOR_Z);
          const turn = smoothstep(clamp(phaseTime / 0.95));
          character.rotation.y = lerpAngle(faceCameraAngle, targetAngle, turn);
        } else if (state.phase === "selecting") {
          character.position.set(0, 0, SELECTOR_Z);
          character.rotation.y = dampAngle(character.rotation.y, faceCameraAngle, dt, 6.5);
        } else if (state.phase === "transition") {
          const destination = state.selected ? GATE_POSITIONS[state.selected] : GATE_POSITIONS.data;
          character.position.set(destination.x, 0, destination.z);
          const targetAngle = Math.atan2(destination.x, destination.z - SELECTOR_Z);
          character.rotation.y = dampAngle(character.rotation.y, targetAngle, dt, 7);
        }

        state.speed = speed;
        const targetBlend = moving ? 1 : 0;
        state.walkBlend = lerp(state.walkBlend, targetBlend, 1 - Math.exp(-dt * 9));
        walkAction.setEffectiveWeight(state.walkBlend);
        idleAction.setEffectiveWeight(1 - state.walkBlend);
        walkAction.timeScale = clamp(speed / WALK_CYCLE_DISTANCE, 0.04, 1.2);
        mixer.update(dt);

        shadow.position.x = character.position.x;
        shadow.position.z = character.position.z;

        const pathProgress = character.position.z;
        markers.forEach((marker) => {
          const distance = Math.abs(marker.position.z - pathProgress);
          const active = Math.max(0, 1 - distance / 1.4);
          marker.material.emissiveIntensity = 0.12 + active * 0.9;
          marker.material.emissive.setHex(active > 0.2 ? 0x287bff : 0x17396b);
        });

        gates.forEach((gate) => {
          const isSelected = state.selected === gate.role;
          const active = isSelected && (state.phase === "departing" || state.phase === "transition");
          const preparing = state.phase === "selecting";
          gate.strips.forEach((strip) => {
            strip.material.emissiveIntensity = active ? 2.0 : preparing ? (isSelected ? 1.5 : 0.42) : 0.28;
          });
          gate.ring.material.emissiveIntensity = active ? 1.7 : preparing ? (isSelected ? 1.15 : 0.34) : 0.22;
          gate.light.intensity = active ? 4.2 : preparing ? (isSelected ? 1.2 : 0.55) : 0.35;
          gate.glow.material.opacity = active ? 0.13 : preparing ? (isSelected ? 0.07 : 0.026) : 0.016;
          gate.ring.rotation.z += dt * (active ? 0.5 : 0.16);
          gate.shards.forEach((shard, index) => {
            shard.position.y += Math.sin(time * 0.8 + index) * dt * 0.02;
            shard.rotation.x += dt * 0.15;
          });
        });
      }

      function updateCamera(dt: number, time: number) {
        const phaseTime = time - state.phaseStart;
        if (state.phase === "greeting") {
          desiredPosition.copy(closePosition);
          desiredPosition.z -= Math.sin(time * 0.65) * 0.006;
          desiredLook.copy(closeLook);
        } else if (state.phase === "reveal") {
          const progress = easeInOutCubic(clamp(phaseTime / REVEAL_SECONDS));
          desiredPosition.copy(closePosition).lerp(widePosition, progress);
          desiredLook.copy(closeLook).lerp(wideLook, progress);
        } else if (state.phase === "approach") {
          const approachSeconds = travelDuration(Math.abs(SELECTOR_Z)) + 0.95;
          const progress = easeInOutCubic(clamp(phaseTime / approachSeconds));
          desiredPosition.copy(widePosition).lerp(selectorPosition, progress);
          desiredLook.copy(wideLook).lerp(selectorLook, progress);
        } else if (state.phase === "selecting") {
          desiredPosition.copy(selectorPosition);
          desiredPosition.x += Math.sin(time * 0.24) * 0.035;
          desiredPosition.y += Math.sin(time * 0.33) * 0.018;
          desiredLook.copy(selectorLook);
        } else if (state.phase === "departing" || state.phase === "transition") {
          const destination = state.selected ? GATE_POSITIONS[state.selected] : GATE_POSITIONS.data;
          const distance = Math.hypot(destination.x, destination.z - SELECTOR_Z);
          const departSeconds = travelDuration(distance) + 0.2;
          const progress = easeInOutCubic(clamp(phaseTime / departSeconds));
          const destinationCamera = new THREE.Vector3(
            destination.x * 0.42 + (isMobile ? 1.7 : 2.7),
            isMobile ? 2.2 : 2.12,
            destination.z + (isMobile ? 4.6 : 4.8),
          );
          const destinationLook = new THREE.Vector3(destination.x * 0.72, 1.32, destination.z);
          const near = new THREE.Vector3(
            destination.x * 0.7 + (isMobile ? 0.5 : 1.1),
            isMobile ? 1.95 : 1.9,
            destination.z + (isMobile ? 2.1 : 2.4),
          );
          if (state.phase === "transition") {
            const t = easeInOutCubic(clamp(phaseTime / 0.8));
            desiredPosition.copy(destinationCamera).lerp(near, t);
            desiredLook.copy(destinationLook).lerp(new THREE.Vector3(destination.x, 1.6, destination.z), t);
          } else {
            desiredPosition.copy(selectorPosition).lerp(destinationCamera, progress);
            desiredLook.copy(selectorLook).lerp(destinationLook, progress);
          }
        } else {
          desiredPosition.copy(closePosition);
          desiredLook.copy(closeLook);
        }

        const damping = 1 - Math.exp(-dt * (state.phase === "selecting" ? 3.6 : 4.2));
        tempVector.copy(camera.position).lerp(desiredPosition, damping);
        tempLook.copy(currentLook).lerp(desiredLook, damping);
        camera.position.copy(tempVector);
        currentLook.copy(tempLook);
        camera.lookAt(currentLook);
      }

      let lastTime = performance.now() / 1000;
      function animate(frameTime: number) {
        if (disposed) return;
        raf = requestAnimationFrame(animate);
        if (document.hidden) return;
        const time = frameTime / 1000;
        const dt = Math.min(0.05, time - lastTime);
        lastTime = time;
        updateCharacter(dt, time);
        updateCamera(dt, time);
        particles.rotation.y += dt * 0.006;
        renderer?.render(scene as THREE.Scene, camera);
      }

      function onResize() {
        if (disposed) return;
        const mobile = window.innerWidth < 760;
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer?.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobile ? 1.25 : 1.6));
        renderer?.setSize(window.innerWidth, window.innerHeight, false);
      }

      function onVisibility() {
        lastTime = performance.now() / 1000;
      }

      function onContextLost(event: Event) {
        event.preventDefault();
        setFailed(true);
      }

      window.addEventListener("resize", onResize);
      document.addEventListener("visibilitychange", onVisibility);
      canvas.addEventListener("webglcontextlost", onContextLost);
      cleanupListeners = () => {
        window.removeEventListener("resize", onResize);
        document.removeEventListener("visibilitychange", onVisibility);
        canvas.removeEventListener("webglcontextlost", onContextLost);
      };

      controllerRef.current = {
        setPhase: (next, jump = false) => applyPhase(next, jump),
        jumpToSelecting: () => applyPhase("selecting", true),
        walkTo: (role) => {
          state.selected = role;
          applyPhase("departing");
        },
      };

      if (scene) renderer.compile(scene, camera);
      setReady(true);
      handleSceneReady();
      raf = requestAnimationFrame(animate);
    }

    void init();

    return cleanup;
  }, [failed, handleSceneReady, reduced]);

  const handleSelect = useCallback(
    (role: RoleSlug) => {
      if (phaseRef.current !== "selecting" || completeRef.current) return;
      clearTimers();
      setSelected(role);
      setPhase("departing");
      controllerRef.current?.walkTo(role);
      const destination = GATE_POSITIONS[role];
      const distance = Math.hypot(destination.x, destination.z - SELECTOR_Z);
      const departSeconds = travelDuration(distance) + 0.24;
      schedule(departSeconds * 1000, () => setPhase("transition"));
      schedule(departSeconds * 1000 + 850, () => complete(role));
    },
    [clearTimers, complete, schedule],
  );

  const handleStaticSelect = useCallback(
    (role: RoleSlug) => {
      markSeen();
      void prefetchRole(role);
      router.push(`/jobs/${role}`);
    },
    [markSeen, router],
  );

  if (reduced || failed) {
    return <StaticIntro onSelect={handleStaticSelect} reduced={reduced} />;
  }

  const role = selected ? getRole(selected) : null;

  return (
    <main className={`cinematic-intro phase-${phase}`}>
      <div className="intro-poster" aria-hidden />
      <canvas ref={canvasRef} className={`intro-canvas ${ready ? "is-ready" : ""}`} aria-hidden />

      <div className="intro-vignette" aria-hidden />
      <div className="intro-ambient intro-ambient-red" aria-hidden />
      <div className="intro-ambient intro-ambient-blue" aria-hidden />

      <header className="intro-topbar">
        <span className="brand-lockup">
          <span className="brand-mark">
            <SparkIcon width={17} height={17} />
          </span>
          <span className="brand-copy">
            <strong>JOBHUNT</strong>
            <span>INDIA / 2026</span>
          </span>
        </span>
        <div className="intro-top-actions">
          <span className="intro-status">
            <span className="status-dot" />
            Live job data
          </span>
          {phase === "departing" ? (
            <button type="button" className="skip-intro" onClick={skipJourney}>
              Skip journey
              <ArrowRightIcon width={14} height={14} />
            </button>
          ) : phase !== "selecting" ? (
            <button type="button" className="skip-intro" onClick={skipToRoles}>
              Skip intro
              <ArrowRightIcon width={14} height={14} />
            </button>
          ) : null}
        </div>
      </header>

      {phase === "loading" ? (
        <div className="intro-loader" role="status" aria-live="polite">
          <div className="loader-mark">
            <PlayIcon width={18} height={18} />
          </div>
          <p>Preparing your guide…</p>
          <span className="loader-line" aria-hidden />
          <button type="button" className="skip-intro" onClick={skipToRoles}>
            Skip intro
            <ArrowRightIcon width={14} height={14} />
          </button>
        </div>
      ) : null}

      {phase === "greeting" ? (
        <div className="intro-greeting" aria-live="polite">
          HI<span>.</span>
        </div>
      ) : null}

      {phase === "reveal" || phase === "approach" ? (
        <div className="intro-tagline" aria-live="polite">
          <p>LET&apos;S FIND YOUR NEXT MOVE.</p>
          <span>
            {phase === "approach"
              ? "Follow the light. Your destination is just ahead."
              : "A dark path. Three directions. One next move."}
          </span>
        </div>
      ) : null}

      {phase === "selecting" ? (
        <section className="intro-roles intro-roles-cinematic" aria-labelledby="cinematic-role-title">
          <div className="intro-roles-head">
            <p className="intro-kicker">WHERE DO WE GO?</p>
            <h2 id="cinematic-role-title">Choose your target role.</h2>
            <p className="intro-roles-sub">I&apos;ll take you there.</p>
          </div>
          <RoleDestinations onSelect={handleSelect} selected={selected} />
          <p className="intro-footnote">
            <span className="status-dot" />
            Real listings only · No mock jobs · Updated daily
          </p>
        </section>
      ) : null}

      {phase === "departing" && role ? (
        <div className="intro-depart" aria-live="polite" style={{ "--role-accent": role.accent } as CSSProperties}>
          <p className="intro-kicker">DESTINATION LOCKED</p>
          <h2>Heading toward {role.fullLabel}.</h2>
          <p>Finding your next move. The dashboard will be ready when you arrive.</p>
          <span className="depart-line" aria-hidden />
        </div>
      ) : null}

      {phase === "transition" && role ? (
        <div
          className="intro-transition"
          aria-live="polite"
          style={{ "--role-accent": role.accent } as CSSProperties}
        >
          <span className="transition-sweep" aria-hidden />
          <div>
            <p className="intro-kicker">ARRIVING AT</p>
            <h2>{role.fullLabel}</h2>
            <p>Opening your opportunities…</p>
          </div>
        </div>
      ) : null}

      {phase === "greeting" || phase === "reveal" || phase === "approach" ? (
        <p className="intro-hint">
          <span className="status-dot" />
          Sound off · Visual journey
        </p>
      ) : null}
    </main>
  );
}
