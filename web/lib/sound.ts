/**
 * The site's sound: a few short cues made with the Web Audio API.
 *
 * Nothing is downloaded. Every cue is a tone or a burst of filtered noise
 * shaped by a gain envelope, a few hundredths of a second long and quiet
 * (peaks around -20 dBFS), so it reads as the interface answering rather
 * than as a sound effect. The scene's floor is dark polished stone, so the
 * footsteps are a soft thud with a short, dull click.
 *
 * Browsers only let audio start after the visitor has touched or typed on
 * the page. `primeAudio()` is called from the first such gesture; a cue asked
 * for before that is dropped, never queued. The preference is one switch,
 * remembered in localStorage, on by default.
 */
import { useSyncExternalStore } from "react";

export type SoundName = "tick" | "tab" | "select" | "flip" | "step";

export interface SoundOptions {
  /** 0..1 multiplier on the cue's own level. */
  gain?: number;
  /** "tab": which tab, left to right; each has its own pitch. "step": 0 left foot, 1 right. */
  step?: number;
  /** "step": the character is on the raised dais, which rings a little. */
  raised?: boolean;
}

const STORAGE_KEY = "jobhunt.sound";
/** Two cues closer together than this are one gesture (click + change). */
const MIN_GAP_MS = 35;

// ── Preference ───────────────────────────────────────────────────────────────

let enabled: boolean | null = null;
const listeners = new Set<() => void>();

export function parseSoundSetting(stored: string | null | undefined): boolean {
  return stored !== "off";
}

export function soundEnabled(): boolean {
  if (enabled === null) {
    let stored: string | null = null;
    try {
      stored = typeof window === "undefined" ? null : window.localStorage.getItem(STORAGE_KEY);
    } catch {
      stored = null;
    }
    enabled = parseSoundSetting(stored);
  }
  return enabled;
}

