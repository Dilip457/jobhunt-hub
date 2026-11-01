import test from "node:test";
import assert from "node:assert/strict";
import { companyHue } from "../lib/utils";

test("companyHue gives a company the same colour every time, whatever the case or spacing", () => {
  assert.deepEqual(companyHue("Codemonk"), companyHue("  codemonk "));
  assert.match(companyHue("Signzy").color, /^hsl\(\d{1,3} 72% 56%\)$/);
});

test("companyHue spreads different companies across the wheel", () => {
  const names = ["Codemonk", "Blackbaud India", "Signzy", "PivotRoots", "Tricog Health", "Havas group", "Abbott Healthcare", "Abbott Vascular"];
  const colours = new Set(names.map((name) => companyHue(name).color));
  assert.ok(colours.size >= 7, `only ${colours.size} distinct colours for ${names.length} companies`);
  // No 60-degree slice of the wheel (say, the greens) holds more than a third of 300 names.
  const hues = Array.from({ length: 300 }, (_, i) => Number(companyHue(`Firm ${i} Pvt Ltd`).color.slice(4).split(" ")[0]));
  for (let start = 0; start < 360; start += 30) {
    const inSlice = hues.filter((hue) => (hue - start + 360) % 360 < 60).length;
    assert.ok(inSlice <= 100, `${inSlice} of 300 names fall in ${start}–${start + 60}°`);
  }
});

test("companyHue picks the ink that reads better on the fill", () => {
  // Hue 60 (yellow) at 56% lightness is light: dark ink. Hue 240 (blue) is dark: white ink; violets past ~265 read better with dark ink.
  const inks = new Map<string, string>();
  for (let i = 0; i < 400; i += 1) {
    const { color, ink } = companyHue(`Company ${i}`);
    inks.set(color, ink);
  }
  const hueOf = (color: string) => Number(color.slice(4).split(" ")[0]);
  for (const [color, ink] of inks) {
    const hue = hueOf(color);
    if (hue >= 50 && hue <= 170) assert.equal(ink, "#08090d", `${color} should take dark ink`);
    if (hue >= 225 && hue <= 260) assert.equal(ink, "#ffffff", `${color} should take white ink`);
  }
});

test("companyHue's text tone reads on the card at 4.5:1 for every hue", () => {
  const lum = (r: number, g: number, b: number) =>
    [r, g, b]
      .map((c) => c / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const card = lum(16, 19, 26);
  const rgb = (h: number, s: number, l: number) => {
    const k = (n: number) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [f(0), f(8), f(4)].map((v) => Math.round(v * 255)) as [number, number, number];
  };
  for (let i = 0; i < 400; i += 1) {
    const { text } = companyHue(`Company ${i}`);
    const [h, s, l] = text.slice(4, -1).split(" ").map((part) => parseFloat(part));
    const ratio = (lum(...rgb(h, s / 100, l / 100)) + 0.05) / (card + 0.05);
    assert.ok(ratio >= 4.5, `${text} is only ${ratio.toFixed(2)}:1 on the card`);
  }
});
