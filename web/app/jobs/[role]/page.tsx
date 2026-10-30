import { redirect } from "next/navigation";
import type { Metadata } from "next";
import JobDashboard from "@/components/JobDashboard";
import { getRole } from "@/lib/roles";
import { isRoleSlug, ROLE_SLUGS } from "@/lib/types";

interface Props {
  params: Promise<{ role: string }>;
}

export function generateStaticParams() {
  return ROLE_SLUGS.map((role) => ({ role }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { role } = await params;
  if (!isRoleSlug(role)) return { title: "JobHunt India" };
  const meta = getRole(role);
  return {
    title: `${meta.fullLabel} jobs — JobHunt India`,
    description: `${meta.blurb} Live listings from Naukri, Foundit, Indeed, Shine, LinkedIn, Wellfound and more.`,
  };
}

export default async function RolePage({ params }: Props) {
  const { role } = await params;
  if (!isRoleSlug(role)) redirect("/");

  return <JobDashboard role={role} />;
}
