"use client";

import { useEffect } from "react";

const GRID = 32;
const SIZE = 64;

const INK = "#08090D";
const BLUE = "#287BFF";
const RED = "#FF304F";
const SKIN = "#E8B48F";
const WHITE = "#FFFFFF";

type Point = [number, number];

function trace(ctx: CanvasRenderingContext2D, points: Point[], close = false) {
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i += 1) {
    ctx.lineTo(points[i][0], points[i][1]);
  }
  if (close) ctx.closePath();
}

function outlinedLimb(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  color: string,
  width: number,
) {
  trace(ctx, points);
  ctx.strokeStyle = INK;
  ctx.lineWidth = width + 1.5;
  ctx.stroke();

  trace(ctx, points);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

function disc(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  fill: string,
  strokeWidth = 0,
) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  if (strokeWidth > 0) {
    ctx.strokeStyle = INK;
    ctx.lineWidth = strokeWidth;
    ctx.stroke();
  }
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawArm(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  direction: 1 | -1,
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((angle * Math.PI) / 180);
  outlinedLimb(
    ctx,
    [
      [0, 0],
      [1.4 * direction, 2],
      [2 * direction, 3.8],
    ],
    BLUE,
    2.3,
  );
  disc(ctx, 2 * direction, 3.8, 1.2, SKIN, 0.9);
  ctx.restore();
}

function drawLeg(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  direction: 1 | -1,
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((angle * Math.PI) / 180);
  outlinedLimb(
    ctx,
    [
      [0, 0],
      [0.6 * direction, 1.8],
      [1.2 * direction, 3.6],
    ],
    BLUE,
    2.5,
  );

  roundedRect(ctx, direction < 0 ? -2.6 : 0, 3.2, 2.6, 1.4, 0.7);
  ctx.fillStyle = INK;
  ctx.fill();
  ctx.restore();
}

function drawScene(ctx: CanvasRenderingContext2D, time: number) {
  ctx.clearRect(0, 0, GRID, GRID);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // Two chunky steps fill the lower half so the mark reads at 16px.
  trace(
    ctx,
    [
      [2, 30],
      [2, 25],
      [13, 25],
      [13, 20],
      [30, 20],
      [30, 30],
    ],
    true,
  );
  ctx.fillStyle = WHITE;
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.2;
  ctx.stroke();

  // A blue shimmer travels up the treads.
  const treads: Array<[number, number, number]> = [
    [25, 2, 13],
    [20, 13, 30],
  ];
  const pulse = (time * 0.42) % 1;
  treads.forEach(([y, x1, x2], index) => {
    const raw = Math.abs(pulse - index / 2);
    const distance = Math.min(raw, 1 - raw);
    const glow = Math.max(0, 1 - distance * 4);
    ctx.globalAlpha = 0.55 + 0.45 * glow;
    ctx.beginPath();
    ctx.moveTo(x1, y);
    ctx.lineTo(x2, y);
    ctx.strokeStyle = BLUE;
    ctx.lineWidth = 1.6;
    ctx.stroke();
  });
  ctx.globalAlpha = 1;

  // Walking figure.
  const phase = time * 5.2;
  const swing = Math.sin(phase);
  const bob = -Math.abs(Math.cos(phase)) * 0.35;
  const leftLegAngle = -12 - swing * 9;
  const rightLegAngle = 12 + swing * 9;
  const leftArmAngle = 10 + swing * 7;
  const rightArmAngle = -10 - swing * 7;

  ctx.save();
  ctx.translate(0, bob);

  drawArm(ctx, 18.2, 10.4, leftArmAngle, -1);
  drawLeg(ctx, 19.6, 16.4, leftLegAngle, -1);

  // Neck.
  roundedRect(ctx, 20.3, 8.6, 1.4, 1.4, 0.5);
  ctx.fillStyle = SKIN;
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 0.8;
  ctx.stroke();

  // Torso and white tee.
  trace(
    ctx,
    [
      [17.6, 9.8],
      [24.4, 9.8],
      [25.4, 16.4],
      [16.6, 16.4],
    ],
    true,
  );
  ctx.fillStyle = BLUE;
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.1;
  ctx.stroke();

  trace(
    ctx,
    [
      [19.4, 9.9],
      [22.6, 9.9],
      [23, 16.1],
      [19, 16.1],
    ],
    true,
  );
  ctx.fillStyle = WHITE;
  ctx.fill();

  trace(ctx, [
    [17.9, 12.2],
    [24.1, 11.2],
  ]);
  ctx.strokeStyle = RED;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  drawLeg(ctx, 22.4, 16.4, rightLegAngle, 1);
  drawArm(ctx, 23.8, 10.4, rightArmAngle, 1);

  // Head and red cap.
  disc(ctx, 21, 5.8, 3.1, SKIN, 1.1);
  ctx.beginPath();
  ctx.moveTo(17.9, 4.8);
  ctx.quadraticCurveTo(21, 1.8, 24.1, 4.8);
  ctx.lineTo(24.1, 5.4);
  ctx.lineTo(17.9, 5.4);
  ctx.closePath();
  ctx.fillStyle = RED;
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 0.9;
  ctx.stroke();

  trace(ctx, [
    [23.9, 5],
    [25.4, 5],
  ]);
  ctx.strokeStyle = RED;
  ctx.lineWidth = 1.6;
  ctx.stroke();

  ctx.restore();
}

/**
 * Keeps a transparent, animated PNG favicon in the tab.
 *
 * SVG favicons are not animated by Chromium, so the tab icon is drawn to a
 * small canvas and swapped in at roughly 12 fps. Static SVG/PNG/ICO files in
 * /public remain the no-JS and reduced-motion fallback.
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
    let running = true;
    const started = performance.now();

    const render = (now: number) => {
      if (!running) return;

      if (now - last >= 80) {
        last = now;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.scale(SIZE / GRID, SIZE / GRID);
        drawScene(ctx, (now - started) / 1000);
        paint(canvas.toDataURL("image/png"));
      }

      frame = window.requestAnimationFrame(render);
    };

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
