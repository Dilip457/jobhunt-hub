"use client";

import { useEffect } from "react";
import { playSound, primeAudio, type SoundName } from "@/lib/sound";

const CUES: ReadonlySet<string> = new Set(["tick", "tab", "select", "flip", "step"]);

/**
 * The page's click sounds, in one place.
 *
 * Every button and link gives a tick when pressed; an element can ask for a
 * different cue with `data-sound` (the role tabs, the destination cards) or
 * for none with `data-sound="none"`. Choosing a filter gives the same tick.
 * The audio context is started from the first touch or key on the page,
 * which is the only moment the browser allows it.
 */
export default function SoundEffects() {
  useEffect(() => {
    const prime = () => primeAudio();
    const options: AddEventListenerOptions = { capture: true, passive: true };

    function cueFor(target: EventTarget | null): [SoundName, number] | null {
      if (!(target instanceof Element)) return null;
      const control = target.closest<HTMLElement>("button, a[href], [data-sound]");
      if (!control) return null;
      if (control instanceof HTMLButtonElement && control.disabled) return null;
      const asked = control.dataset.sound;
      if (asked === "none") return null;
      const name: SoundName = asked && CUES.has(asked) ? (asked as SoundName) : "tick";
      return [name, Number(control.dataset.soundStep ?? 0) || 0];
    }

    function onClick(event: MouseEvent) {
      const cue = cueFor(event.target);
      if (cue) playSound(cue[0], { step: cue[1] });
    }

    function onChange(event: Event) {
      const target = event.target;
      if (target instanceof HTMLSelectElement) playSound("tick");
      else if (target instanceof HTMLInputElement && (target.type === "checkbox" || target.type === "radio")) {
        playSound("tick");
      }
    }

    for (const type of ["pointerdown", "keydown", "touchend"]) {
      document.addEventListener(type, prime, options);
    }
    document.addEventListener("click", onClick, options);
    document.addEventListener("change", onChange, options);
    return () => {
      for (const type of ["pointerdown", "keydown", "touchend"]) {
        document.removeEventListener(type, prime, options);
      }
      document.removeEventListener("click", onClick, options);
      document.removeEventListener("change", onChange, options);
    };
  }, []);

  return null;
}
