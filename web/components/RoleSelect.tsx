"use client";

import { useEffect, useRef, useState } from "react";
import { ROLES, getRole } from "@/lib/roles";
import type { RoleSlug } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ChevronDownIcon } from "./Icons";

interface Props {
  value: RoleSlug;
  onChange: (role: RoleSlug) => void;
}

export default function RoleSelect({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(() => Math.max(0, ROLES.findIndex((r) => r.slug === value)));
  const wrapper = useRef<HTMLDivElement>(null);
  const current = getRole(value);

  useEffect(() => {
    function onDocumentClick(event: MouseEvent) {
      if (wrapper.current && !wrapper.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocumentClick);
    return () => document.removeEventListener("mousedown", onDocumentClick);
  }, []);

  useEffect(() => {
    setActive(Math.max(0, ROLES.findIndex((r) => r.slug === value)));
  }, [value]);

  function choose(role: RoleSlug) {
    onChange(role);
    setOpen(false);
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActive((index) => Math.min(ROLES.length - 1, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActive((index) => Math.max(0, index - 1));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) choose(ROLES[active].slug);
      else setOpen(true);
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div className="role-select" ref={wrapper}>
      <button
        type="button"
        className={cn("role-trigger", open && "is-open")}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Select a role"
      >
        <span className="role-dot" style={{ background: current.accent }} />
        <span className="role-trigger-text">
          <span className="role-trigger-label">{current.label}</span>
          <span className="role-trigger-sub">{current.description}</span>
        </span>
        <ChevronDownIcon className="role-chevron" width={18} height={18} />
      </button>

      {open ? (
        <div className="role-menu" role="listbox" aria-label="Roles">
          {ROLES.map((role, index) => (
            <div
              key={role.slug}
              role="option"
              aria-selected={role.slug === value}
              tabIndex={-1}
              className={cn(
                "role-option",
                role.slug === value && "is-selected",
                index === active && "is-active",
              )}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(role.slug)}
            >
              <span className="role-option-dot" style={{ background: role.accent }} />
              <span className="role-option-text">
                <span className="role-option-label">{role.fullLabel}</span>
                <span className="role-option-sub">{role.description}</span>
              </span>
              {role.slug === value ? <span className="role-option-check">✓</span> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
