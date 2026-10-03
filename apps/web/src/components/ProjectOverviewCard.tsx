import { useState } from "react";
import type { ProjectOverview } from "@workjet/contracts";
import { type GalleryProject, projectUpdateAge } from "../projectOverview";
import { ProjectOverviewEditor } from "./ProjectOverviewEditor";
import { Button } from "./ui/button";

export function ProjectOverviewCard({
  project,
  onOpen,
  onSave,
}: {
  readonly project: GalleryProject;
  readonly onOpen: () => void;
  readonly onSave?: ((next: ProjectOverview) => Promise<boolean>) | undefined;
}) {
  const [editing, setEditing] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const overview = project.local?.overview;
  const website = overview?.websiteUrl;
  const slots = overview?.slots ?? [null, null, null];
  return (
    <article
      className="flex min-w-0 flex-col gap-4 rounded-xl border border-border bg-card p-5"
      data-workjet-project-card={project.key}
    >
      <button
        type="button"
        data-workjet-action={`project.open.gallery:${project.key}`}
        aria-label={`Open ${project.title}`}
        onClick={onOpen}
        className="text-left text-lg font-medium hover:underline focus-visible:outline focus-visible:outline-ring"
      >
        {project.title}
      </button>
      {website && (
        <div className="grid gap-2">
          {showPreview && (
            <iframe
              src={website}
              title={`Website preview for ${project.title}`}
              sandbox=""
              referrerPolicy="no-referrer"
              loading="lazy"
              className="h-36 w-full rounded-md border border-border bg-background"
            />
          )}
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <a
              href={website}
              target="_blank"
              rel="noreferrer noopener"
              className="truncate text-primary underline"
            >
              Open website
            </a>
            <Button size="xs" variant="ghost" onClick={() => setShowPreview((show) => !show)}>
              {showPreview ? "Hide preview" : "Show preview"}
            </Button>
          </div>
          {showPreview && (
            <p className="text-xs text-muted-foreground">
              If the website blocks its preview, open it directly.
            </p>
          )}
        </div>
      )}
      <dl className="grid grid-cols-3 gap-3" data-workjet-project-card-slots="">
        {(["first", "second", "third"] as const).map((position, index) => {
          const slot = slots[index] ?? null;
          return (
            <div key={position} className="min-w-0" data-workjet-project-card-slot={index + 1}>
              <dt className="truncate text-xs text-muted-foreground">
                {slot?.label ?? `Field ${index + 1}`}
              </dt>
              <dd className="mt-1 break-words text-sm">
                {slot === null ? (
                  <span className="text-muted-foreground">Not configured</span>
                ) : slot.kind === "link" ? (
                  <a
                    href={slot.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-primary underline"
                  >
                    Open link
                  </a>
                ) : slot.kind === "updated" ? (
                  <time dateTime={project.local?.updatedAt} title={project.local?.updatedAt}>
                    {projectUpdateAge(project.local?.updatedAt ?? null)}
                  </time>
                ) : slot.kind === "metric" ? (
                  `${slot.value}${slot.unit ? ` ${slot.unit}` : ""}`
                ) : (
                  slot.value
                )}
              </dd>
            </div>
          );
        })}
      </dl>
      <div className="mt-auto flex flex-wrap gap-2">
        <Button size="sm" onClick={onOpen}>
          Open project
        </Button>
        {onSave && (
          <Button size="sm" variant="outline" onClick={() => setEditing((open) => !open)}>
            {editing ? "Close editor" : "Configure overview"}
          </Button>
        )}
      </div>
      {!onSave && (
        <p className="text-xs text-muted-foreground">
          {project.local === null
            ? "Open this project’s supervisor to configure its overview."
            : "Reconnect to an updated environment to configure this overview."}
        </p>
      )}
      {editing && onSave && <ProjectOverviewEditor overview={overview} onSave={onSave} />}
    </article>
  );
}
