import { CtoxWorkjetProjectProjection, type CtoxWorkjetProjectKpis } from "@workjet/contracts";
import * as Schema from "effect/Schema";
import type { CtoxAppApi } from "./ctoxClient";

export const WORKJET_PROJECTS = "workjet_projects";
export const WORKJET_PROJECT_KPIS = "workjet_project_kpis";
export const ACTIVE_PROJECTS = { selector: { status: "active" } } as const;

export type WorkjetProjectDocument = CtoxWorkjetProjectProjection & {
  readonly status: "active" | "archived";
};
export type WorkjetProjectKpiDocument = CtoxWorkjetProjectKpis & { readonly id: string };

const decodeProject = Schema.decodeUnknownSync(CtoxWorkjetProjectProjection);

export function readLocalWorkjetProjects(api: CtoxAppApi): CtoxWorkjetProjectProjection[] {
  return api
    .query<WorkjetProjectDocument>(WORKJET_PROJECTS, ACTIVE_PROJECTS)
    .get()
    .map((row) => decodeProject(row));
}

export function readLocalWorkjetKpis(
  api: CtoxAppApi,
  projectId: string,
): CtoxWorkjetProjectKpis | null {
  const doc = api.get<WorkjetProjectKpiDocument>(WORKJET_PROJECT_KPIS, projectId).get();
  if (doc === null) return null;
  if (doc.id !== projectId || doc.project_id !== projectId) throw new Error("invalid_kpi_scope");
  return { project_id: doc.project_id, revision: doc.revision, items: doc.items };
}
