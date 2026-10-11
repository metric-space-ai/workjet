/** Loopback-only sanitized UI profile backed by the real engine and UsageService fixture. */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { EnvironmentId, type ProjectOverview, type UsageSummary } from "@workjet/contracts";
import { mergeUsage } from "@workjet/shared/usageMerge";
import { ProjectOverviewEditor } from "../components/ProjectOverviewEditor";
import { ProjectTokenBudgetSummary } from "../components/ProjectTokenBudgetSummary";
import { TooltipProvider } from "../components/ui/tooltip";
import { Button } from "../components/ui/button";
import "../index.css";

if (!import.meta.env.DEV || !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) throw new Error("Fixture is loopback development only.");
type State = { overview: ProjectOverview; summary: UsageSummary; cycle: { start: string; end: string } };
function Fixture() {
  const [state, setState] = useState<State | null>(null);
  const [settings, setSettings] = useState(false);
  const [error, setError] = useState("");
  const load = async () => {
    const response = await fetch("/fixture-budget");
    if (!response.ok) throw new Error("Fixture read failed");
    setState(await response.json() as State);
  };
  useEffect(() => { void load().catch(error => setError(String(error))); }, []);
  if (!state) return <p role="status">{error || "Loading isolated profile…"}</p>;
  const totals = mergeUsage([{ environmentId: EnvironmentId.make("budget-fixture"), label: "Isolated profile", summary: state.summary }], 4);
  const unknown = state.summary.projectThreads?.filter(thread => thread.status === "unknown").map(thread => thread.title) ?? [];
  return <TooltipProvider><main className="mx-auto grid max-w-3xl gap-6 p-5 sm:p-8">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-xl font-semibold">Projekt: Fixture</h1><p className="text-sm text-muted-foreground">Isoliertes Prüfprofil · Kalenderwoche Europe/Berlin</p></div>
      <Button onClick={() => setSettings(value => !value)}>{settings ? "Übersicht" : "Projekt-Einstellungen"}</Button>
    </header>
    {settings ? <section className="rounded-lg border border-border bg-card p-4"><h2 className="mb-4 text-lg font-medium">Projekt-Einstellungen</h2>
      <ProjectOverviewEditor key={state.overview.tokenBudget?.revision} overview={state.overview} onSave={async overview => {
        const response = await fetch("/fixture-budget", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(overview) });
        if (!response.ok) return false;
        setState(await response.json() as State); return true;
      }} />
    </section> : <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-medium">Fixture project</h2>
      <ProjectTokenBudgetSummary view={{ totals, cycle: state.cycle, limitBillions: state.overview.tokenBudget?.limitBillions ?? null, unknown,
        threads: (state.summary.projectThreads ?? []).map(thread => ({ title: thread.title, role: thread.role, tokens: state.summary.buckets.filter(bucket => bucket.threadId === thread.threadId).reduce((sum, bucket) => sum + bucket.totals.uncachedInputTokens + bucket.totals.cachedInputTokens + bucket.totals.cacheCreationTokens + bucket.totals.outputTokens, 0) })) }} />
      </div><p className="mt-6 text-sm text-muted-foreground">Supervisor · Persistent Worker · One-Shot Worker</p>
      <p className="mt-2 text-sm">Die Arbeit läuft bei Überschreitung weiter.</p>
    </section>}
    <output className="text-xs text-muted-foreground" data-fixture-revision={state.overview.tokenBudget?.revision}>Gespeicherte Revision: {state.overview.tokenBudget?.revision}</output>
  </main></TooltipProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
