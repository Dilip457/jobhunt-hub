"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { prefetchRole } from "@/lib/prefetch";
import type { RoleSlug } from "@/lib/types";
import StaticIntro from "./StaticIntro";

function IntroLoading() {
  const router = useRouter();
  function select(role: RoleSlug) {
    void prefetchRole(role);
    router.push(`/jobs/${role}`);
  }
  return <StaticIntro onSelect={select} loading />;
}

const CinematicIntro = dynamic(() => import("./CinematicIntro"), {
  ssr: false,
  loading: () => <IntroLoading />,
});

export default function IntroPage() {
  return <CinematicIntro />;
}
