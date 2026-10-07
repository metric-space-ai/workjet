import type { GalleryProject } from "../projectOverview";
import { ArrowUpRightIcon } from "lucide-react";
import { Button } from "./ui/button";

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
type CalendarProject = GalleryProject & { readonly onOpen: () => void; readonly onOpenJourFixe?: () => void };

/** Weekly wall-clock meetings retain the native timezone; no inferred appointments. */
export function ProjectCalendar({ projects }: { readonly projects: readonly CalendarProject[] }) {
  const scheduled = projects.filter((project) => project.configuration?.jourFixe != null);
  const unscheduled = projects.filter((project) => project.configuration?.jourFixe == null);
  return (
    <section aria-label="Weekly project calendar" data-workjet-project-calendar="">
      <p className="mb-4 text-sm text-muted-foreground">
        Regular meetings · times are shown in each project's timezone.
      </p>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-7">
        {WEEKDAYS.map((day, index) => {
          const meetings = scheduled
            .filter((project) => project.configuration?.jourFixe?.weekday === index + 1)
            .toSorted(
              (a, b) =>
                (a.configuration?.jourFixe?.time ?? "").localeCompare(
                  b.configuration?.jourFixe?.time ?? "",
                ) || a.title.localeCompare(b.title),
            );
          return (
            <section key={day} aria-label={day} className="min-w-0 border-t border-border pt-3">
              <h2 className="mb-3 text-sm font-medium">{day}</h2>
              {meetings.length === 0 ? (
                <p className="text-sm text-muted-foreground" aria-label="No regular meetings">
                  —
                </p>
              ) : (
                <div className="space-y-2">
                  {meetings.map((project) => (
                    <button
                      key={project.key}
                      type="button"
                      onClick={project.onOpenJourFixe ?? project.onOpen}
                      data-workjet-action={`project.open.calendar:${project.key}`}
                      className="w-full rounded-md border border-border bg-card p-3 text-left transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                      aria-label={project.onOpenJourFixe ? `Open meeting for ${project.title}` : `Open ${project.title}`}
                    >
                      <div className="mb-2 text-sm font-semibold tabular-nums">
                        {project.configuration?.jourFixe?.time}
                      </div>
                      <div className="break-words text-sm">{project.title}</div>
                      <div className="mt-1 break-all text-xs text-muted-foreground">
                        {project.configuration?.jourFixe?.timezone}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>
      {unscheduled.length > 0 && (
        <section
          className="mt-7 border-t border-border pt-4"
          aria-label="Projects without a regular meeting"
        >
          <h2 className="text-sm font-medium">No regular meeting configured</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Open a project to set its regular meeting in project settings.
          </p>
          <div className="mt-2 flex flex-wrap gap-1">
            {unscheduled.map((project) => (
              <Button
                key={project.key}
                size="sm"
                variant="ghost"
                onClick={project.onOpen}
                data-workjet-action={`project.open.calendar:${project.key}`}
              >
                {project.title}
                <ArrowUpRightIcon className="size-3" />
              </Button>
            ))}
          </div>
        </section>
      )}
    </section>
  );
}
