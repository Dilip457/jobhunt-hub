"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { getRole } from "@/lib/roles";
import type { RoleSlug } from "@/lib/types";
import { prefetchRole } from "@/lib/prefetch";
import { ArrowRightIcon, PlayIcon, RefreshIcon, SparkIcon } from "./Icons";
import RoleDestinations from "./RoleDestinations";
import StaticIntro from "./StaticIntro";

type Phase = "loading" | "greeting" | "reveal" | "approach" | "selecting" | "departing" | "transition";

const MODEL_URL = "/models/student/student.glb";

const SELECTOR_Z = -3.4;
const WALK_SPEED = 1.5;
// The walk clip advances 1.8m of ground per 1s cycle at timeScale 1.
// Keeping this honest is what prevents the feet from sliding.
const WALK_CYCLE_DISTANCE = 1.8;
const TRAVEL_RAMP = 0.45;
// Turn in place before travelling. Rotating while stepping was the main
// source of the “moonwalk” feeling.
const TURN_DELAY = 0.55;
const GREETING_MS = 4000;
const REVEAL_SECONDS = 2.8;
const AUTO_ROTATE_SPEED = 0.18;
const AUTO_ROTATE_DELAY = 2.8;
const DRAG_SENSITIVITY = 0.0065;
const MAX_TURN_VELOCITY = 2.4;
// The runway is a real surface. The character stands on top of it rather
// than intersecting the markers.
const GROUND_Y = 0.014;
const DAIS_TOP = 0.04;

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

function renderPixelRatio(): number {
  const dpr = window.devicePixelRatio || 1;
  // Supersample 1x displays instead of accepting a soft canvas. Cap mobile
  // separately so high-density phones do not render a 4K frame buffer.
  if (window.innerWidth < 760) return Math.min(1.8, Math.max(1.35, dpr));
  return Math.min(2, Math.max(1.75, dpr));
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
  return TURN_DELAY + distance / WALK_SPEED + TRAVEL_RAMP;
}

function travelProfile(elapsed: number, distance: number) {
  const moveDuration = distance / WALK_SPEED + TRAVEL_RAMP;
  const total = TURN_DELAY + moveDuration;
  const t = clamp(elapsed - TURN_DELAY, 0, moveDuration);
  let covered = 0;
  let speed = 0;
  if (t < TRAVEL_RAMP) {
    const a = WALK_SPEED / TRAVEL_RAMP;
    covered = 0.5 * a * t * t;
    speed = a * t;
  } else if (t < moveDuration - TRAVEL_RAMP) {
    covered = WALK_SPEED * (t - TRAVEL_RAMP / 2);
    speed = WALK_SPEED;
  } else {
    const remaining = moveDuration - t;
    const a = WALK_SPEED / TRAVEL_RAMP;
    covered = distance - 0.5 * a * remaining * remaining;
    speed = a * remaining;
  }
  return {
    covered: clamp(covered, 0, distance),
    speed: elapsed < TURN_DELAY ? 0 : speed,
    total,
    done: elapsed >= total - 0.001,
  };
}