export function setSoundEnabled(next: boolean): void {
  enabled = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next ? "on" : "off");
  } catch {
    // Private mode or storage disabled: the choice lasts for this page.
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSoundEnabled(): boolean {
  return useSyncExternalStore(subscribe, soundEnabled, () => true);
}

// ── Audio graph ──────────────────────────────────────────────────────────────

let context: AudioContext | null = null;
let output: GainNode | null = null;
let noiseBuffer: AudioBuffer | null = null;
let lastCueAt = 0;

/**
 * Create and start the audio context. Call from inside a user gesture
 * (pointerdown, keydown, click): outside one the browser keeps it silent.
 */
export function primeAudio(): void {
  if (typeof window === "undefined") return;
  if (!context) {
    const Ctor = window.AudioContext;
    if (!Ctor) return;
    try {
      context = new Ctor();
    } catch {
      return;
    }
    output = context.createGain();
    output.gain.value = 1;
    // A gentle ceiling so overlapping cues (a step under a click) never spike.
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -18;
    limiter.knee.value = 12;
    limiter.ratio.value = 6;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;
    output.connect(limiter).connect(context.destination);
  }
  if (context.state === "suspended") void context.resume().catch(() => undefined);
}

/** True when a cue would be heard right now. */
export function soundReady(): boolean {
  return soundEnabled() && context !== null && context.state === "running" && !document.hidden;
}

function noise(ctx: AudioContext): AudioBuffer {
  if (noiseBuffer) return noiseBuffer;
  const seconds = 0.5;
  const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
  noiseBuffer = buffer;
  return buffer;
}

interface Envelope {
  at: number;
  attack: number;
  decay: number;
  peak: number;
}

function envelope(ctx: AudioContext, { at, attack, decay, peak }: Envelope): GainNode {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  return gain;
}

interface ToneSpec extends Envelope {
  freq: number;
  /** Glide to this frequency over the decay. */
  to?: number;
  type?: OscillatorType;
}

function tone(ctx: AudioContext, dest: AudioNode, spec: ToneSpec): void {
  const osc = ctx.createOscillator();
  osc.type = spec.type ?? "sine";
  osc.frequency.setValueAtTime(spec.freq, spec.at);
  if (spec.to) osc.frequency.exponentialRampToValueAtTime(spec.to, spec.at + spec.attack + spec.decay);
  const gain = envelope(ctx, spec);
  osc.connect(gain).connect(dest);
  osc.start(spec.at);
  osc.stop(spec.at + spec.attack + spec.decay + 0.03);
}

interface NoiseSpec extends Envelope {
  type: BiquadFilterType;
  freq: number;
  to?: number;
  q?: number;
}

function burst(ctx: AudioContext, dest: AudioNode, spec: NoiseSpec): void {
  const source = ctx.createBufferSource();
  source.buffer = noise(ctx);
  source.loop = true;
  const filter = ctx.createBiquadFilter();
  filter.type = spec.type;
  filter.Q.value = spec.q ?? 1;
  filter.frequency.setValueAtTime(spec.freq, spec.at);
  if (spec.to) filter.frequency.exponentialRampToValueAtTime(spec.to, spec.at + spec.attack + spec.decay);
  const gain = envelope(ctx, spec);
  source.connect(filter).connect(gain).connect(dest);
  source.start(spec.at);
  source.stop(spec.at + spec.attack + spec.decay + 0.03);
}

function jitter(amount: number): number {
  return 1 + (Math.random() * 2 - 1) * amount;
}

// ── Cues ─────────────────────────────────────────────────────────────────────

function cueTick(ctx: AudioContext, dest: AudioNode, at: number, level: number): void {
  tone(ctx, dest, { at, freq: 1900, to: 1500, attack: 0.002, decay: 0.045, peak: 0.07 * level });
  burst(ctx, dest, { at, type: "highpass", freq: 4200, attack: 0.001, decay: 0.012, peak: 0.03 * level });
}

/** The role tabs: the same tick, each tab a whole tone higher than the last. */
function cueTab(ctx: AudioContext, dest: AudioNode, at: number, level: number, index: number): void {
  const freq = 1046 * 2 ** ((Math.max(0, index) * 2) / 12);
  tone(ctx, dest, { at, freq, attack: 0.002, decay: 0.07, peak: 0.075 * level });
  tone(ctx, dest, { at, freq: freq / 2, attack: 0.003, decay: 0.1, peak: 0.03 * level });
  burst(ctx, dest, { at, type: "highpass", freq: 4200, attack: 0.001, decay: 0.01, peak: 0.025 * level });
}

/** Choosing a destination: two soft notes rising, and the gate's light swelling. */
function cueSelect(ctx: AudioContext, dest: AudioNode, at: number, level: number): void {
  tone(ctx, dest, { at, freq: 659, attack: 0.004, decay: 0.24, peak: 0.085 * level });
  tone(ctx, dest, { at: at + 0.085, freq: 988, attack: 0.004, decay: 0.3, peak: 0.07 * level });
  burst(ctx, dest, { at, type: "bandpass", freq: 600, to: 1800, q: 0.7, attack: 0.08, decay: 0.26, peak: 0.022 * level });
}

/** A job card turning over: a short brush of air, then it settles. */
function cueFlip(ctx: AudioContext, dest: AudioNode, at: number, level: number): void {
  burst(ctx, dest, { at, type: "bandpass", freq: 2600, to: 520, q: 1.2, attack: 0.03, decay: 0.11, peak: 0.06 * level });
  tone(ctx, dest, { at: at + 0.1, freq: 1200, attack: 0.002, decay: 0.03, peak: 0.028 * level });
}

/** One footfall on the dark floor. */
function cueStep(ctx: AudioContext, dest: AudioNode, at: number, level: number, side: number, raised: boolean): void {
  const foot = side === 0 ? 0.93 : 1;
  burst(ctx, dest, {
    at, type: "bandpass", freq: 1100 * foot * jitter(0.12), q: 0.9,
    attack: 0.003, decay: 0.07, peak: 0.09 * level,
  });
  tone(ctx, dest, {
    at, freq: 120 * foot * jitter(0.06), to: 55, attack: 0.004, decay: 0.11, peak: 0.11 * level,
  });
  if (raised) {
    tone(ctx, dest, { at: at + 0.004, freq: 240 * foot, to: 180, attack: 0.004, decay: 0.16, peak: 0.045 * level });
  }
}

export function playSound(name: SoundName, options: SoundOptions = {}): void {
  if (!context || !output || !soundEnabled() || document.hidden) return;
  if (context.state !== "running") {
    void context.resume().catch(() => undefined);
    return;
  }
  const now = performance.now();
  if (name !== "step") {
    if (now - lastCueAt < MIN_GAP_MS) return;
    lastCueAt = now;
  }
  const level = Math.min(1, Math.max(0, options.gain ?? 1));
  if (level === 0) return;
  const at = context.currentTime + 0.005;
  try {
    switch (name) {
      case "tick":
        cueTick(context, output, at, level);
        break;
      case "tab":
        cueTab(context, output, at, level, options.step ?? 0);
        break;
      case "select":
        cueSelect(context, output, at, level);
        break;
      case "flip":
        cueFlip(context, output, at, level);
        break;
      case "step":
        cueStep(context, output, at, level, options.step ?? 0, options.raised ?? false);
        break;
    }
  } catch {
    // A cue is never worth an error on the page.
  }
}
