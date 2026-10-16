import { useCtoxCommand, useCtoxDoc, useCtoxQuery } from "./hooks";
import type { CtoxWorkjetProjectFeedPost } from "@workjet/contracts";
import { WorkjetWorkerProfile } from "@workjet/contracts";
import * as Schema from "effect/Schema";
import { useMemo } from "react";

const decodeWorkerProfile = Schema.decodeUnknownSync(WorkjetWorkerProfile);

/** Foreign rows keep their source schema; there is no client-side ownership inference. */
export interface CtoxSourceDocument {
  readonly id: string;
  readonly is_deleted?: boolean;
  readonly updated_at_ms?: number;
}
export interface CtoxThreadDocument extends CtoxSourceDocument {
  readonly title: string;
  readonly status?: string;
  readonly owner_user_id?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}
export interface CtoxThreadMessageDocument extends CtoxSourceDocument {
  readonly thread_id: string;
  readonly body?: string;
  readonly kind?: string;
  readonly author_display_name?: string;
  readonly created_at_ms?: number;
}
export interface CtoxProjectChatDocument extends CtoxSourceDocument {
  readonly project_id: string;
  readonly thread_id: string;
  readonly owner_user_id: string;
  readonly kind: "group" | "private";
  readonly initial: boolean;
  readonly worker_profile_id?: string;
}
export interface CtoxSupervisorBindingDocument extends CtoxSourceDocument {
  readonly project_id: string;
  readonly thread_id: string;
  readonly owner_user_id: string;
  readonly created_at_ms: number;
}
export interface CtoxWorkerProfileBindingDocument extends CtoxSourceDocument {
  readonly worker_profile_id: string;
  readonly computer_id: string;
  readonly owner_user_id: string;
  readonly status: "active" | "inactive";
  readonly crew_member_id?: string;
}
export interface CtoxWorkerRunDocument extends CtoxSourceDocument {
  readonly task_id: string;
  readonly command_id?: string;
  readonly crew_member_id?: string;
  readonly agent_outcome?: string;
  readonly finished_at_ms?: number;
}
export interface CtoxWorkerTaskDocument extends CtoxSourceDocument {
  readonly title: string;
  readonly status: string;
  readonly route_status?: string;
  readonly crew_member_id?: string;
  readonly crew_assigned_member_id?: string;
  readonly command_id?: string;
}
export interface CtoxMachineDocument extends CtoxSourceDocument {
  readonly display_name: string;
  readonly hosting_mode: "workstation" | "self_hosted";
  readonly status: "assigned" | "unassigned";
  readonly capabilities: readonly string[];
  readonly self_hosted_colocation: boolean;
  readonly device_binding_id: string;
  readonly actor_epoch: number;
  readonly last_seen_at_ms: number;
  readonly replication_up: boolean;
}
export interface CtoxMachineEnrollmentDocument extends CtoxSourceDocument {
  readonly steps: readonly {
    readonly key: string;
    readonly state: "pending" | "running" | "done" | "failed";
    readonly at_ms: number;
    readonly detail?: string;
    readonly error_code?: string;
  }[];
}

