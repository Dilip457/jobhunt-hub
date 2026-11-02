"use client";

import { useEffect } from "react";

/**
 * The "Next Step" mark on a 32-unit grid, the same geometry as
 * public/favicon.svg: three isometric steps climbing right and up, the top one
 * blue, and a red dot that hops from step to step.
 */
const GRID = 32;
const SIZE = 64;

const INK = "#08090D";
const RED = "#FF304F";
const WHITE_FACES = ["#FFFFFF", "#C9CED9", "#8F97A8"] as const; // top, front, side
const BLUE_FACES = ["#4A92FF", "#1D5FC9", "#154AA0"] as const;

const K = 7.6;
const ORIGIN_X = 2.8;
const ORIGIN_Y = 26.7;
const COS30 = Math.cos(Math.PI / 6);
const HEIGHTS = [0.6, 1.2, 1.8] as const;
const DOT_R = 2.7;
/** One climb, rest and restart, in seconds; matches the CSS mark. */
const CLIMB_S = 3.6;

type Point = [number, number];

function project(x: number, y: number, z: number): Point {
  return [ORIGIN_X + (x + y) * K * COS30, ORIGIN_Y + (y - x) * K * 0.5 - z * K];
}

function polygon(ctx: CanvasRenderingContext2D, points: Point[], fill: string) {
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i][0], points[i][1]);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.stroke();
}

function dotAt(step: number): Point {
  const [x, y] = project(step + 0.5, 0.5, HEIGHTS[step]);
  return [x, y - DOT_R * 0.85];
}

/** Where the dot is, and how visible, at a point in the climb (0..1). */
export function dotPosition(t: number): { point: Point; alpha: number } {
  const [a, b, c] = [dotAt(0), dotAt(1), dotAt(2)];
  const hop = (from: Point, to: Point, u: number): Point => {
    const e = u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2;
    return [from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e - Math.sin(Math.PI * u) * 3.2];
  };
  if (t < 0.14) return { point: a, alpha: 1 };
  if (t < 0.3) return { point: hop(a, b, (t - 0.14) / 0.16), alpha: 1 };
  if (t < 0.44) return { point: b, alpha: 1 };
  if (t < 0.6) return { point: hop(b, c, (t - 0.44) / 0.16), alpha: 1 };
  if (t < 0.84) return { point: c, alpha: 1 };
  if (t < 0.92) return { point: c, alpha: 1 - (t - 0.84) / 0.08 };
  if (t < 0.93) return { point: a, alpha: 0 };
  return { point: a, alpha: (t - 0.93) / 0.07 };
}

export function drawScene(ctx: CanvasRenderingContext2D, time: number) {
  ctx.clearRect(0, 0, GRID, GRID);
  ctx.lineJoin = "round";
  ctx.strokeStyle = INK;
  ctx.lineWidth = 0.9;

  // Back to front, so the lower steps cover the sides of the higher ones.
  for (let i = 2; i >= 0; i -= 1) {
    const h = HEIGHTS[i];
    const [top, front, side] = i === 2 ? BLUE_FACES : WHITE_FACES;
    polygon(ctx, [project(i, 0, 0), project(i, 1, 0), project(i, 1, h), project(i, 0, h)], side);
    polygon(ctx, [project(i, 1, 0), project(i + 1, 1, 0), project(i + 1, 1, h), project(i, 1, h)], front);
    polygon(ctx, [project(i, 0, h), project(i + 1, 0, h), project(i + 1, 1, h), project(i, 1, h)], top);
  }

  const { point, alpha } = dotPosition((time / CLIMB_S) % 1);
  if (alpha <= 0) return;
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.arc(point[0], point[1], DOT_R, 0, Math.PI * 2);
  ctx.fillStyle = RED;
  ctx.fill();
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/** Frame interval: 8 fps is enough for a dot hopping across a 32 px icon. */
const FRAME_MS = 125;
/** How long after the last scroll or pointer input the icon stays still. */
const INPUT_QUIET_MS = 400;

/**
 * Keeps a transparent, animated PNG favicon in the tab.
 *
 * SVG favicons are not animated by Chromium, so the tab icon is drawn to a
 * small canvas and swapped in at 8 fps. Static SVG/PNG/ICO files in /public
 * remain the no-JS and reduced-motion fallback.
 *
 * Each frame costs main-thread time (a PNG encode plus the browser's icon
 * update), so it stands down whenever that time matters more: while the
 * cinematic scene draws every frame (`data-scene-busy` on <html>) and for a
 * moment after any scroll or pointer input.
 */
export default function AnimatedFavicon() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (reduce.matches) return;

    const canvas = document.createElement("canvas");
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const selector = 'link[rel="icon"], link[rel="shortcut icon"]';
    const link = document.createElement("link");
    link.rel = "icon";
    link.type = "image/png";
    link.setAttribute("sizes", `${SIZE}x${SIZE}`);
    link.setAttribute("data-dynamic-favicon", "true");
    document.head.appendChild(link);

    const originals = new Map<
      HTMLLinkElement,
      { href: string | null; type: string | null }
    >();

    const paint = (url: string) => {
      link.href = url;
      document.head.querySelectorAll<HTMLLinkElement>(selector).forEach((item) => {
        if (item === link) return;
        if (!originals.has(item)) {
          originals.set(item, {
            href: item.getAttribute("href"),
            type: item.getAttribute("type"),
          });
        }
        item.href = url;
        item.type = "image/png";
      });
    };

    let frame = 0;
    let last = 0;
    let lastInput = -Infinity;
    let running = true;
    const started = performance.now();

    const busy = (now: number) =>
      document.documentElement.hasAttribute("data-scene-busy") || now - lastInput < INPUT_QUIET_MS;

    const render = (now: number) => {
      if (!running) return;

      if (now - last >= FRAME_MS && !busy(now)) {
        last = now;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.scale(SIZE / GRID, SIZE / GRID);
        drawScene(ctx, (now - started) / 1000);
        paint(canvas.toDataURL("image/png"));
      }

      frame = window.requestAnimationFrame(render);
    };

    const onInput = () => {
      lastInput = performance.now();
    };
    const inputEvents = ["scroll", "wheel", "touchmove", "pointerdown"] as const;
    inputEvents.forEach((name) => window.addEventListener(name, onInput, { passive: true }));

    frame = window.requestAnimationFrame(render);

    const onVisibility = () => {
      if (document.hidden) {
        running = false;
        window.cancelAnimationFrame(frame);
        return;
      }
      if (!running) {
        running = true;
        last = 0;
        frame = window.requestAnimationFrame(render);
      }
    };

    const onMotionChange = () => {
      if (reduce.matches) {
        running = false;
        window.cancelAnimationFrame(frame);
        return;
      }
      if (!running) {
        running = true;
        last = 0;
        frame = window.requestAnimationFrame(render);
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    reduce.addEventListener("change", onMotionChange);

    return () => {
      running = false;
      window.cancelAnimationFrame(frame);
      inputEvents.forEach((name) => window.removeEventListener(name, onInput));
      document.removeEventListener("visibilitychange", onVisibility);
      reduce.removeEventListener("change", onMotionChange);
      link.remove();
      originals.forEach((value, item) => {
        if (!item.isConnected) return;
        if (value.href === null) item.removeAttribute("href");
        else item.setAttribute("href", value.href);
        if (value.type === null) item.removeAttribute("type");
        else item.setAttribute("type", value.type);
      });
    };
  }, []);

  return null;
}
