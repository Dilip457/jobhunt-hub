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

// The stock walk clip plants the feet about 33 cm apart, which reads as a
// waddle. The legs are adducted — rotated inward about the forward axis — to
// bring the feet under the body. The angle is deliberately small: adduction
// tilts the whole leg inward from the hip, so pushing it far enough to get the
// feet really close (the first attempt used 10 degrees, ~12 cm) made the legs
// converge and twist, which read as a curvy, feminine gait. Four degrees keeps
// them parallel and vertical at ~25 cm, a straight, settled male walk. Standing
// wants a touch narrower, so the idle is sampled from a 6 degree copy.
const WALK_ADDUCTION = -4 * (Math.PI / 180);
const IDLE_ADDUCTION = -6 * (Math.PI / 180);
// The relaxed standing hands come out of the clip with the palms facing
// forward, which reads as a mannequin showing its palms. Twisting each wrist
// about its own axis turns the palms to face the thighs, the way a man stands.
const HAND_TWIST = 45 * (Math.PI / 180);
function adductWalkClip(clip: THREE.AnimationClip, angle: number): void {
  const forward = new THREE.Vector3(0, 0, 1);
  const correction = new THREE.Quaternion();
  const quaternion = new THREE.Quaternion();
  for (const track of clip.tracks) {
    const match = /(Left|Right)UpLeg\.quaternion$/.exec(track.name);
    if (!match) continue;
    correction.setFromAxisAngle(forward, (match[1] === "Left" ? 1 : -1) * angle);
    for (let i = 0; i < track.values.length; i += 4) {
      quaternion.fromArray(track.values, i);
      quaternion.premultiply(correction);
      quaternion.toArray(track.values, i);
    }
  }
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
  const firstQuaternions = new Map<string, THREE.Quaternion>();
  const basePositions = new Map<string, THREE.Vector3>();
  const sampleQuat = new THREE.Quaternion();
  sampleTimes.forEach((sampleTime) => {
    sampleMixer.setTime(sampleTime);
    bones.forEach((bone) => {
      const accumulated = baseQuaternions.get(bone.name);
      if (!accumulated) {
        baseQuaternions.set(bone.name, bone.quaternion.clone());
        firstQuaternions.set(bone.name, bone.quaternion.clone());
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
  // The wrists and fingers pass through very different poses across the walk
  // cycle, so averaging them collapses the hand into a splayed, palm-forward
  // shape that reads as a mannequin's. They keep the first sampled pose — a
  // relaxed hanging hand — while every other bone takes the average.
  const handTwist = new THREE.Quaternion();
  const handAxis = new THREE.Vector3(0, 1, 0);
  baseQuaternions.forEach((quaternion, name) => {
    if (/Hand/.test(name)) {
      const first = firstQuaternions.get(name);
      if (!first) return;
      quaternion.copy(first);
      handTwist.setFromAxisAngle(handAxis, name.startsWith("Left") ? HAND_TWIST : -HAND_TWIST);
      quaternion.multiply(handTwist);
    } else {
      quaternion.normalize();
    }
  });
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

// The head, hair and neck keep the original textured material, but the neck's
// bottom edge meets the jacket collar along a jagged, interleaved seam: the two
// material groups weave in and out over roughly five centimetres, and the neck
// triangles there sample dark islands of the scrambled atlas, so the seam read
// as black spikes under the jaw. Neck and collar are both skin, so the seam is
// hidden by painting the whole band with the flat skin tone (#d99479). That
// paint is evaluated per fragment and applied to the textured material as well
// as to the jacket, so it covers the dark spikes and the boundary between the
// two materials disappears instead of stepping. The old per-vertex tint could
// only change at the collar's coarse vertices and left a blotchy patch.
const SKIN_BAND = { y0: 0.605, y1: 0.72, halfWidth: 0.076 };

// The jacket is modelled closed, so the t-shirt cannot be revealed by opening
// it: the shirt is painted onto the jacket's own front surface instead, as a
// full panel from the collar down to the jacket hem, with its sides where the
// jacket's front edges are. Raw-y bounds: hem to collar.
//
// The mask is evaluated per fragment, not per vertex. The chest is coarse — a
// handful of very large triangles — so a per-vertex mask could only change at
// those vertices, and the rasteriser then blended it linearly across each huge
// triangle. The shirt came out as a soft, ragged starburst that read as “half
// painted”. Rebuilding the panel in the fragment shader, from the bind-pose
// position, gives an edge that is crisp at any zoom while still deforming with
// the rig, because the mask lives in bind space and rides the skin transform.
const TEE_V = { y0: 0.04, y1: 0.648, bottomHalfWidth: 0.084, topHalfWidth: 0.080 };
// The t-shirt neckline rises from a shallow dip at the sternum up to the
// shoulders instead of a flat cut straight across the chest.
const TEE_NECK_DROP = 0.042;
// The shirt only faces the camera on the front of the torso, so the mask is
// limited to the forward half of the bind-pose depth. Without it the same x/y
// window also catches the back and paints a matching white panel between the
// shoulder blades, which the character shows the moment it turns to walk
// toward the role gates. The threshold sits at zero rather than higher so the
// jacket's front-facing folded edges, exposed at the sides of the collar, still
// read as shirt instead of leaving blue gaps in the white.
const TEE_FACING = { z0: 0.0, z1: 0.02 };

// The source atlas is not a coherent garment layout: jacket triangles sample
// hair, skin and knit-top islands, which is what produced the brown seam
// “tears” and the dark flecks on the white top. Rather than keep chasing UVs,
// the body clothing gets clean stylized materials. Head, hands and shoes keep
// the original textured material so the face, hair, beard and skin detail stay.
// The upper body is rendered as a clean blue bomber with navy jeans. The white
// t-shirt (TEE_V) and the skin collar band (SKIN_BAND) are both painted in the
// fragment shader — on the textured material as well as on the jacket — so
// their edges stay crisp at any zoom instead of following the coarse triangle
// edges the way a per-vertex tint did.
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

    const jacketColour = new THREE.Color(0x275285);
    const vertexColour = new THREE.Color();
    const colours = new Float32Array(position.count * 3);
    for (let vertex = 0; vertex < position.count; vertex += 1) {
      // Jacket base only. The skin collar and the tee are both painted in the
      // fragment shader below, so nothing here needs to know about them.
      vertexColour.copy(jacketColour);
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
    // The tee mask, evaluated per fragment. The bind-pose position and normal
    // are carried to the fragment stage and the V is rebuilt there, so the
    // neckline is antialiased against the real pixel footprint (fwidth) rather
    // than against the mesh's triangle size. Nothing else about the material
    // changes: the jacket base and skin collar still arrive as vertex colours.
    const teeUniforms = {
      uTeeBounds: {
        value: new THREE.Vector4(
          TEE_V.y0,
          TEE_V.y1,
          TEE_V.bottomHalfWidth,
          TEE_V.topHalfWidth,
        ),
      },
      uTeeFacing: { value: new THREE.Vector2(TEE_FACING.z0, TEE_FACING.z1) },
      uTeeNeck: { value: TEE_NECK_DROP },
      uTeeColour: { value: new THREE.Color(0xffffff) },
      uSkinBounds: {
        value: new THREE.Vector3(SKIN_BAND.y0, SKIN_BAND.y1, SKIN_BAND.halfWidth),
      },
      uSkinColour: { value: new THREE.Color(0xd99479) },
    };
    jacket.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, teeUniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          "#include <common>\nvarying vec3 vTeePos;",
        )
        .replace("#include <begin_vertex>", "#include <begin_vertex>\n\tvTeePos = position;");
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          [
            "#include <common>",
            "varying vec3 vTeePos;",
            "uniform vec4 uTeeBounds;",
            "uniform vec2 uTeeFacing;",
            "uniform float uTeeNeck;",
            "uniform vec3 uTeeColour;",
            "uniform vec3 uSkinBounds;",
            "uniform vec3 uSkinColour;",
          ].join("\n"),
        )
        .replace(
          "#include <color_fragment>",
          [
            "#include <color_fragment>",
            "{",
            "\tfloat teeY0 = uTeeBounds.x;",
            "\tfloat teeY1 = uTeeBounds.y;",
            "\tfloat teeTaper = clamp((vTeePos.y - teeY0) / max(teeY1 - teeY0, 1e-4), 0.0, 1.0);",
            "\tfloat teeHalf = mix(uTeeBounds.z, uTeeBounds.w, teeTaper);",
            "\tfloat teeAAx = max(fwidth(vTeePos.x), 1e-4);",
            "\tfloat teeAAy = max(fwidth(vTeePos.y), 1e-4);",
            "\tfloat teeAcross = 1.0 - smoothstep(teeHalf - teeAAx, teeHalf + teeAAx, abs(vTeePos.x));",
            "\tfloat teeNeck = teeY1 - uTeeNeck * (1.0 - clamp(abs(vTeePos.x) / max(teeHalf, 1e-4), 0.0, 1.0));",
            "\tfloat teeTop = 1.0 - smoothstep(teeNeck - teeAAy, teeNeck + teeAAy, vTeePos.y);",
            "\tfloat teeBottom = smoothstep(teeY0 - teeAAy, teeY0 + teeAAy, vTeePos.y);",
            "\tfloat teeFacing = smoothstep(uTeeFacing.x, uTeeFacing.x + uTeeFacing.y, vTeePos.z);",
            "\tfloat teeMask = teeAcross * teeTop * teeBottom * teeFacing;",
            "\tfloat skinAcross = 1.0 - smoothstep(uSkinBounds.z - teeAAx, uSkinBounds.z + teeAAx, abs(vTeePos.x));",
            "\tfloat skinBottom = smoothstep(uSkinBounds.x - teeAAy, uSkinBounds.x + teeAAy, vTeePos.y);",
            "\tfloat skinTop = 1.0 - smoothstep(uSkinBounds.y - teeAAy, uSkinBounds.y + teeAAy, vTeePos.y);",
            "\tfloat skinFront = smoothstep(-0.07, 0.0, vTeePos.z);",
            "\tfloat skinMask = skinAcross * skinBottom * skinTop * skinFront;",
            "\tdiffuseColor.rgb = mix(diffuseColor.rgb, uSkinColour, skinMask);",
            "\tdiffuseColor.rgb = mix(diffuseColor.rgb, uTeeColour, teeMask);",
            "}",
          ].join("\n"),
        );
    };
    jacket.customProgramCacheKey = () => "body-mask";
    const pants = new THREE.MeshStandardMaterial({
      color: 0x1b2b4a,
      roughness: 0.94,
      metalness: 0,
      envMapIntensity: 0.25,
      side: THREE.DoubleSide,
      dithering: true,
    });
    // The masks are installed on every body material, not just the jacket. The
    // collar band has to cover the neck's textured triangles, which land in the
    // textured group, and the groups are split by a triangle's average y, so
    // running the mask everywhere keeps the shirt panel and collar seamless
    // across the split and lets the hem move without a code change.
    for (const material of [main, pants]) {
      material.onBeforeCompile = jacket.onBeforeCompile;
      material.customProgramCacheKey = () => "body-mask";
    }
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

      const idleSource = walkClip.clone();
      adductWalkClip(idleSource, IDLE_ADDUCTION);
      adductWalkClip(walkClip, WALK_ADDUCTION);

      const idleClip = createIdleClip(character, idleSource);
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
