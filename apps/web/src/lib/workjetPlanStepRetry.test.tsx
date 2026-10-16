import { renderToStaticMarkup } from "react-dom/server";
import { CommandId, type CtoxWorkjetProjectControlRequest } from "@workjet/contracts";
import { describe, expect, it } from "vite-plus/test";
import { ThreadErrorBanner } from "../components/chat/ThreadErrorBanner";
import type { WorkjetProjectControlPort } from "../workjetProjectControl";
import {
  PLAN_STEP_RETRY_COMMAND,
  isPlanStepRetryAvailable,
  requestPlanStepRetry,
  runPlanStepRetry,
} from "./workjetPlanStepRetry";

function port(
  answer: (
    request: CtoxWorkjetProjectControlRequest,
  ) => Awaited<ReturnType<WorkjetProjectControlPort>>,
) {
  const seen: CtoxWorkjetProjectControlRequest[] = [];
  const control: WorkjetProjectControlPort = async (_instanceId, request) => {
    seen.push(request);
    return answer(request);
  };
  return { control, seen };
}
const echoCommandId = (request: CtoxWorkjetProjectControlRequest) =>
  request.action === "ctox.plan.step.retry" ? request.commandId : CommandId.make("none");
const banner = (instanceId: string, stepId: string) =>
  renderToStaticMarkup(
    <ThreadErrorBanner error="Schritt fehlgeschlagen" planStep={{ instanceId, stepId }} />,
  );

describe("plan step retry (ctox#872, Audit B #24)", () => {
  it("sends ctox.plan.step.retry with exactly { step_id }", async () => {
    const { control, seen } = port((request) => ({
      _tag: "completed",
      response: {
        action: "ctox.plan.step.retry",
        commandId: echoCommandId(request),
        status: "pending",
      },
    }));
    expect(await requestPlanStepRetry("instance-a", "step-1", control)).toBe("retried");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.action).toBe(PLAN_STEP_RETRY_COMMAND);
    expect(PLAN_STEP_RETRY_COMMAND).toBe("ctox.plan.step.retry");
    expect("payload" in seen[0]! ? seen[0].payload : null).toEqual({ step_id: "step-1" });
  });

  it("hides the button when the instance does not know the command", async () => {
    expect(banner("instance-old", "step-1")).toContain("Erneut versuchen");
    const { control } = port(() => ({ _tag: "failed", code: "unsupported" }));
    expect(await runPlanStepRetry("instance-old", "step-1", control)).toBe("unsupported");
    expect(isPlanStepRetryAvailable("instance-old", "step-2")).toBe(false);
    const hidden = banner("instance-old", "step-1");
    expect(hidden).not.toContain("Erneut versuchen");
    expect(hidden).not.toContain("aktualisieren");
    expect(hidden).toContain("Schritt fehlgeschlagen");
  });

  it("hides the button on core_outdated, without an error line", async () => {
    const { control } = port(() => ({
      _tag: "failed",
      code: "guest_failed",
      diagnostic: { stage: "execute", reason: "core_outdated" },
    }));
    expect(await runPlanStepRetry("instance-outdated", "step-1", control)).toBe("unsupported");
    const hidden = banner("instance-outdated", "step-1");
    expect(hidden).not.toContain("Erneut versuchen");
    expect(hidden).not.toContain("CTOX-Core");
  });

  it("keeps the button after a transient failure and drops it after a confirmed retry", async () => {
    const failing = port(() => ({ _tag: "failed", code: "timeout" }));
    expect(await runPlanStepRetry("instance-b", "step-1", failing.control)).toBe("failed");
    expect(banner("instance-b", "step-1")).toContain("Erneut versuchen");
    const wrong = port(() => ({
      _tag: "completed",
      response: {
        action: "ctox.plan.step.retry",
        commandId: CommandId.make("other"),
        status: "pending",
      },
    }));
    expect(await runPlanStepRetry("instance-b", "step-1", wrong.control)).toBe("failed");
    const ok = port((request) => ({
      _tag: "completed",
      response: {
        action: "ctox.plan.step.retry",
        commandId: echoCommandId(request),
        status: "pending",
      },
    }));
    expect(await runPlanStepRetry("instance-b", "step-1", ok.control)).toBe("retried");
    expect(banner("instance-b", "step-1")).not.toContain("Erneut versuchen");
    expect(banner("instance-b", "step-2")).toContain("Erneut versuchen");
  });

  it("shows no retry without a known plan step", () => {
    expect(
      renderToStaticMarkup(<ThreadErrorBanner error="Schritt fehlgeschlagen" />),
    ).not.toContain("Erneut versuchen");
  });
});