function createIdleClip(root: THREE.Object3D, walkClip: THREE.AnimationClip): THREE.AnimationClip {
  const sampleMixer = new THREE.AnimationMixer(root);
  const sampleAction = sampleMixer.clipAction(walkClip);
  sampleAction.play();

  // Average four evenly spaced walk poses to cancel the stride and arm swing.
  // Sampling a single walk frame left the character frozen mid-step whenever
  // the idle action took over.
  const bones: THREE.Bone[] = [];
  root.traverse((object) => {
    const bone = object as THREE.Bone;
    if (bone.isBone) bones.push(bone);
  });
  const sampleTimes = [0, 0.25, 0.5, 0.75].map((progress) => progress * walkClip.duration);
  const baseQuaternions = new Map<string, THREE.Quaternion>();
  const basePositions = new Map<string, THREE.Vector3>();
  const sampleQuat = new THREE.Quaternion();
  sampleTimes.forEach((sampleTime) => {
    sampleMixer.setTime(sampleTime);
    bones.forEach((bone) => {
      const accumulated = baseQuaternions.get(bone.name);
      if (!accumulated) {
        baseQuaternions.set(bone.name, bone.quaternion.clone());
      } else {
        if (accumulated.dot(bone.quaternion) < 0) {
          sampleQuat.set(
            -bone.quaternion.x,
            -bone.quaternion.y,
            -bone.quaternion.z,
            -bone.quaternion.w,
          );
        } else {
          sampleQuat.copy(bone.quaternion);
        }
        accumulated.set(
          accumulated.x + sampleQuat.x,
          accumulated.y + sampleQuat.y,
          accumulated.z + sampleQuat.z,
          accumulated.w + sampleQuat.w,
        );
      }

      const position = basePositions.get(bone.name);
      if (!position) {
        basePositions.set(bone.name, bone.position.clone());
      } else {
        position.add(bone.position);
      }
    });
  });
  baseQuaternions.forEach((quaternion) => quaternion.normalize());
  basePositions.forEach((position) => position.multiplyScalar(1 / sampleTimes.length));

  // A five-beat breathing cycle reads more naturally than the old three-frame
  // clip. The first and last frames are identical so the loop has no seam.
  const duration = 5.6;
  const frames = [0, 1.4, 2.8, 4.2, duration];
  const tracks: THREE.KeyframeTrack[] = [];
  const breathAxis = new THREE.Euler();
  const breathQuat = new THREE.Quaternion();

  function breathAt(time: number) {
    const phase = (time / duration) * Math.PI * 2;
    return {
      breath: 0.5 - 0.5 * Math.cos(phase),
      sway: Math.sin(phase),
    };
  }

  bones.forEach((bone) => {
    const base = baseQuaternions.get(bone.name);
    if (!base) return;
    const values: number[] = [];
    for (const time of frames) {
      const { breath, sway } = breathAt(time);
      const q = base.clone();
      if (bone.name === "Spine") {
        breathAxis.set(breath * 0.01, 0, sway * 0.004);
        breathQuat.setFromEuler(breathAxis);
        q.multiply(breathQuat);
      } else if (bone.name === "Spine01") {
        breathAxis.set(breath * 0.014, 0, sway * 0.003);
        breathQuat.setFromEuler(breathAxis);
        q.multiply(breathQuat);
      } else if (bone.name === "Spine02") {
        breathAxis.set(breath * 0.016, 0, sway * 0.002);
        breathQuat.setFromEuler(breathAxis);
        q.multiply(breathQuat);
      } else if (bone.name === "neck") {
        breathAxis.set(-breath * 0.004, sway * 0.006, 0);
        breathQuat.setFromEuler(breathAxis);
        q.multiply(breathQuat);
      } else if (bone.name === "Head") {
        breathAxis.set(-breath * 0.003, sway * 0.009, 0);
        breathQuat.setFromEuler(breathAxis);
        q.multiply(breathQuat);
      }
      values.push(q.x, q.y, q.z, q.w);
    }
    tracks.push(
      new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, frames, values),
    );
  });

  const hips = root.getObjectByName("Hips");
  if (hips) {
    const base = basePositions.get(hips.name) ?? hips.position.clone();
    const values = frames.flatMap((time) => {
      const { breath, sway } = breathAt(time);
      return [base.x + sway * 0.0012, base.y + breath * 0.003, base.z];
    });
    tracks.push(new THREE.VectorKeyframeTrack("Hips.position", frames, values));
  }

  sampleAction.stop();
  sampleMixer.uncacheRoot(root);
  return new THREE.AnimationClip("student-idle", duration, tracks);
}

// Model geometry is stored in normalized units (-1..1) mapped onto 0..1.8 m,
// so raw y converts to local/world y as (raw + 1) * 0.9 and raw x/z scale by
// 0.9. The values in these helpers were measured directly from the GLB
// position data so the shapes hug the real mesh instead of guessing.

// The raw mesh has a 5-ish cm band around the neck base where the head skin
// and the jacket collar interleave jaggedly (measured: red dips to raw y 0.633
// while the collar peaks at 0.695). Any overlay tall enough to cover that band
// reads as a turtleneck — the “jacket clubbed with neck” complaint. Instead,
// the collar vertices in this band are tinted with the face skin tone
// (#d99479) and feathered into the jacket, so the seam becomes a soft skin
// transition into the collar below raw y 0.618 without a material-group edge.
const NECK_SEAM_BAND = { y0: 0.618, y1: 0.718, halfWidth: 0.07 };

// The jacket front only parts in a shallow V under the collar, so a separate
// floating shirt mesh either hid behind the lapels or clipped through them.
// Instead the jacket's own vertices are tinted white inside that V. A material
// group split left a hard, triangular sawtooth edge that read as a tear in
// close-up; blending the tint per vertex keeps the shirt edge soft while the
// geometry still deforms with the rig. Raw-y bounds: a point at the sternum
// widening to the neck.
const TEE_V = { y0: 0.5, y1: 0.618, bottomHalfWidth: 0.012, topHalfWidth: 0.062 };
const TEE_FEATHER = 0.012;

