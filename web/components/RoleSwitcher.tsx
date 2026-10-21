"use client";

import type { CSSProperties } from "react";
import { ROLES } from "@/lib/roles";
import type { RoleSlug } from "@/lib/types";

interface Props {
  role: RoleSlug;
  onChange: (role: RoleSlug) => void;
}

export default function RoleSwitcher({ role, onChange }: Props) {
  return (
    <nav className="role-switch" aria-label="Choose a job role">
      {ROLES.map((item) => (
        <button
          key={item.slug}
          type="button"
          className={`role-switch-btn ${item.slug === role ? "is-active" : ""}`}
          onClick={() => onChange(item.slug)}
          aria-pressed={item.slug === role}
          style={{ "--role-accent": item.accent } as CSSProperties}
        >
          <span className="role-switch-dot" aria-hidden />
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  );
}
