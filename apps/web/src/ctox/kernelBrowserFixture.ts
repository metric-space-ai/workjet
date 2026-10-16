import { createKernel } from "./kernel/kernel.mjs";
import { seedKernelTestShell } from "./kernelTestHost";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { mountWorkjetHost } from "./hostMount";
import { KernelTransport } from "./kernel/transport.mjs";
import { useCtoxQuery } from "./hooks";
import type { WorkjetProjectKpiDocument } from "./workjetCollections";

/** Synthetic receipt-shaped data only; this does not claim native KPI computation. */
function fixtureKpis(n: number) {
  const projectId = `p${n}`;
  return {
    id: projectId,
    project_id: projectId,
    revision: 1,
    items: [
      { id: "total", label: "Tasks", metric: "project_tasks_total", value: n + 3 },
      { id: "done", label: "Completed", metric: "project_tasks_completed", value: n },
      { id: "open", label: "Open", metric: "project_tasks_open", value: 3 },
    ].map((item) => ({
      prompt: { kpi_id: item.id, prompt: item.metric, revision: 1 },
      result: {
        status: "ready",
        snapshot: {
          project_id: projectId,
          kpi_id: item.id,
          prompt_revision: 1,
          label: item.label,
          value: item.value,
          display_value: String(item.value),
          unit: "count",
          sources: [
            {
              source_key: item.metric,
              kind: "native_metric",
              project_id: projectId,
              connection_id: "isolated-fixture",
              metric_key: item.metric,
              snapshot_revision: "fixture-1",
              evidence_ref: "fixture:local-read",
              observed_at_ms: 0,
              value: item.value,
            },
          ],
          computation: {
            recipe_id: item.metric,
            revision: 1,
            operation: "identity",
            input_keys: [item.metric],
            window_start_ms: 0,
            window_end_ms: 0,
          },
          freshness: { calculated_at_ms: 0, refresh_at_ms: 60000, fresh_until_ms: 120000 },
        },
      },
    })),
  };
}

/** Browser-only acceptance host: actual kernel + IndexedDB, deliberately disconnected transport. */
async function runKernelReadMeasurement(seed: boolean) {
  if (seed) {
    const preparing = createKernel({
      instanceId: "p11b-isolated",
      userId: "fixture-owner",
      storage: "indexeddb",
      transport: new KernelTransport(),
    });
    await preparing.ready;
    await seedKernelTestShell(preparing);
    await preparing.close();
  }
  const start = performance.now();
  const kernel = createKernel({
    instanceId: "p11b-isolated",
    userId: "fixture-owner",
    storage: "indexeddb",
    transport: new KernelTransport(),
  });
  await kernel.ready;
  if (seed) {
    for (const collection of ["workjet_projects", "workjet_project_kpis"]) {
      const sequenceOffset = collection === "workjet_projects" ? 0 : 12;
      await kernel.receivePage({
        epoch: "1",
        collection,
        scope_hash: "local",
        gen: 1,
        cursor_to: String(sequenceOffset + 12),
        complete: true,
        docs: Array.from({ length: 12 }, (_, n) => ({
          id: `p${n}`,
          seq: String(sequenceOffset + n + 1),
          rev: String(n + 1),
          data:
            collection === "workjet_projects"
              ? { id: `p${n}`, title: `Project ${n}`, workingCopies: [], status: "active" }
              : fixtureKpis(n),
        })),
      });
    }
  }
  const dataReadyMs = performance.now() - start;
  function LocalReadProbe() {
    const projects = useCtoxQuery<{ id: string; title: string }>(
      "p11b-isolated",
      "workjet_projects",
      {
        selector: { status: "active" },
      },
    );
    const kpis = useCtoxQuery<WorkjetProjectKpiDocument>(
      "p11b-isolated",
      "workjet_project_kpis",
      {},
    );
    return createElement(
      "section",
      null,
      projects.map((project) =>
        createElement(
          "article",
          {
            key: project.id,
            "data-project": project.id,
          },
          createElement("h2", null, project.title),
          kpis
            .find((row) => row.project_id === project.id)
            ?.items.map((item) =>
              createElement(
                "span",
                { key: item.prompt.kpi_id, "data-kpi": item.prompt.kpi_id },
                `${item.result.snapshot?.label} ${item.result.snapshot?.display_value}`,
              ),
            ),
        ),
      ),
    );
  }
  const container = document.createElement("main");
  document.body.append(container);
  const host = await mountWorkjetHost(container, kernel, {
    appVersion: "p11-c-browser",
    module: {
      mount: () => {
        const root = createRoot(container);
        flushSync(() => root.render(createElement(LocalReadProbe)));
        return { unmount: () => root.unmount() };
      },
    },
  });
  const committedMs = performance.now() - start;
  const result = {
    storage: kernel.storageKind,
    link: host.context.api.metrics.get().link.state,
    dataReadyMs,
    committedMs,
    projectCount: container.querySelectorAll("[data-project]").length,
    kpiValueCount: container.querySelectorAll("[data-kpi]").length,
    text: container.textContent,
  };
  await host.unmount();
  container.remove();
  await kernel.close();
  return result;
}

(
  globalThis as unknown as { runKernelReadMeasurement: typeof runKernelReadMeasurement }
).runKernelReadMeasurement = runKernelReadMeasurement;