// The source atlas is not a coherent garment layout: jacket triangles sample
// hair, skin and knit-top islands, which is what produced the brown seam
// “tears” and the dark flecks on the white top. Rather than keep chasing UVs,
// the body clothing gets clean stylized materials. Head, hands and shoes keep
// the original textured material so the face, hair, beard and skin detail stay.
// The upper body is rendered as a clean blue bomber with jeans in a lighter
// denim blue. The neck seam is feathered with a vertex skin tint (NECK_SEAM_BAND)
// so the collar reads as separate from the neck, and the jacket's V opening is
// tinted white for the t-shirt (TEE_V). Both boundaries blend per vertex, so
// they stay soft in close-up instead of following triangle edges.
function installCleanClothing(model: THREE.Object3D): void {
  model.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry as THREE.BufferGeometry;
    const position = geometry.getAttribute("position");
    const normal = geometry.getAttribute("normal");
    const jointIndex = geometry.getAttribute("skinIndex");
    const jointWeight = geometry.getAttribute("skinWeight");
    const source = geometry.getIndex();
    if (!position || !normal || !jointIndex || !jointWeight || !source) return;
    const skinned = mesh as THREE.SkinnedMesh;
    const bones = skinned.skeleton?.bones;
    if (!bones?.length) return;

    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const main = materials[0];
    if (!main) return;

    const boneNames = bones.map((bone: THREE.Bone) => bone.name.toLowerCase());
    const vertexGroup = new Uint8Array(position.count);
    for (let vertex = 0; vertex < position.count; vertex += 1) {
      let bestJoint = 0;
      let bestWeight = -1;
      for (let slot = 0; slot < 4; slot += 1) {
        const weight = jointWeight.getComponent(vertex, slot);
        if (weight > bestWeight) {
          bestWeight = weight;
          bestJoint = jointIndex.getComponent(vertex, slot);
        }
      }
      const name = boneNames[bestJoint] ?? "";
      if (name === "head" || name === "neck" || name === "head_end" || name === "headfront") {
        vertexGroup[vertex] = 1;
      } else if (name.includes("hand")) {
        vertexGroup[vertex] = 2;
      } else if (name.includes("foot") || name.includes("toe")) {
        vertexGroup[vertex] = 3;
      }
    }

    const groups: number[][] = [[], [], []];
    const original = source.array;
    const triangles = Math.floor(original.length / 3);
    for (let triangle = 0; triangle < triangles; triangle += 1) {
      const a = original[triangle * 3];
      const b = original[triangle * 3 + 1];
      const c = original[triangle * 3 + 2];
      const averageY = (position.getY(a) + position.getY(b) + position.getY(c)) / 3;
      if (averageY < -0.86) {
        // Keep the white sneakers on the original textured material. Some
        // upper triangles are weighted to the leg bones rather than the foot
        // bones, so bone groups alone are not enough here.
        groups[0].push(a, b, c);
        continue;
      }
      if (vertexGroup[a] !== 0 || vertexGroup[b] !== 0 || vertexGroup[c] !== 0) {
        groups[0].push(a, b, c);
        continue;
      }
      if (averageY < -0.01) {
        groups[2].push(a, b, c);
      } else {
        groups[1].push(a, b, c);
      }
    }
    if (groups[1].length + groups[2].length === 0) return;

    // Smooth white tee tint inside the V. The falloff is a few centimetres so
    // the neckline reads as fabric in shadow, not a paint boundary.
    const jacketColour = new THREE.Color(0x275285);
    const teeColour = new THREE.Color(0xf1efe7);
    const skinColour = new THREE.Color(0xd99479);
    const vertexColour = new THREE.Color();
    const colours = new Float32Array(position.count * 3);
    for (let vertex = 0; vertex < position.count; vertex += 1) {
      const x = position.getX(vertex);
      const y = position.getY(vertex);
      const z = position.getZ(vertex);
      const taper = clamp((y - TEE_V.y0) / (TEE_V.y1 - TEE_V.y0));
      const halfWidth =
        TEE_V.bottomHalfWidth + (TEE_V.topHalfWidth - TEE_V.bottomHalfWidth) * taper;
      const across = smoothstep(clamp((halfWidth - Math.abs(x)) / TEE_FEATHER));
      const top = smoothstep(clamp((TEE_V.y1 - y) / 0.008));
      const bottom = smoothstep(clamp((y - TEE_V.y0) / 0.008));
      const front = z > 0.003 ? 1 : 0;
      const teeMask = across * top * bottom * front;

      // The neck band replaces the old flat-skin material group. Painting the
      // collar vertices skin and feathering into the jacket removes the hard
      // pink sawtooth that material boundaries left at the collar.
      const skinAcross = smoothstep(
        clamp((NECK_SEAM_BAND.halfWidth - Math.abs(x)) / 0.005),
      );
      const skinBottom = smoothstep(
        clamp((y - (NECK_SEAM_BAND.y0 - 0.006)) / 0.006),
      );
      const skinTop = smoothstep(clamp((NECK_SEAM_BAND.y1 - y) / 0.006));
      const skinFront = z > -0.005 ? 1 : 0;
      const skinMask = skinAcross * skinBottom * skinTop * skinFront;

      vertexColour
        .copy(jacketColour)
        .lerp(teeColour, teeMask)
        .lerp(skinColour, skinMask);
      vertexColour.toArray(colours, vertex * 3);
    }
    geometry.setAttribute("color", new THREE.BufferAttribute(colours, 3));

    const index = new Uint32Array(original.length);
    let cursor = 0;
    const starts: number[] = [];
    const counts: number[] = [];
    groups.forEach((group) => {
      starts.push(cursor);
      counts.push(group.length);
      index.set(group, cursor);
      cursor += group.length;
    });

    const jacket = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.88,
      metalness: 0,
      envMapIntensity: 0.35,
      side: THREE.DoubleSide,
      dithering: true,
    });
    const pants = new THREE.MeshStandardMaterial({
      color: 0x3f699c,
      roughness: 0.92,
      metalness: 0,
      envMapIntensity: 0.3,
      side: THREE.DoubleSide,
      dithering: true,
    });
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    geometry.clearGroups();
    groups.forEach((group, groupIndex) => {
      if (group.length > 0) geometry.addGroup(starts[groupIndex], counts[groupIndex], groupIndex);
    });
    mesh.material = [main, jacket, pants];
  });
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
  // Always start at the boot/loading frame. A returning-visitor shortcut used
  // to jump straight to the selector before the scene was ready, which showed
  // the poster close-up and role cards at the same time. The greeting now runs
  // once per page load; “Skip intro” remains available for returning visitors.
  const [phase, setPhase] = useState<Phase>("loading");
  const [selected, setSelected] = useState<RoleSlug | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [autoRotate, setAutoRotate] = useState(false);
  const autoRotateRef = useRef(false);

  useEffect(() => {
    autoRotateRef.current = autoRotate;
  }, [autoRotate]);

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

  const complete = useCallback(
    (role: RoleSlug) => {
      if (completeRef.current) return;
      completeRef.current = true;
      void prefetchRole(role);
      if (onComplete) onComplete(role);
      else router.push(`/jobs/${role}`);
    },
    [onComplete, router],
  );

  const skipToRoles = useCallback(() => {
    clearTimers();
    setPhase("selecting");
    controllerRef.current?.jumpToSelecting();
  }, [clearTimers]);

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
  }, [reduced]);

  // Start each hold after the phase has actually committed. Previously the
  // 4s greeting timer started before the first painted frame, so a slow
  // shader/frame budget could make “HI.” disappear after ~1s.
  useEffect(() => {
    if (phase === "greeting") {
      const timer = window.setTimeout(() => setPhase("reveal"), GREETING_MS);
      return () => window.clearTimeout(timer);
    }
    if (phase === "reveal") {
      const timer = window.setTimeout(() => setPhase("approach"), REVEAL_SECONDS * 1000);
      return () => window.clearTimeout(timer);
    }
    if (phase === "approach") {
      const approachSeconds = travelDuration(Math.abs(SELECTOR_Z)) + 0.95;
      const timer = window.setTimeout(() => setPhase("selecting"), approachSeconds * 1000);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [phase]);

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
      const canvasEl = canvas;

      const isMobile = window.innerWidth < 760;
      THREE.ColorManagement.enabled = true;

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

      renderer.setPixelRatio(renderPixelRatio());
      renderer.setSize(window.innerWidth, window.innerHeight, false);
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = isMobile ? 0.94 : 0.98;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      // Desktop gets a soft cast shadow. Mobile keeps the cheaper painted
      // contact shadow so high-DPI phones do not pay for a second scene pass.
      renderer.shadowMap.enabled = !isMobile;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;

      scene = new THREE.Scene();
      scene.background = new THREE.Color(0x05060a);
      scene.fog = new THREE.FogExp2(0x05060a, isMobile ? 0.034 : 0.029);

      const camera = new THREE.PerspectiveCamera(34, window.innerWidth / window.innerHeight, 0.04, 120);
      try {
        pmrem = new THREE.PMREMGenerator(renderer);
        const room = new RoomEnvironment();
        envTarget = pmrem.fromScene(room, 0.04);
        scene.environment = envTarget.texture;
        scene.environmentIntensity = isMobile ? 0.32 : 0.48;
        room.dispose?.();
        pmrem.dispose();
        pmrem = null;
      } catch {
        // Environment reflections are a nice-to-have.
      }

      scene.add(new THREE.HemisphereLight(0xa8bbff, 0x08090d, isMobile ? 0.78 : 0.9));
      // Neutral key + soft fill keep the skin clean. The red/blue accents are
      // now behind the character as rim lights instead of tinting the face.
      const key = new THREE.DirectionalLight(0xfff2e8, isMobile ? 1.25 : 1.32);
      key.position.set(-2.5, 4.5, 4.5);
      if (!isMobile) {
        key.castShadow = true;
        key.shadow.mapSize.set(2048, 2048);
        key.shadow.camera.left = -12;
        key.shadow.camera.right = 12;
        key.shadow.camera.top = 12;
        key.shadow.camera.bottom = -4;
        key.shadow.camera.near = 0.5;
        key.shadow.camera.far = 26;
        key.shadow.bias = -0.0004;
        key.shadow.normalBias = 0.02;
        key.shadow.radius = 3.5;
        key.shadow.camera.updateProjectionMatrix();
      }
      scene.add(key);
      scene.add(key.target);
      const frontFill = new THREE.DirectionalLight(0xfff6f0, isMobile ? 0.8 : 0.98);
      frontFill.position.set(0, 2.1, 5.2);
      scene.add(frontFill);
      const rim = new THREE.DirectionalLight(0x6f9bff, 0.95);
      rim.position.set(2.2, 3.2, -3.8);
      scene.add(rim);
      const fill = new THREE.DirectionalLight(0xffe4d8, isMobile ? 0.85 : 1.02);
      fill.position.set(2.2, 2.4, 3.8);
      scene.add(fill);
      const redLight = new THREE.PointLight(0xff304f, 7, 8, 2);
      redLight.position.set(-3.2, 1.5, -1.8);
      scene.add(redLight);
      const blueLight = new THREE.PointLight(0x287bff, 7, 8, 2);
      blueLight.position.set(3.2, 1.5, -1.8);
      scene.add(blueLight);
      // This fill follows the guide so the face stays readable in both the
      // close greeting and the selection stage. A fixed world-space fill was
      // left behind when the character walked to the selector, which made the
      // face look muddy at exactly the point users need to inspect it.
      const faceFill = new THREE.PointLight(0xffeadf, isMobile ? 0.5 : 0.6, 4.2, 2);
      faceFill.position.set(0.28, 1.72, 1.55);
      scene.add(faceFill);

      const floorMaterial = new THREE.MeshStandardMaterial({
        color: 0x04050a,
        roughness: 0.78,
        metalness: 0.12,
        envMapIntensity: 0.36,
      });
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), floorMaterial);
      floor.rotation.x = -Math.PI / 2;
      floor.receiveShadow = !isMobile;
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
        roughness: 0.68,
        metalness: 0.16,
        envMapIntensity: 0.4,
      });
      // Thin, flush runway. The old 35mm slab was high enough to swallow the
      // shoe soles and the emissive markers.
      const runway = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.012, 20), pathMaterial);
      runway.position.set(0, 0, -8.2);
      runway.receiveShadow = !isMobile;
      path.add(runway);

      const curbMaterial = new THREE.MeshStandardMaterial({
        color: 0x0b0e16,
        roughness: 0.35,
        metalness: 0.6,
      });
      [-1.48, 1.48].forEach((x) => {
        const curb = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.012, 20), curbMaterial);
        curb.position.set(x, 0.006, -8.2);
        path.add(curb);
      });

      // The two 20m emissive edge strips read as laser beams in the wide
      // shot and crossed the character's feet. The gates already carry the
      // red/blue/white colour language, so the runway stays neutral.
      const markers: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>[] = [];
      for (let index = 0; index < 26; index += 1) {
        const markerMaterial = new THREE.MeshStandardMaterial({
          color: 0x0b1020,
          emissive: 0x1d4d8a,
          emissiveIntensity: 0.25,
          roughness: 0.3,
          metalness: 0.4,
        });
        const marker = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.006, 0.06), markerMaterial);
        marker.position.set(0, 0.004, 1.0 - index * 0.62);
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
        // Human-scaled destinations. The first pass made 4m arches dominate the
        // 1.8m character and read like a game level.
        group.scale.setScalar(0.86);
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

        const dais = new THREE.Mesh(new THREE.CylinderGeometry(1.85, 2.0, 0.04, 40), frameMaterial);
        dais.position.y = 0.02;
        group.add(dais);
        const daisRing = new THREE.Mesh(
          new THREE.TorusGeometry(1.72, 0.028, 8, 56),
          stripMaterial.clone(),
        );
        daisRing.rotation.x = Math.PI / 2;
        daisRing.position.y = 0.045;
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
        glow.position.y = 0.052;
        glow.visible = false;
        group.add(glow);

        gates.push({ role, group, strips, ring, light, glow });
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
        new THREE.PlaneGeometry(1.78, 1.78),
        new THREE.MeshBasicMaterial({
          map: shadowTexture,
          transparent: true,
          depthWrite: false,
          opacity: isMobile ? 0.72 : 0.48,
        }),
      );
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.y = 0.006;
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
      const anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
      model.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.frustumCulled = false;
        mesh.castShadow = !isMobile;
        mesh.receiveShadow = !isMobile;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        materials.forEach((material) => {
          if (!material) return;
          const standard = material as THREE.MeshStandardMaterial;
          // The source roughness/metalness map contains tiny high-gloss
          // patches that aliased into white “paint flecks” on the hair and
          // jacket. A higher uniform roughness plus reduced normal strength
          // keeps the face and fabric matte instead of hard and contrasty.
          standard.envMapIntensity = 0.42;
          standard.metalness = 0;
          standard.metalnessMap = null;
          standard.roughness = 0.86;
          standard.roughnessMap = null;
          standard.dithering = true;
          if (standard.normalMap) standard.normalScale.set(0.38, 0.38);
          Object.entries(standard).forEach(([key, value]) => {
            if (!(value instanceof THREE.Texture)) return;
            value.anisotropy = anisotropy;
            value.minFilter = THREE.LinearMipmapLinearFilter;
            value.magFilter = THREE.LinearFilter;
            value.generateMipmaps = true;
            value.colorSpace =
              key === "map" || key === "emissiveMap"
                ? THREE.SRGBColorSpace
                : THREE.NoColorSpace;
            value.needsUpdate = true;
          });
          standard.needsUpdate = true;
        });
      });

      installCleanClothing(model);

      // Centre the model on its own feet before adding the turntable. Animation
      // still targets the skeleton; this root transform only affects framing.
      const bounds = new THREE.Box3().setFromObject(model);
      const centre = bounds.getCenter(new THREE.Vector3());
      model.position.x -= centre.x;
      model.position.z -= centre.z;
      model.position.y -= bounds.min.y;

      const turntable = new THREE.Group();
      turntable.name = "student-turntable";
      turntable.add(model);
      const character = new THREE.Group();
      character.position.y = GROUND_Y;
      character.add(turntable);
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

      const closePosition = new THREE.Vector3(0, 1.56, isMobile ? 1.7 : 1.52);
      const closeLook = new THREE.Vector3(0, 1.43, 0);
      const widePosition = new THREE.Vector3(0.35, isMobile ? 2.1 : 2.0, isMobile ? 7.4 : 6.6);
      const wideLook = new THREE.Vector3(0.05, 1.0, -2.2);
      // The selection camera is a closer stage shot: the guide is large enough
      // to read the face and fabric without losing the three destinations.
      // Previous framing left the character at roughly 300px tall on a 900px
      // viewport, which made even the 1K atlas look soft.
      const selectorPosition = new THREE.Vector3(
        isMobile ? 1.25 : 1.45,
        isMobile ? 2.5 : 1.92,
        isMobile ? 4.1 : 1.0,
      );
      const selectorLook = new THREE.Vector3(
        isMobile ? 0.25 : 0.75,
        isMobile ? 0.35 : 0.52,
        isMobile ? SELECTOR_Z - 0.8 : SELECTOR_Z - 0.4,
      );
      const faceCameraAngle = Math.atan2(selectorPosition.x, selectorPosition.z - SELECTOR_Z);

      const desiredPosition = widePosition.clone();
      const desiredLook = wideLook.clone();
      const currentLook = closeLook.clone();
      const tempVector = new THREE.Vector3();
      const tempLook = new THREE.Vector3();

      let turntableYaw = 0;
      let turntableVelocity = 0;
      let dragging = false;
      let activePointerId: number | null = null;
      let lastPointerX = 0;
      let lastPointerTime = 0;
      let lastInteractionTime = performance.now() / 1000;

      function stopDragging() {
        if (activePointerId !== null && canvasEl.hasPointerCapture(activePointerId)) {
          canvasEl.releasePointerCapture(activePointerId);
        }
        activePointerId = null;
        dragging = false;
        canvasEl.classList.remove("is-dragging");
      }

      function onPointerDown(event: PointerEvent) {
        if (state.phase !== "selecting") return;
        if (event.pointerType === "mouse" && event.button !== 0) return;
        if (dragging) return;

        dragging = true;
        activePointerId = event.pointerId;
        lastPointerX = event.clientX;
        lastPointerTime = performance.now() / 1000;
        lastInteractionTime = lastPointerTime;
        turntableVelocity = 0;
        canvasEl.setPointerCapture(event.pointerId);
        canvasEl.classList.add("is-dragging");
        event.preventDefault();
      }

      function onPointerMove(event: PointerEvent) {
        if (!dragging || event.pointerId !== activePointerId) return;
        if (state.phase !== "selecting") {
          stopDragging();
          return;
        }

        const now = performance.now() / 1000;
        const elapsed = Math.max(0.008, now - lastPointerTime);
        const deltaX = event.clientX - lastPointerX;
        turntableYaw += deltaX * DRAG_SENSITIVITY;
        turntableVelocity = clamp(
          (deltaX * DRAG_SENSITIVITY) / elapsed,
          -MAX_TURN_VELOCITY,
          MAX_TURN_VELOCITY,
        );
        lastPointerX = event.clientX;
        lastPointerTime = now;
        lastInteractionTime = now;
        event.preventDefault();
      }

      function onPointerUp(event: PointerEvent) {
        if (event.pointerId !== activePointerId) return;
        lastInteractionTime = performance.now() / 1000;
        stopDragging();
        event.preventDefault();
      }

      function updateTurntable(dt: number, time: number) {
        if (state.phase !== "selecting") {
          if (dragging || activePointerId !== null) stopDragging();
          turntableVelocity = 0;
          turntableYaw = dampAngle(turntableYaw, 0, dt, 8);
        } else {
          if (!dragging) {
            turntableYaw += turntableVelocity * dt;
            turntableVelocity *= Math.exp(-dt * 5.5);
            if (Math.abs(turntableVelocity) < 0.01) turntableVelocity = 0;
            if (autoRotateRef.current && time - lastInteractionTime > AUTO_ROTATE_DELAY) {
              turntableYaw += AUTO_ROTATE_SPEED * dt;
            }
          }
          turntableYaw =
            THREE.MathUtils.euclideanModulo(turntableYaw + Math.PI, Math.PI * 2) - Math.PI;
        }
        turntable.rotation.y = turntableYaw;
      }

      function applyPhase(next: Phase, jump = false) {
        // React and the scene controller can both report the same transition.
        // Do not restart the phase clock on the duplicate call.
        if (next === state.phase && !jump) return;
        const previous = state.phase;
        state.phase = next;
        state.phaseStart = performance.now() / 1000 - (jump ? 10 : 0);
        if (next === "approach" || next === "departing") {
          // Start every journey from the neutral frame so the walk never
          // fades in halfway through a stride.
          walkAction.time = 0;
          mixer.update(0);
        }
        if (next === "greeting" || next === "reveal") {
          character.position.set(0, GROUND_Y, 0);
          character.rotation.y = 0;
          state.walkBlend = 0;
        } else if (next === "approach") {
          character.position.set(0, GROUND_Y, 0);
          character.rotation.y = 0;
          state.walkBlend = 0;
        } else if (next === "selecting") {
          character.position.set(0, GROUND_Y, SELECTOR_Z);
          character.rotation.y = faceCameraAngle;
          state.walkBlend = 0;
          lastInteractionTime = performance.now() / 1000;
          if (jump) {
            turntableYaw = 0;
            turntableVelocity = 0;
            camera.position.copy(selectorPosition);
            currentLook.copy(selectorLook);
            camera.lookAt(currentLook);
          }
        } else if (next === "departing" && previous !== "departing") {
          character.position.set(0, GROUND_Y, SELECTOR_Z);
          state.walkBlend = 0;
        } else if (next === "transition") {
          const destination = state.selected ? GATE_POSITIONS[state.selected] : GATE_POSITIONS.data;
          character.position.set(destination.x, DAIS_TOP, destination.z);
          state.walkBlend = 0;
        }
        if (next !== "selecting") {
          stopDragging();
          turntableVelocity = 0;
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

      function updateCharacter(dt: number) {
        const phaseTime = performance.now() / 1000 - state.phaseStart;
        let moving = false;
        let speed = 0;

        if (state.phase === "approach") {
          const travel = travelProfile(phaseTime, Math.abs(SELECTOR_Z));
          character.position.y = GROUND_Y;
          character.position.z = -travel.covered;
          moving = travel.speed > 0.02 && !travel.done;
          speed = travel.speed;
          const turn = easeInOutCubic(clamp(phaseTime / TURN_DELAY));
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
          character.position.y = lerp(
            GROUND_Y,
            DAIS_TOP,
            smoothstep(clamp((ratio - 0.82) / 0.18)),
          );
          moving = travel.speed > 0.02 && !travel.done;
          speed = travel.speed;
          const targetAngle = Math.atan2(destination.x, destination.z - SELECTOR_Z);
          const turn = easeInOutCubic(clamp(phaseTime / TURN_DELAY));
          character.rotation.y = lerpAngle(faceCameraAngle, targetAngle, turn);
        } else if (state.phase === "selecting") {
          character.position.set(0, GROUND_Y, SELECTOR_Z);
          character.rotation.y = faceCameraAngle;
        } else if (state.phase === "transition") {
          const destination = state.selected ? GATE_POSITIONS[state.selected] : GATE_POSITIONS.data;
          character.position.set(destination.x, DAIS_TOP, destination.z);
          const targetAngle = Math.atan2(destination.x, destination.z - SELECTOR_Z);
          character.rotation.y = dampAngle(character.rotation.y, targetAngle, dt, 7);
        }

        state.speed = speed;
        const targetBlend = moving ? 1 : 0;
        state.walkBlend = lerp(state.walkBlend, targetBlend, 1 - Math.exp(-dt * 8));
        walkAction.setEffectiveWeight(state.walkBlend);
        idleAction.setEffectiveWeight(1 - state.walkBlend);
        walkAction.timeScale = clamp(speed / WALK_CYCLE_DISTANCE, 0.04, 1.2);
        mixer.update(dt);

        shadow.position.x = character.position.x;
        shadow.position.z = character.position.z;
        faceFill.position.set(
          character.position.x + 0.28,
          character.position.y + 1.72,
          character.position.z + 1.55,
        );

        const pathProgress = character.position.z;
        markers.forEach((marker) => {
          const distance = Math.abs(marker.position.z - pathProgress);
          const active = Math.max(0, 1 - distance / 1.4);
          marker.material.emissiveIntensity = 0.12 + active * 0.9;
          marker.material.emissive.setHex(active > 0.2 ? 0x287bff : 0x17396b);
        });

        gates.forEach((gate) => {
          // The opening portrait belongs to the character. The destinations
          // appear with the pullback and ease up to full size instead of
          // popping into the close-up at full scale.
          gate.group.visible = state.phase !== "greeting";
          const revealIn =
            state.phase === "reveal"
              ? 0.72 + 0.28 * smoothstep(clamp(phaseTime / 0.8))
              : 1;
          gate.group.scale.setScalar(0.86 * revealIn);
          const isSelected = state.selected === gate.role;
          const active = isSelected && (state.phase === "departing" || state.phase === "transition");
          const preparing = state.phase === "selecting";
          gate.strips.forEach((strip) => {
            strip.material.emissiveIntensity = active ? 1.7 : preparing ? (isSelected ? 1.3 : 0.36) : 0.24;
          });
          gate.ring.material.emissiveIntensity = active ? 1.5 : preparing ? (isSelected ? 1.0 : 0.3) : 0.2;
          gate.light.intensity = active ? 3.4 : preparing ? (isSelected ? 0.95 : 0.38) : 0.28;
          gate.glow.material.opacity = active ? 0.13 : preparing ? (isSelected ? 0.07 : 0.026) : 0.016;
          gate.ring.rotation.z += dt * (active ? 0.4 : 0.12);
        });
      }

      function updateCamera(dt: number, time: number) {
        const phaseTime = time - state.phaseStart;
        if (state.phase === "greeting") {
          const hold = smoothstep(clamp(phaseTime / (GREETING_MS / 1000)));
          desiredPosition.copy(closePosition);
          desiredPosition.z += 0.035 * (1 - hold);
          desiredPosition.z -= Math.sin(time * 0.5) * 0.003;
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
          desiredPosition.x += Math.sin(time * 0.22) * 0.022;
          desiredPosition.y += Math.sin(time * 0.3) * 0.012;
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
        updateCharacter(dt);
        updateTurntable(dt, time);
        updateCamera(dt, time);
        renderer?.render(scene as THREE.Scene, camera);
      }

      function onResize() {
        if (disposed) return;
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer?.setPixelRatio(renderPixelRatio());
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
      window.addEventListener("blur", stopDragging);
      document.addEventListener("visibilitychange", onVisibility);
      canvasEl.addEventListener("webglcontextlost", onContextLost);
      canvasEl.addEventListener("pointerdown", onPointerDown);
      canvasEl.addEventListener("pointermove", onPointerMove);
      canvasEl.addEventListener("pointerup", onPointerUp);
      canvasEl.addEventListener("pointercancel", onPointerUp);
      cleanupListeners = () => {
        stopDragging();
        window.removeEventListener("resize", onResize);
        window.removeEventListener("blur", stopDragging);
        document.removeEventListener("visibilitychange", onVisibility);
        canvasEl.removeEventListener("webglcontextlost", onContextLost);
        canvasEl.removeEventListener("pointerdown", onPointerDown);
        canvasEl.removeEventListener("pointermove", onPointerMove);
        canvasEl.removeEventListener("pointerup", onPointerUp);
        canvasEl.removeEventListener("pointercancel", onPointerUp);
      };

      controllerRef.current = {
        setPhase: (next, jump = false) => applyPhase(next, jump),
        jumpToSelecting: () => applyPhase("selecting", true),
        walkTo: (role) => {
          state.selected = role;
          applyPhase("departing");
        },
      };

      if (scene) {
        try {
          await renderer.compileAsync(scene, camera);
        } catch {
          // compileAsync is an optimisation; the first render is still valid.
        }
      }
      if (disposed) return;
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
      void prefetchRole(role);
      router.push(`/jobs/${role}`);
    },
    [router],
  );

  if (reduced || failed) {
    return <StaticIntro onSelect={handleStaticSelect} reduced={reduced} />;
  }

  const role = selected ? getRole(selected) : null;

  return (
    <main className={`cinematic-intro phase-${phase}`}>
      <div className="intro-poster" aria-hidden />
      <canvas
        ref={canvasRef}
        className={`intro-canvas ${ready ? "is-ready" : ""} ${phase === "selecting" ? "is-interactive" : ""}`}
        aria-hidden
      />

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
          ) : phase !== "selecting" && phase !== "loading" ? (
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
            <button
              type="button"
              className="intro-rotate-toggle"
              aria-pressed={autoRotate}
              aria-label="Toggle automatic character rotation"
              onClick={() => setAutoRotate((current) => !current)}
            >
              <RefreshIcon width={12} height={12} />
              {autoRotate ? "Auto-rotate on" : "Auto-rotate off"}
            </button>
          </div>
          <RoleDestinations onSelect={handleSelect} selected={selected} />
          <p className="intro-footnote">
            <span className="status-dot" />
            Drag the guide to rotate · Real listings only · Updated daily
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