const visible = { is_deleted: { $ne: true } } as const;
export function useCtoxThreads(instanceId: string | null) {
  return useCtoxQuery<CtoxThreadDocument>(instanceId, "user_threads", {
    selector: visible,
    sort: [{ updated_at_ms: "desc" }],
  });
}
export function useCtoxThread(instanceId: string | null, threadId: string | null) {
  const row = useCtoxDoc<CtoxThreadDocument>(instanceId, "user_threads", threadId);
  return row?.is_deleted === true ? null : row;
}
export function useCtoxThreadMessages(instanceId: string | null, threadId: string | null) {
  return useCtoxQuery<CtoxThreadMessageDocument>(
    threadId === null ? null : instanceId,
    "user_thread_messages",
    {
      selector: { ...visible, thread_id: threadId },
      sort: [{ created_at_ms: "asc" }],
    },
  );
}
export function useCtoxProjectChats(instanceId: string | null, projectId: string | null) {
  return useCtoxQuery<CtoxProjectChatDocument>(
    projectId === null ? null : instanceId,
    "workjet_project_chats",
    { selector: { ...visible, project_id: projectId } },
  );
}
export function useCtoxSupervisorBinding(instanceId: string | null, projectId: string | null) {
  const row = useCtoxDoc<CtoxSupervisorBindingDocument>(
    instanceId,
    "workjet_supervisor_bindings",
    projectId,
  );
  if (row !== null && (row.id !== projectId || row.project_id !== projectId))
    throw new Error("invalid_supervisor_binding_scope");
  return row?.is_deleted === true ? null : row;
}
export function useCtoxWorkerProfileBindings(instanceId: string | null) {
  return useCtoxQuery<CtoxWorkerProfileBindingDocument>(
    instanceId,
    "workjet_worker_profile_bindings",
    {
      selector: { ...visible, status: "active" },
    },
  );
}
export function useWorkjetWorkerProfiles(instanceId: string | null) {
  const rows = useCtoxQuery<WorkjetWorkerProfile & CtoxSourceDocument>(
    instanceId,
    "workjet_worker_profiles",
    { selector: visible },
  );
  return useMemo(() => rows.map((row) => decodeWorkerProfile(row)), [rows]);
}
/** Crew-owned profile fields remain native data, never inferred from a binding or model label. */
export function useCtoxWorkerProfile(instanceId: string | null, crewMemberId: string | null) {
  return useCtoxDoc<CtoxSourceDocument & Readonly<Record<string, unknown>>>(
    instanceId,
    "ctox_crew_members",
    crewMemberId,
  );
}
export function useCtoxWorkerRuns(instanceId: string | null, crewMemberId: string | null) {
  return useCtoxQuery<CtoxWorkerRunDocument>(
    crewMemberId === null ? null : instanceId,
    "ctox_runs",
    { selector: { crew_member_id: crewMemberId }, sort: [{ finished_at_ms: "desc" }] },
  );
}
export function useCtoxWorkerTasks(instanceId: string | null, crewMemberId: string | null) {
  return useCtoxQuery<CtoxWorkerTaskDocument>(
    crewMemberId === null ? null : instanceId,
    "ctox_queue_tasks",
    {
      selector: {
        ...visible,
        $or: [{ crew_member_id: crewMemberId }, { crew_assigned_member_id: crewMemberId }],
      },
      sort: [{ updated_at_ms: "desc" }],
    },
  );
}
export function useCtoxMachines(instanceId: string | null) {
  return useCtoxQuery<CtoxMachineDocument>(instanceId, "workjet_computers", {
    selector: { ...visible, status: "assigned" },
  });
}
export function useCtoxMachineEnrollment(instanceId: string | null, enrollmentId: string | null) {
  return useCtoxDoc<CtoxMachineEnrollmentDocument>(instanceId, "machine_enrollments", enrollmentId);
}
/** Enrollment bootstrap is host-owned. This hook only enqueues the platform operations. */
export function useCtoxMachineEnrollmentCommands(instanceId: string | null) {
  const controls = useCtoxCommand(instanceId);
  return {
    ...controls,
    begin: (payload: { label: string; transport: "local" | "ssh" | "tailscale" }) =>
      controls.command("ctox.machine.enroll.begin", payload),
    cancel: (enrollmentId: string) =>
      controls.command("ctox.machine.enroll.cancel", { enrollment_id: enrollmentId }),
  };
}
export function useCtoxProjectFeed(instanceId: string | null, projectId: string | null) {
  return useCtoxQuery<CtoxWorkjetProjectFeedPost & CtoxSourceDocument>(
    projectId === null ? null : instanceId,
    "workjet_project_feed",
    {
      selector: { ...visible, project_id: projectId },
      sort: [{ occurred_at_ms: "desc" }],
      limit: 30,
    },
  );
}
