/**
 * Presets › System-Prompts › Workjet Manager: die bekannte Unterhaltung wird
 * gewählt, nie als `workjet://`-Adresse getippt (UI-Vertrag §3, Audit C 9).
 */
import { useMemo } from "react";
import {
  buildWorkjetThreadDeepLink,
  parseWorkjetThreadDeepLink,
} from "@workjet/shared/agentAwareness";

import { useProjects, useThreadShells } from "../../state/entities";
import { OptionSelect } from "../ui/option-select";

const NONE = "none";

export function ManagerThreadSelect({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (reference: string) => void;
}) {
  const threads = useThreadShells();
  const projects = useProjects();
  const options = useMemo(() => {
    const entries = threads
      .filter((thread) => thread.archivedAt === null)
      .map((thread) => {
        const project = projects.find(
          (candidate) =>
            candidate.environmentId === thread.environmentId && candidate.id === thread.projectId,
        );
        return {
          value: buildWorkjetThreadDeepLink({
            environmentId: thread.environmentId,
            threadId: thread.id,
          }),
          label: project ? `${project.title} · ${thread.title}` : thread.title,
        };
      })
      .toSorted((left, right) => left.label.localeCompare(right.label, "de"));
    const current = value.trim();
    const known = current === "" || entries.some((entry) => entry.value === current);
    return [
      { value: NONE, label: "Keine" },
      ...(known || parseWorkjetThreadDeepLink(current) === null
        ? []
        : [{ value: current, label: "Bisherige Unterhaltung" }]),
      ...entries,
    ];
  }, [projects, threads, value]);
  return (
    <OptionSelect
      aria-label="Workjet-Manager-Unterhaltung"
      className="w-full sm:w-80"
      value={value.trim() === "" ? NONE : value.trim()}
      options={options}
      onValueChange={(next) => onChange(next === NONE ? "" : next)}
    />
  );
}
