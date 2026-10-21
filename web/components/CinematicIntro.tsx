"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
const HEAD_HEIGHT = 0.285;
const HEAD_CENTER_Y = 1.69;
const SELECTOR_Z = -2.4;
const WALK_TO_SELECTOR_SECONDS = 2.15;

const GATE_POSITIONS: Record<RoleSlug, THREE.Vector3> = {
  genai: new THREE.Vector3(-3.15, 0, -5.25),
  data: new THREE.Vector3(0, 0, -5.65),
  uiux: new THREE.Vector3(3.15, 0, -5.25),
};

const GATE_COLORS: Record<RoleSlug, number> = {
  genai: 0xff304f,
  data: 0x287bff,
  uiux: 0xffffff,
};

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

function easeInOutCubic(value: number): number {
  return value < 0.5 ? 4 * value * value * value : 1 - Math.pow(-2 * value + 2, 3) / 2;
}

function easeOutCubic(value: number): number {
  return 1 - Math.pow(1 - value, 3);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpAngle(a: number, b: number, t: number): number {
  const delta = ((((b - a + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI;
  return a + delta * t;
}

interface SceneController {
  setPhase: (phase: Phase, jump?: boolean) => void;
  jumpToSelecting: () => void;
  walkTo: (role: RoleSlug) => void;
}

interface Gate {
  role: RoleSlug;
  group: THREE.Group;
  strips: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>[];
  ring: THREE.Mesh<THREE.TorusGeometry, THREE.MeshStandardMaterial>;
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

  const handleSceneReady = useCallback(() => {
    setReady(true);
    if (phaseRef.current === "selecting") {
      controllerRef.current?.setPhase("selecting", true);
      return;
    }
    if (reduced) return;

    setPhase("greeting");
    schedule(2600, () => { setPhase("reveal"); });
    schedule(2600 + 3000, () => { setPhase("approach"); });
    schedule(2600 + 3000 + WALK_TO_SELECTOR_SECONDS * 1000, () => { setPhase("selecting"); });
  }, [reduced, schedule]);

  // If the model/WebGL takes too long, fall back to the accessible static intro.
  useEffect(() => {
    if (reduced || failed || ready) return;
    const timer = window.setTimeout(() => {
      if (!ready) setFailed(true);
    }, 9000);
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

    const cleanup = () => {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
      if (scene) {
        scene.traverse((object) => {
          const mesh = object as THREE.Mesh;
          if (mesh.isMesh) {
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
          }
        });
      }
      envTarget?.dispose();
      pmrem?.dispose();
      renderer?.dispose();
      controllerRef.current = null;
    };

    let onResize = () => undefined;
    let onVisibility = () => undefined;

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
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isMobile ? 1.5 : 1.75));
      renderer.setSize(window.innerWidth, window.innerHeight, false);
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 0.98;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.localClippingEnabled = true;

      scene = new THREE.Scene();
      scene.background = new THREE.Color(0x05060a);
      scene.fog = new THREE.FogExp2(0x05060a, 0.045);

      const camera = new THREE.PerspectiveCamera(36, window.innerWidth / window.innerHeight, 0.04, 80);

      try {
        pmrem = new THREE.PMREMGenerator(renderer);
        const room = new RoomEnvironment();
        envTarget = pmrem.fromScene(room, 0.04);
        scene.environment = envTarget.texture;
        scene.environmentIntensity = 0.32;
        room.dispose?.();
        pmrem.dispose();
        pmrem = null;
      } catch {
        // Environment reflections are a nice-to-have.
      }

      scene.add(new THREE.HemisphereLight(0x9eb6ff, 0x08090d, 0.55));
      const key = new THREE.DirectionalLight(0xffe8df, 1.9);
      key.position.set(-2.5, 4.5, 4);
      scene.add(key);
      const rim = new THREE.DirectionalLight(0x6694ff, 1.25);
      rim.position.set(1.5, 3.5, -4);
      scene.add(rim);
      const redLight = new THREE.PointLight(0xff304f, 17, 9, 2);
      redLight.position.set(-2.4, 1.6, 1.25);
      scene.add(redLight);
      const blueLight = new THREE.PointLight(0x287bff, 17, 9, 2);
      blueLight.position.set(2.4, 1.5, 1.25);
      scene.add(blueLight);
      const fill = new THREE.DirectionalLight(0xffdfd2, 0.72);
      fill.position.set(0.71, 2.25, 3.4);
      scene.add(fill);

      const floorMaterial = new THREE.MeshStandardMaterial({
        color: 0x04050a,
        roughness: 0.25,
        metalness: 0.72,
      });
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), floorMaterial);
      floor.rotation.x = -Math.PI / 2;
      scene.add(floor);

      const grid = new THREE.GridHelper(80, 80, 0x263b5c, 0x101724);
      grid.position.y = 0.012;
      const gridMaterial = grid.material as THREE.Material;
      gridMaterial.transparent = true;
      gridMaterial.opacity = 0.22;
      scene.add(grid);

      const pathGroup = new THREE.Group();
      scene.add(pathGroup);
      const pathSegments: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>[] = [];
      for (let index = 0; index < 28; index += 1) {
        const material = new THREE.MeshStandardMaterial({
          color: 0x080b12,
          emissive: 0x0a1830,
          emissiveIntensity: 0.18,
          roughness: 0.28,
          metalness: 0.48,
        });
        const segment = new THREE.Mesh(new THREE.BoxGeometry(1.04, 0.018, 0.26), material);
        segment.position.set(0, 0.022, 0.8 - index * 0.34);
        pathGroup.add(segment);
        pathSegments.push(segment);
      }

      const edgeRed = new THREE.Mesh(
        new THREE.BoxGeometry(0.026, 0.022, 9.6),
        new THREE.MeshStandardMaterial({
          color: 0xff304f,
          emissive: 0xff304f,
          emissiveIntensity: 1.2,
          roughness: 0.3,
        }),
      );
      edgeRed.position.set(-0.55, 0.03, -3.9);
      pathGroup.add(edgeRed);

      const edgeBlue = new THREE.Mesh(
        new THREE.BoxGeometry(0.026, 0.022, 9.6),
        new THREE.MeshStandardMaterial({
          color: 0x287bff,
          emissive: 0x287bff,
          emissiveIntensity: 1.2,
          roughness: 0.3,
        }),
      );
      edgeBlue.position.set(0.55, 0.03, -3.9);
      pathGroup.add(edgeBlue);

      const gates: Gate[] = [];
      const gateRoles = Object.keys(GATE_POSITIONS) as RoleSlug[];

      function addGate(role: RoleSlug) {
        const position = GATE_POSITIONS[role];
        const color = GATE_COLORS[role];
        const group = new THREE.Group();
        group.position.copy(position);
        scene?.add(group);

        const frameMaterial = new THREE.MeshStandardMaterial({
          color: 0x0b0e15,
          roughness: 0.44,
          metalness: 0.5,
        });
        const stripMaterial = new THREE.MeshStandardMaterial({
          color: 0x05060a,
          emissive: color,
          emissiveIntensity: 0.85,
          roughness: 0.3,
          metalness: 0.2,
        });

        const left = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.45, 0.12), frameMaterial);
        left.position.set(-0.57, 1.225, 0);
        group.add(left);
        const right = left.clone();
        right.position.x = 0.57;
        group.add(right);
        const top = new THREE.Mesh(new THREE.BoxGeometry(1.24, 0.1, 0.12), frameMaterial);
        top.position.y = 2.45;
        group.add(top);

        const strips: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>[] = [];
        const leftStrip = new THREE.Mesh(new THREE.BoxGeometry(0.025, 2.1, 0.025), stripMaterial.clone());
        leftStrip.position.set(-0.49, 1.2, 0.07);
        group.add(leftStrip);
        strips.push(leftStrip);
        const rightStrip = new THREE.Mesh(new THREE.BoxGeometry(0.025, 2.1, 0.025), stripMaterial.clone());
        rightStrip.position.set(0.49, 1.2, 0.07);
        group.add(rightStrip);
        strips.push(rightStrip);

        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(0.37, 0.018, 8, 40),
          new THREE.MeshStandardMaterial({
            color: 0x05060a,
            emissive: color,
            emissiveIntensity: 0.8,
            roughness: 0.25,
          }),
        );
        ring.position.y = 1.45;
        group.add(ring);

        const light = new THREE.PointLight(color, 2.6, 4.4, 2);
        light.position.set(0, 1.35, 0.2);
        group.add(light);

        const glow = new THREE.Mesh(
          new THREE.PlaneGeometry(2.1, 2.1),
          new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.09,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          }),
        );
        glow.rotation.x = -Math.PI / 2;
        glow.position.y = 0.016;
        group.add(glow);

        gates.push({ role, group, strips, ring, light, glow });
      }

      gateRoles.forEach(addGate);

      const monoliths: Array<[number, number, number, number, number, number]> = [
        [-5.2, -2.4, 1.1, 4.5, 1.1, 0xff304f],
        [-7.8, -7.5, 1.6, 8.5, 1.5, 0x287bff],
        [6.1, -3.5, 1.2, 5.4, 1.2, 0x287bff],
        [8.4, -8.8, 1.8, 9.4, 1.8, 0xff304f],
        [-11.2, -12.5, 2.4, 12, 2.1, 0x287bff],
        [11.8, -13.5, 2.2, 10.5, 2.1, 0xff304f],
        [-4.7, -14.5, 1.8, 9, 1.6, 0xff304f],
        [4.9, -16.5, 1.5, 7.5, 1.5, 0x287bff],
      ];

      monoliths.forEach(([x, z, width, height, depth, color]) => {
        const material = new THREE.MeshStandardMaterial({
          color: 0x080a10,
          roughness: 0.62,
          metalness: 0.25,
        });
        const monolith = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
        monolith.position.set(x, height / 2, z);
        scene?.add(monolith);

        const strip = new THREE.Mesh(
          new THREE.BoxGeometry(0.03, height * 0.82, 0.03),
          new THREE.MeshStandardMaterial({
            color: 0x05060a,
            emissive: color,
            emissiveIntensity: 0.7,
            roughness: 0.3,
          }),
        );
        strip.position.set(x - width / 2 - 0.02, height / 2, z + depth / 2 + 0.02);
        scene?.add(strip);
      });

      const particleCount = isMobile ? 260 : 520;
      const positions = new Float32Array(particleCount * 3);
      for (let index = 0; index < particleCount; index += 1) {
        positions[index * 3] = (Math.random() - 0.5) * 24;
        positions[index * 3 + 1] = Math.random() * 8;
        positions[index * 3 + 2] = -22 + Math.random() * 20;
      }
      const particleGeometry = new THREE.BufferGeometry();
      particleGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      const particles = new THREE.Points(
        particleGeometry,
        new THREE.PointsMaterial({
          color: 0x8fb3ff,
          size: isMobile ? 0.028 : 0.022,
          transparent: true,
          opacity: 0.62,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      scene.add(particles);

      const character = new THREE.Group();
      character.position.set(0, 0, 0);
      scene.add(character);
      const body = new THREE.Group();
      character.add(body);

      const hoodieMaterial = new THREE.MeshStandardMaterial({
        color: 0x11151d,
        roughness: 0.82,
        metalness: 0.08,
      });
      const jeansMaterial = new THREE.MeshStandardMaterial({
        color: 0x1d3f6e,
        roughness: 0.76,
        metalness: 0.04,
      });
      const shoeMaterial = new THREE.MeshStandardMaterial({
        color: 0xe8ecf5,
        roughness: 0.38,
        metalness: 0.1,
      });
      const soleMaterial = new THREE.MeshStandardMaterial({
        color: 0x11151f,
        roughness: 0.55,
      });
      const skinMaterial = new THREE.MeshStandardMaterial({
        color: 0xbf8e78,
        roughness: 0.66,
      });

      // A deliberately simplified hoodie silhouette. The licensed head study
      // provides the close-up; the body is an original low-poly prototype.
      const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.175, 0.6, 24, 1), hoodieMaterial);
      torso.position.y = 1.15;
      torso.scale.z = 0.62;
      body.add(torso);

      const shoulderGeometry = new THREE.SphereGeometry(0.095, 20, 14);
      [-1, 1].forEach((side) => {
        const shoulder = new THREE.Mesh(shoulderGeometry, hoodieMaterial);
        shoulder.position.set(side * 0.17, 1.39, 0);
        shoulder.scale.set(1.05, 0.68, 0.85);
        body.add(shoulder);
      });

      const hem = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.19, 0.055, 20), hoodieMaterial);
      hem.position.y = 0.86;
      hem.scale.z = 0.64;
      body.add(hem);

      const hood = new THREE.Mesh(new THREE.SphereGeometry(0.15, 24, 16), hoodieMaterial);
      hood.position.set(0, 1.53, -0.08);
      hood.scale.set(1.2, 0.55, 0.9);
      body.add(hood);

      const neckline = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.13, 0.13, 20), hoodieMaterial);
      neckline.position.y = 1.515;
      neckline.scale.z = 0.72;
      body.add(neckline);

      const collar = new THREE.Mesh(new THREE.TorusGeometry(0.104, 0.023, 8, 24), hoodieMaterial);
      collar.position.set(0, 1.58, -0.002);
      collar.rotation.x = Math.PI / 2;
      collar.scale.z = 0.78;
      body.add(collar);

      const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.072, 0.12, 16), skinMaterial);
      neck.position.y = 1.58;
      body.add(neck);

      const headPivot = new THREE.Group();
      headPivot.position.y = 1.55;
      body.add(headPivot);
      const headGroup = new THREE.Group();
      headGroup.position.y = HEAD_CENTER_Y - 1.55;
      headPivot.add(headGroup);

      // The licensed study is bald. Keeping it unhelmeted is more honest than
      // inventing hair geometry that fights the scan at extreme close-up.
      // The character reads through the hoodie, posture and lighting.

      const armPivots: THREE.Group[] = [];
      [-1, 1].forEach((side) => {
        const pivot = new THREE.Group();
        pivot.position.set(side * 0.245, 1.39, 0);
        pivot.rotation.z = side * -0.045;
        body.add(pivot);
        const sleeve = new THREE.Mesh(new THREE.CapsuleGeometry(0.058, 0.33, 6, 12), hoodieMaterial);
        sleeve.position.y = -0.2;
        pivot.add(sleeve);
        const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.062, 0.05, 12), hoodieMaterial);
        cuff.position.y = -0.39;
        pivot.add(cuff);
        const hand = new THREE.Mesh(new THREE.SphereGeometry(0.058, 12, 10), skinMaterial);
        hand.position.y = -0.445;
        hand.scale.set(0.92, 1.25, 0.8);
        pivot.add(hand);
        armPivots.push(pivot);
      });

      const pelvis = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.15, 0.19, 20), jeansMaterial);
      pelvis.position.y = 0.91;
      pelvis.scale.z = 0.64;
      body.add(pelvis);

      const legPivots: Array<{ hip: THREE.Group; knee: THREE.Group }> = [];
      [-1, 1].forEach((side) => {
        const hip = new THREE.Group();
        hip.position.set(side * 0.095, 0.9, 0);
        body.add(hip);
        const thigh = new THREE.Mesh(new THREE.CapsuleGeometry(0.08, 0.32, 6, 12), jeansMaterial);
        thigh.position.y = -0.22;
        hip.add(thigh);
        const knee = new THREE.Group();
        knee.position.y = -0.42;
        hip.add(knee);
        const shin = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.28, 6, 12), jeansMaterial);
        shin.position.y = -0.2;
        knee.add(shin);
        const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.08, 0.255), shoeMaterial);
        shoe.position.set(0, -0.4, 0.06);
        knee.add(shoe);
        const sole = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.026, 0.265), soleMaterial);
        sole.position.set(0, -0.443, 0.06);
        knee.add(sole);
        legPivots.push({ hip, knee });
      });

      const pocket = new THREE.Mesh(
        new THREE.BoxGeometry(0.26, 0.014, 0.014),
        new THREE.MeshStandardMaterial({ color: 0x20242d, roughness: 0.8 }),
      );
      pocket.position.set(0, 1.01, 0.13);
      body.add(pocket);

      const zip = new THREE.Mesh(
        new THREE.BoxGeometry(0.012, 0.38, 0.012),
        new THREE.MeshStandardMaterial({ color: 0x2b303b, roughness: 0.65 }),
      );
      zip.position.set(0, 1.2, 0.143);
      body.add(zip);

      const stringMaterial = new THREE.MeshStandardMaterial({ color: 0xcfd5e2, roughness: 0.55 });
      [-0.042, 0.042].forEach((x) => {
        const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.19, 6), stringMaterial);
        cord.position.set(x, 1.33, 0.148);
        body.add(cord);
        const aglet = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.024, 6), stringMaterial);
        aglet.position.set(x, 1.222, 0.148);
        body.add(aglet);
      });

      function makeShadowTexture(): THREE.CanvasTexture {
        const shadowCanvas = document.createElement("canvas");
        shadowCanvas.width = 128;
        shadowCanvas.height = 128;
        const context = shadowCanvas.getContext("2d");
        if (context) {
          const gradient = context.createRadialGradient(64, 64, 4, 64, 64, 64);
          gradient.addColorStop(0, "rgba(0,0,0,0.7)");
          gradient.addColorStop(0.55, "rgba(0,0,0,0.32)");
          gradient.addColorStop(1, "rgba(0,0,0,0)");
          context.fillStyle = gradient;
          context.fillRect(0, 0, 128, 128);
        }
        return new THREE.CanvasTexture(shadowCanvas);
      }

      const shadowTexture = makeShadowTexture();
      const shadow = new THREE.Mesh(
        new THREE.PlaneGeometry(1.5, 1.5),
        new THREE.MeshBasicMaterial({
          map: shadowTexture,
          transparent: true,
          depthWrite: false,
          opacity: 0.9,
        }),
      );
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.y = 0.019;
      scene.add(shadow);

      let headReady = false;
      try {
        const loader = new GLTFLoader();
        const gltf = await loader.loadAsync("/models/lee-perry-smith/LeePerrySmith.glb");
        if (disposed) return;

        const head = gltf.scene;
        const box = new THREE.Box3().setFromObject(head);
        const size = new THREE.Vector3();
        const center = new THREE.Vector3();
        box.getSize(size);
        box.getCenter(center);
        const scale = HEAD_HEIGHT / Math.max(size.y, 0.0001);
        head.scale.setScalar(scale);
        head.position.set(-center.x * scale, -center.y * scale, -center.z * scale);

        let colorMap: THREE.Texture | null = null;
        let normalMap: THREE.Texture | null = null;
        const textureLoader = new THREE.TextureLoader();
        try {
          colorMap = await textureLoader.loadAsync("/models/lee-perry-smith/Map-COL.jpg");
          colorMap.colorSpace = THREE.SRGBColorSpace;
        } catch {
          // Use a skin-coloured material below.
        }
        try {
          normalMap = await textureLoader.loadAsync(
            "/models/lee-perry-smith/Infinite-Level_02_Tangent_SmoothUV.jpg",
          );
        } catch {
          // Normal map is optional.
        }

        if (disposed) {
          colorMap?.dispose();
          normalMap?.dispose();
          return;
        }

        head.traverse((object) => {
          const mesh = object as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.material = new THREE.MeshStandardMaterial({
            color: colorMap ? 0xffffff : 0xb9795d,
            map: colorMap ?? undefined,
            normalMap: normalMap ?? undefined,
            normalScale: new THREE.Vector2(0.55, 0.55),
            roughness: 0.6,
            metalness: 0.02,
            // The licensed study includes a bust. Clip the shoulder shell at
            // the neck so the hoodie body, not bare shoulders, carries the torso.
            clippingPlanes: [new THREE.Plane(new THREE.Vector3(0, 1, 0), -1.64)],
          });
        });
        headGroup.add(head);
        headReady = true;
      } catch {
        const fallbackHead = new THREE.Mesh(
          new THREE.SphereGeometry(HEAD_HEIGHT / 2, 32, 24),
          new THREE.MeshStandardMaterial({ color: 0x9c6b56, roughness: 0.62 }),
        );
        fallbackHead.scale.set(0.82, 1, 0.9);
        headGroup.add(fallbackHead);
        const hair = new THREE.Mesh(
          new THREE.SphereGeometry(HEAD_HEIGHT / 2 + 0.006, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.55),
          new THREE.MeshStandardMaterial({ color: 0x08090d, roughness: 0.9 }),
        );
        hair.scale.set(0.88, 0.55, 0.94);
        hair.position.y = 0.06;
        headGroup.add(hair);
        headReady = true;
      }

      if (!headReady) {
        setFailed(true);
        return;
      }

      const state = {
        phase: phaseRef.current,
        phaseStart: performance.now() / 1000,
        selected: null as RoleSlug | null,
        walkAmount: 0,
        walkTime: 0,
        idleTime: 0,
        lastZ: 0,
      };

      const closePosition = new THREE.Vector3(
        0,
        HEAD_CENTER_Y + (isMobile ? 0.085 : 0.12),
        isMobile ? 0.56 : 0.48,
      );
      const closeLook = new THREE.Vector3(0, HEAD_CENTER_Y + (isMobile ? 0.065 : 0.1), 0);
      const widePosition = new THREE.Vector3(0, isMobile ? 2.15 : 2.05, isMobile ? 6.9 : 6.0);
      const wideLook = new THREE.Vector3(0, 1.05, -1.3);
      const selectorPosition = new THREE.Vector3(isMobile ? 1.35 : 2.3, isMobile ? 1.95 : 2.12, isMobile ? 2.9 : 3.8);
      const selectorLook = new THREE.Vector3(isMobile ? 0 : 0.4, isMobile ? 1.2 : 1.05, SELECTOR_Z);

      const desiredPosition = widePosition.clone();
      const desiredLook = wideLook.clone();
      const currentLook = closeLook.clone();
      const tempVector = new THREE.Vector3();
      const tempLook = new THREE.Vector3();

      function applyPhase(next: Phase, jump = false) {
        state.phase = next;
        state.phaseStart = performance.now() / 1000 - (jump ? 10 : 0);
        if (next === "greeting" || next === "reveal") {
          character.position.set(0, 0, 0);
          character.rotation.y = 0;
          state.walkAmount = 0;
        } else if (next === "approach") {
          character.position.set(0, 0, 0);
          character.rotation.y = 0;
        } else if (next === "selecting") {
          character.position.set(0, 0, SELECTOR_Z);
          character.rotation.y = 0;
          state.walkAmount = 0;
        } else if (next === "departing") {
          character.position.set(0, 0, SELECTOR_Z);
          character.rotation.y = 0;
        } else if (next === "transition") {
          const destination = state.selected ? GATE_POSITIONS[state.selected] : GATE_POSITIONS.data;
          character.position.set(destination.x, 0, destination.z);
          state.walkAmount = 0;
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

        if (state.phase === "approach") {
          const progress = easeInOutCubic(clamp(phaseTime / WALK_TO_SELECTOR_SECONDS));
          character.position.z = lerp(0, SELECTOR_Z, progress);
          character.rotation.y = lerpAngle(0, Math.PI, clamp(progress * 1.8));
          moving = progress < 0.995;
        } else if (state.phase === "departing") {
          const destination = state.selected ? GATE_POSITIONS[state.selected] : GATE_POSITIONS.data;
          const progress = easeInOutCubic(clamp(phaseTime / 2.15));
          character.position.x = lerp(0, destination.x, progress);
          character.position.z = lerp(SELECTOR_Z, destination.z, progress);
          const angle = Math.atan2(destination.x, destination.z - SELECTOR_Z);
          character.rotation.y = lerpAngle(0, angle, clamp(progress * 1.55));
          moving = progress < 0.995;
        } else if (state.phase === "selecting") {
          character.position.set(0, 0, SELECTOR_Z);
          character.rotation.y = lerpAngle(character.rotation.y, 0, 1 - Math.exp(-dt * 8));
        } else if (state.phase === "transition") {
          moving = false;
        }

        state.walkAmount = lerp(state.walkAmount, moving ? 1 : 0, 1 - Math.exp(-dt * 7));
        state.walkTime += dt * (moving ? 7.8 : 2.1);
        state.idleTime += dt;

        const swing = Math.sin(state.walkTime) * state.walkAmount;
        legPivots[0].hip.rotation.x = swing * 0.52;
        legPivots[1].hip.rotation.x = -swing * 0.52;
        legPivots[0].knee.rotation.x = Math.max(0, -swing) * 0.58;
        legPivots[1].knee.rotation.x = Math.max(0, swing) * 0.58;
        armPivots[0].rotation.x = -swing * 0.4;
        armPivots[1].rotation.x = swing * 0.4;

        const bob = Math.abs(Math.sin(state.walkTime)) * 0.018 * state.walkAmount;
        const idleBob = Math.sin(state.idleTime * 1.35) * 0.006 * (1 - state.walkAmount);
        body.position.y = bob + idleBob;
        headPivot.rotation.y = Math.sin(state.idleTime * 0.55) * 0.018 * (1 - state.walkAmount);
        headPivot.rotation.x = Math.sin(state.idleTime * 0.42) * 0.012 * (1 - state.walkAmount);

        shadow.position.x = character.position.x;
        shadow.position.z = character.position.z;

        const pathProgress = character.position.z;
        pathSegments.forEach((segment) => {
          const distance = Math.abs(segment.position.z - pathProgress);
          const active = Math.max(0, 1 - distance / 1.25);
          segment.material.emissiveIntensity = 0.16 + active * 1.9;
          segment.material.emissive.setHex(active > 0.2 ? 0x287bff : 0x0a1830);
        });

        gates.forEach((gate) => {
          const selectedGate = state.selected === gate.role;
          const active = selectedGate && (state.phase === "departing" || state.phase === "transition");
          gate.strips.forEach((strip) => {
            strip.material.emissiveIntensity = active ? 2.6 : state.phase === "selecting" ? 0.9 : 0.35;
          });
          gate.ring.material.emissiveIntensity = active ? 2.2 : state.phase === "selecting" ? 0.65 : 0.25;
          gate.light.intensity = active ? 5.2 : state.phase === "selecting" ? 1.3 : 0.45;
          gate.glow.material.opacity = active ? 0.2 : state.phase === "selecting" ? 0.07 : 0.03;
        });
      }

      function updateCamera(dt: number, time: number) {
        const phaseTime = time - state.phaseStart;
        if (state.phase === "greeting") {
          desiredPosition.copy(closePosition);
          desiredPosition.z -= Math.sin(time * 0.7) * 0.008;
          desiredLook.copy(closeLook);
        } else if (state.phase === "reveal") {
          const progress = easeInOutCubic(clamp(phaseTime / 2.8));
          desiredPosition.copy(closePosition).lerp(widePosition, progress);
          desiredLook.copy(closeLook).lerp(wideLook, progress);
        } else if (state.phase === "approach") {
          const progress = easeInOutCubic(clamp(phaseTime / WALK_TO_SELECTOR_SECONDS));
          desiredPosition.copy(widePosition).lerp(selectorPosition, progress);
          desiredLook.copy(wideLook).lerp(selectorLook, progress);
        } else if (state.phase === "selecting") {
          desiredPosition.copy(selectorPosition);
          desiredPosition.x += Math.sin(time * 0.25) * 0.05;
          desiredPosition.y += Math.sin(time * 0.36) * 0.025;
          desiredLook.copy(selectorLook);
        } else if (state.phase === "departing") {
          const destination = state.selected ? GATE_POSITIONS[state.selected] : GATE_POSITIONS.data;
          const progress = easeInOutCubic(clamp(phaseTime / 2.15));
          const destinationCamera = new THREE.Vector3(
            destination.x * 0.35 + (isMobile ? 1.8 : 2.7),
            isMobile ? 2.15 : 2.15,
            destination.z + (isMobile ? 4.6 : 4.4),
          );
          const destinationLook = new THREE.Vector3(destination.x, 1.05, destination.z);
          desiredPosition.copy(selectorPosition).lerp(destinationCamera, progress);
          desiredLook.copy(selectorLook).lerp(destinationLook, progress);
        } else if (state.phase === "transition") {
          const destination = state.selected ? GATE_POSITIONS[state.selected] : GATE_POSITIONS.data;
          const progress = easeOutCubic(clamp(phaseTime / 0.85));
          const near = new THREE.Vector3(
            destination.x * 0.45 + (isMobile ? 1.0 : 1.4),
            isMobile ? 1.8 : 1.75,
            destination.z + (isMobile ? 2.4 : 2.6),
          );
          desiredPosition.copy(
            new THREE.Vector3(
              destination.x * 0.35 + (isMobile ? 1.8 : 2.7),
              isMobile ? 2.15 : 2.15,
              destination.z + (isMobile ? 4.6 : 4.4),
            ),
          ).lerp(near, progress);
          desiredLook.set(destination.x, 1.25, destination.z);
        } else {
          desiredPosition.copy(closePosition);
          desiredLook.copy(closeLook);
        }

        const damping = 1 - Math.exp(-dt * (state.phase === "selecting" ? 2.4 : 3.6));
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
        const dt = Math.min(0.1, time - lastTime);
        lastTime = time;
        updateCharacter(dt, time);
        updateCamera(dt, time);
        particles.rotation.y += dt * 0.008;
        renderer?.render(scene as THREE.Scene, camera);
      }

      onResize = () => {
        if (disposed) return;
        const mobile = window.innerWidth < 760;
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer?.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobile ? 1.5 : 1.75));
        renderer?.setSize(window.innerWidth, window.innerHeight, false);
      };
      onVisibility = () => {
        lastTime = performance.now() / 1000;
      };
      window.addEventListener("resize", onResize);
      document.addEventListener("visibilitychange", onVisibility);

      controllerRef.current = {
        setPhase: (next, jump = false) => applyPhase(next, jump),
        jumpToSelecting: () => applyPhase("selecting", true),
        walkTo: (role) => {
          state.selected = role;
          applyPhase("departing");
        },
      };

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
      schedule(2250, () => setPhase("transition"));
      schedule(3050, () => complete(role));
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
          {phase !== "selecting" && phase !== "departing" ? (
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
        <div className="intro-depart" aria-live="polite">
          <p className="intro-kicker">DESTINATION LOCKED</p>
          <h2>Heading toward {role.fullLabel}.</h2>
          <p>Finding your next move. The dashboard will be ready when you arrive.</p>
          <span className="depart-line" aria-hidden />
        </div>
      ) : null}

      {phase === "transition" && role ? (
        <div className="intro-transition" aria-live="polite">
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
