export interface GalleryOrderState {
  readonly revision: number;
  readonly projectIds: readonly string[];
}

/** One scoped save at a time; disposal discards late receipts without undoing durable native work. */
export function createGalleryOrderWriter(options: {
  readonly current: () => GalleryOrderState;
  readonly persist: (previous: GalleryOrderState, projectIds: readonly string[]) => Promise<GalleryOrderState | null>;
  readonly apply: (order: GalleryOrderState) => void;
  readonly pending: (pending: boolean) => void;
}) {
  let active = true;
  let busy = false;
  return {
    dispose() { active = false; },
    async save(ids: readonly string[]): Promise<boolean> {
      if (!active || busy) return false;
      busy = true;
      const previous = options.current();
      const projectIds = [...ids];
      options.pending(true);
      options.apply({ revision: previous.revision, projectIds });
      try {
        const saved = await options.persist(previous, projectIds);
        if (!active) return false;
        options.apply(saved ?? previous);
        return saved !== null;
      } catch {
        if (active) options.apply(previous);
        return false;
      } finally {
        busy = false;
        if (active) options.pending(false);
      }
    },
  };
}

/** Saved gallery order applies to native project ids; unknown projects keep their incoming place after the saved ones. */
export function orderGalleryProjects<
  Project extends { readonly key: string; readonly id: string; readonly native: boolean },
>(projects: readonly Project[], savedProjectIds: readonly string[]): readonly Project[] {
  const rank = new Map(savedProjectIds.map((id, index) => [id, index] as const));
  const savedRank = (project: Project) =>
    project.native ? (rank.get(project.id) ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
  return projects
    .map((project, index) => ({ project, index }))
    .sort((left, right) => {
      const byRank = savedRank(left.project) - savedRank(right.project);
      return byRank !== 0 && !Number.isNaN(byRank) ? byRank : left.index - right.index;
    })
    .map(({ project }) => project);
}

/** The native ids to persist, in their displayed order; local-only projects are not stored. */
export function galleryProjectIdsForSave(
  projects: readonly { readonly id: string; readonly native: boolean }[],
): readonly string[] {
  return projects.filter((project) => project.native).map((project) => project.id);
}

/** Move one item to the position of another, as a drop onto a sortable tile does. */
export function moveGalleryItem<Item>(
  items: readonly Item[],
  from: number,
  to: number,
): readonly Item[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return items;
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return items;
  next.splice(to, 0, moved);
  return next;
}

/** Percent change between the regular meeting before last and the one before that; null without a usable baseline. */
export function kpiTrendPercent(current: number | null, previous: number | null): number | null {
  if (
    current === null ||
    previous === null ||
    !Number.isFinite(current) ||
    !Number.isFinite(previous)
  ) {
    return null;
  }
  if (previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

/** Signed label for a trend, with a real minus sign and no false precision. */
export function formatKpiTrend(percent: number | null): string | null {
  if (percent === null) return null;
  const rounded = Math.round(percent);
  if (rounded === 0) return "0 %";
  return `${rounded > 0 ? "+" : "−"}${Math.abs(rounded)} %`;
}
