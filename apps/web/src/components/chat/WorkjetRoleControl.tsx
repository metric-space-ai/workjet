import type { WorkjetThreadConfig, WorkjetThreadRole } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { NetworkIcon, Settings2Icon, TerminalIcon, UsersIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { MenuGroup, MenuGroupLabel, MenuItem, MenuRadioGroup, MenuRadioItem } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * The direct `Code | Orchestrator` control for the CURRENT thread
 * (docs/workjet-plan.md → Wave 5). It sets `workjetConfig.role`, the field the
 * "Send to worker" panel, the worker overview, the delegation cards and the
 * cross-mode link cards already hang off. It sits BESIDE the provider-specific
 * Plan/Build control and never replaces it: Plan/Build chooses how the provider
 * behaves inside one thread, this chooses what the thread IS to Workjet.
 *
 * The control has three states, and only two of them are selectable:
 *
 *   Code          `role: "standard"` — an ordinary thread.
 *   Orchestrator  `role: "orchestrator"` — may delegate to workers.
 *   Worker        `role: "worker"` — READ-ONLY.
 *
 * Worker is read-only because of the contract, not because of a missing
 * feature: `WorkjetThreadConfig`'s worker variant REQUIRES a `parent`
 * reference, and only the dispatch that created the thread knows it. A client
 * cannot invent one, and dropping it would orphan the worker from the
 * orchestrator that is waiting on it. So on a worker thread the group renders a
 * single checked, `aria-disabled` "Worker" radio that still carries the reason
 * on hover — it names the real state and offers no silent conversion, rather
 * than showing an unselected Code/Orchestrator pair that would misreport the
 * thread or a greyed-out pair that would imply the conversion is merely
 * blocked.
 */

export type WorkjetSelectableRole = Exclude<WorkjetThreadRole, "worker">;

/**
 * The gear leads to the EXISTING Settings → Workjet surface. Naming the route
 * here keeps the control and its destination in one place and keeps the
 * composer from growing a second configuration surface.
 */
export const WORKJET_SETTINGS_ROUTE = "/settings/workjet" as const;

export const WORKJET_ROLE_FAILURE_TOAST = {
  type: "error",
  title: "Could not change the Workjet role",
  description: "This thread kept its previous role.",
  data: { hideCopyButton: true },
} as const;

/**
 * Why a worker thread cannot be converted here. Shown as the control's tooltip
 * and as the compact menu's description, so the refusal always carries a
 * reason.
 */
export const WORKJET_WORKER_ROLE_REASON =
  "This thread was created as a worker by its orchestrator. Its role travels with that dispatch and cannot be changed here.";

/**
 * The role is compiled into the managed system prompt when a provider session
 * starts, so a thread that already has turns keeps its current session until
 * the next one begins. Saying so is cheaper than letting the user infer that
 * nothing happened.
 */
export const WORKJET_ROLE_NEXT_SESSION_HINT =
  "Takes effect for the next provider session started in this thread.";

const ROLE_LABELS = {
  standard: "Code",
  orchestrator: "Orchestrator",
  worker: "Worker",
} as const satisfies Record<WorkjetThreadRole, string>;

const ROLE_ICONS = {
  standard: TerminalIcon,
  orchestrator: NetworkIcon,
  worker: UsersIcon,
} as const;

const SELECTABLE_ROLES = [
  "standard",
  "orchestrator",
] as const satisfies ReadonlyArray<WorkjetSelectableRole>;

const ROLE_TOOLTIPS = {
  standard: `Code — an ordinary thread. ${WORKJET_ROLE_NEXT_SESSION_HINT}`,
  orchestrator: `Orchestrator — this thread may delegate to workers. ${WORKJET_ROLE_NEXT_SESSION_HINT}`,
} as const satisfies Record<WorkjetSelectableRole, string>;

/**
 * Pure role transition. Returns the SAME object when nothing changes, which is
 * what lets the caller skip a pointless dispatch, exactly like
 * `setWorkjetCapabilityEnabled`.
 *
 * A worker configuration is returned unchanged: see the file comment.
 */
export function setWorkjetThreadRole(
  config: WorkjetThreadConfig,
  role: WorkjetSelectableRole,
): WorkjetThreadConfig {
  if (config.role === "worker") return config;
  if (config.role === role) return config;
  return { ...config, role, parent: null };
}

/**
 * Optimistic role change with revert, mirroring
 * `executeWorkjetCapabilityToggle`: show the next config immediately, dispatch
 * the WHOLE config, and on failure restore the previous one and raise exactly
 * one bounded toast. An interrupted command reverts silently — it is not a
 * server refusal.
 */
export async function executeWorkjetRoleChange<E>(input: {
  readonly currentConfig: WorkjetThreadConfig;
  readonly role: WorkjetSelectableRole;
  readonly dispatch: (nextConfig: WorkjetThreadConfig) => Promise<AtomCommandResult<unknown, E>>;
  readonly setVisibleConfig: (config: WorkjetThreadConfig) => void;
  readonly notifyFailure: () => void;
}): Promise<WorkjetThreadConfig> {
  const nextConfig = setWorkjetThreadRole(input.currentConfig, input.role);
  if (nextConfig === input.currentConfig) {
    return nextConfig;
  }

  input.setVisibleConfig(nextConfig);
  const result = await input.dispatch(nextConfig);
  if (result._tag === "Failure") {
    input.setVisibleConfig(input.currentConfig);
    if (!isAtomCommandInterrupted(result)) {
      input.notifyFailure();
    }
    return input.currentConfig;
  }

  return nextConfig;
}

export interface WorkjetRoleControlProps {
  readonly compact?: boolean;
  readonly role: WorkjetThreadRole;
  readonly busy: boolean;
  readonly disabled?: boolean;
  readonly onRoleChange: (role: WorkjetSelectableRole) => void;
  readonly onOpenSettings: () => void;
}

/**
 * One radio of the group. A plain function rather than a component so the
 * rendered tree — and therefore a test — sees the button element directly.
 *
 * The read-only worker state uses `aria-disabled` instead of `disabled`: a
 * `disabled` button emits no pointer events, which would swallow the very
 * tooltip that carries the reason. Transient states (busy, thread unavailable)
 * do use `disabled`, because there is nothing to explain.
 */
function roleRadio(input: {
  readonly key: string;
  readonly role: WorkjetThreadRole;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly readOnly: boolean;
  readonly busy: boolean;
  readonly tooltip: string;
  readonly onSelect?: (() => void) | undefined;
}) {
  const label = ROLE_LABELS[input.role];
  const icon = ROLE_ICONS[input.role];

  return (
    <Tooltip key={input.key}>
      <TooltipTrigger
        render={
          <ComposerControl
            type="button"
            role="radio"
            aria-checked={input.checked}
            aria-label={`${label} thread`}
            aria-busy={input.busy || undefined}
            aria-disabled={input.readOnly || undefined}
            data-workjet-role={input.role}
            data-workjet-role-checked={input.checked ? "true" : "false"}
            data-workjet-role-readonly={input.readOnly ? "true" : undefined}
            disabled={input.disabled}
            className={cn(
              "shrink-0 whitespace-nowrap",
              input.readOnly && "cursor-default opacity-64",
              input.checked
                ? "bg-accent text-accent-foreground hover:bg-accent/80"
                : "text-secondary-label hover:text-foreground",
            )}
            {...(input.onSelect ? { onClick: input.onSelect } : {})}
          />
        }
      >
        <ComposerControlIcon icon={icon} className={input.checked ? "opacity-100" : undefined} />
        <span className="sr-only sm:not-sr-only">{label}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{input.tooltip}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * The compact-footer form. The compact footer keeps only the model picker and
 * the primary actions inline and folds every other control into the overflow
 * menu, so the role becomes a radio group there and the gear becomes an item.
 * Both halves stay reachable; neither is dropped.
 */
export function WorkjetRoleMenuContent(props: WorkjetRoleControlProps) {
  const isWorker = props.role === "worker";
  const disabled = props.disabled === true || props.busy || isWorker;

  return (
    <MenuGroup>
      <MenuGroupLabel>Workjet</MenuGroupLabel>
      <MenuRadioGroup
        value={props.role}
        onValueChange={(value) => {
          if (!value || value === props.role || disabled) return;
          if (value !== "standard" && value !== "orchestrator") return;
          props.onRoleChange(value);
        }}
      >
        {isWorker ? (
          <MenuRadioItem value="worker" disabled>
            {ROLE_LABELS.worker}
          </MenuRadioItem>
        ) : null}
        {SELECTABLE_ROLES.map((role) => (
          <MenuRadioItem key={role} value={role} disabled={disabled}>
            {ROLE_LABELS[role]}
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
      <p className="max-w-72 px-2 pb-1.5 pt-1 text-muted-foreground text-xs leading-4">
        {isWorker ? WORKJET_WORKER_ROLE_REASON : WORKJET_ROLE_NEXT_SESSION_HINT}
      </p>
      <MenuItem onClick={props.onOpenSettings}>Workjet settings…</MenuItem>
    </MenuGroup>
  );
}

export function WorkjetRoleControl(props: WorkjetRoleControlProps) {
  if (props.compact) {
    return <WorkjetRoleMenuContent {...props} />;
  }

  const isWorker = props.role === "worker";
  const disabled = props.disabled === true || props.busy;

  return (
    <>
      <div
        role="radiogroup"
        aria-label="Workjet thread role"
        data-workjet-role-group="true"
        className="flex shrink-0 items-center gap-0.5"
      >
        {isWorker
          ? roleRadio({
              key: "worker",
              role: "worker",
              checked: true,
              disabled: false,
              readOnly: true,
              busy: props.busy,
              tooltip: WORKJET_WORKER_ROLE_REASON,
            })
          : SELECTABLE_ROLES.map((role) =>
              roleRadio({
                key: role,
                role,
                checked: props.role === role,
                disabled,
                readOnly: false,
                busy: props.busy,
                tooltip: ROLE_TOOLTIPS[role],
                onSelect: () => {
                  if (props.role === role) return;
                  props.onRoleChange(role);
                },
              }),
            )}
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerControl
              type="button"
              className="shrink-0 px-2"
              aria-label="Workjet settings"
              data-workjet-settings-gear="true"
              onClick={props.onOpenSettings}
            />
          }
        >
          <ComposerControlIcon icon={Settings2Icon} />
        </TooltipTrigger>
        <TooltipPopup side="top">Open Workjet settings</TooltipPopup>
      </Tooltip>
    </>
  );
}
