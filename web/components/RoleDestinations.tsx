"use client";

import type { CSSProperties } from "react";
import { ROLES } from "@/lib/roles";
import type { RoleSlug } from "@/lib/types";
import { ArrowRightIcon } from "./Icons";

interface Props {
  onSelect: (role: RoleSlug) => void;
  selected?: RoleSlug | null;
  disabled?: boolean;
}

export default function RoleDestinations({ onSelect, selected = null, disabled = false }: Props) {
  return (
    <div className="destination-grid">
      {ROLES.map((role, index) => {
        const isSelected = selected === role.slug;
        return (
          <button
            key={role.slug}
            type="button"
            className={`destination-card ${isSelected ? "is-selected" : ""}`}
            style={{ "--role-accent": role.accent } as CSSProperties}
            onClick={() => onSelect(role.slug)}
            disabled={disabled}
            aria-label={`Explore ${role.fullLabel} jobs`}
            aria-pressed={isSelected}
          >
            <span className="destination-index">0{index + 1}</span>
            <span className="destination-light" aria-hidden />
            <span className="destination-copy">
              <strong>{role.fullLabel}</strong>
              <span>{role.description}</span>
            </span>
            <span className="destination-arrow" aria-hidden>
              <ArrowRightIcon width={17} height={17} />
            </span>
          </button>
        );
      })}
    </div>
  );
}
