"use client";

import dynamic from "next/dynamic";
import IntroBoot from "./IntroBoot";

const CinematicIntro = dynamic(() => import("./CinematicIntro"), {
  ssr: false,
  loading: () => <IntroBoot />,
});

export default function IntroPage() {
  return <CinematicIntro />;
}
