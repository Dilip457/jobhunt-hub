"use client";

import { playSound, primeAudio, setSoundEnabled, useSoundEnabled } from "@/lib/sound";
import { SoundOffIcon, SoundOnIcon } from "./Icons";

/**
 * The one sound control, on the intro and the dashboard header. The choice is
 * remembered on this device. Turning sound on answers with the tick, which is
 * also the moment the browser lets audio start.
 */
export default function SoundToggle() {
  const enabled = useSoundEnabled();

  function toggle() {
    primeAudio();
    const next = !enabled;
    setSoundEnabled(next);
    if (next) playSound("tick");
  }

  return (
    <button
      type="button"
      className="sound-toggle"
      aria-pressed={enabled}
      aria-label={enabled ? "Turn sound off" : "Turn sound on"}
      title={enabled ? "Sound on" : "Sound off"}
      data-sound="none"
      onClick={toggle}
    >
      {enabled ? <SoundOnIcon width={14} height={14} /> : <SoundOffIcon width={14} height={14} />}
      <span className="sound-toggle-label">{enabled ? "Sound on" : "Sound off"}</span>
    </button>
  );
}
