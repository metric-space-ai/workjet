import { scopeProjectRef } from "@workjet/client-runtime/environment";
import { EnvironmentId, ProjectId } from "@workjet/contracts";
import { describe, expect, it } from "vite-plus/test";
import { ProjectOverviewSelectionStore } from "./projectOverviewSelection";

const ref = (environment: string, project: string) =>
  scopeProjectRef(EnvironmentId.make(environment), ProjectId.make(project));

describe("shared project overview navigation", () => {
  it("notifies both the overview and sidebar when a card is selected", () => {
    const store = new ProjectOverviewSelectionStore();
    const observed: Array<unknown> = [];
    const stopOverview = store.subscribe(() => observed.push(store.read("welsch")));
    const stopSidebar = store.subscribe(() => observed.push(store.read("welsch")));
    const project = ref("computer-a", "ctox");
    store.select("welsch", project);
    expect(observed).toEqual([project, project]);
    stopOverview();
    stopSidebar();
  });

  it("clears All projects in one instance without selecting or clearing another instance", () => {
    const store = new ProjectOverviewSelectionStore();
    store.select("welsch", ref("computer-a", "ctox"));
    const other = ref("computer-b", "same-project-id");
    store.select("other", other);
    store.select("welsch", null);
    expect(store.read("welsch")).toBeNull();
    expect(store.read("other")).toBe(other);
    expect(store.read(null)).toBeNull();
  });

  it("keeps the snapshot stable for the same project and releases unsubscribed readers", () => {
    const store = new ProjectOverviewSelectionStore();
    const first = ref("computer-a", "ctox");
    let notifications = 0;
    const unsubscribe = store.subscribe(() => notifications++);
    store.select("welsch", first);
    store.select("welsch", ref("computer-a", "ctox"));
    expect(store.read("welsch")).toBe(first);
    expect(notifications).toBe(1);
    unsubscribe();
    store.select("welsch", null);
    expect(notifications).toBe(1);
  });
});
