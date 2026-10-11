import {
  ProjectId,
  ProviderInstanceId,
  type WorkjetSessionImportCandidate,
} from "@workjet/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { visitElements } from "../../test/reactElementTree";
import { SessionImportBrowser, type SessionImportBrowserProps } from "./SessionImportBrowser";

const candidate: WorkjetSessionImportCandidate = {
  candidateId: "wjsi_0123456789abcdef0123456789abcdef",
  source: "codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  title: "Improve the importer",
  workspaceRoot: "/workspace/source",
  workspaceAvailable: true,
  createdAt: "2026-10-02T10:00:00Z",
  updatedAt: "2026-10-02T11:00:00Z",
  sourceSizeBytes: 42,
  importedThreadId: null,
  previewMessages: [{ role: "user", text: "Please improve it" }],
};
function props(): SessionImportBrowserProps {
  return {
    open: true,
    onOpenChange: vi.fn(),
    inspection: { sources: [], candidates: [candidate], truncated: true, nextOffset: 20 },
    pending: false,
    error: null,
    query: "",
    onQueryChange: vi.fn(),
    source: "all",
    onSourceChange: vi.fn(),
    page: 0,
    onPageChange: vi.fn(),
    onRefresh: vi.fn(),
    selected: new Map(),
    onSelect: vi.fn(),
    onClearSelection: vi.fn(),
    onSelectAll: vi.fn(),
    preview: null,
    onPreview: vi.fn(),
    projects: [
      { id: ProjectId.make("project-a"), title: "Project A", workspaceRoot: "/workspace/a" },
    ],
    destination: "",
    onDestinationChange: vi.fn(),
    newProjectTitle: "",
    onNewProjectTitleChange: vi.fn(),
    workspaceRoot: "",
    onWorkspaceRootChange: vi.fn(),
    canImport: false,
    readOnly: false,
    progress: null,
    results: [],
    onImport: vi.fn(),
    onStop: vi.fn(),
    onOpenThread: vi.fn(),
  };
}
function control(input: SessionImportBrowserProps, label: string) {
  const element = visitElements(
    SessionImportBrowser(input),
    (node) => node.props["aria-label"] === label,
  );
  if (!element) throw new Error(`Missing accessible control: ${label}`);
  return element.props;
}

describe("conversation import browser controls", () => {
  it("keeps history without folder metadata selectable and marks its origin", () => {
    const unknown = { ...candidate, workspaceRoot: null, workspaceAvailable: false };
    const input = {
      ...props(),
      inspection: { sources: [], candidates: [unknown], truncated: false, nextOffset: null },
      preview: unknown,
    };
    const tree = SessionImportBrowser(input);
    expect(visitElements(tree, (node) => node.props.children === "—")).not.toBeNull();
    expect(
      visitElements(tree, (node) => node.props.children === "Kein Ordner erfasst"),
    ).not.toBeNull();
    (control(input, `${unknown.title} auswählen`).onCheckedChange as (value: boolean) => void)(
      true,
    );
    expect(input.onSelect).toHaveBeenCalledWith(unknown, true);
  });

  it("selects every matching page and disables selection while a query or operation is pending", () => {
    const input = props();
    (control(input, "Alle Treffer wählen").onClick as () => void)();
    expect(input.onSelectAll).toHaveBeenCalledOnce();
    expect(input.onSelect).not.toHaveBeenCalled();
    for (const state of [
      { pending: true },
      { readOnly: true },
      { progress: "Selecting conversations…" },
    ])
      expect(control({ ...input, ...state }, "Alle Treffer wählen").disabled).toBe(true);
  });

  it("opens a preview independently from selecting the conversation", () => {
    const input = props();
    (control(input, `Vorschau ${candidate.title}`).onClick as () => void)();
    expect(input.onPreview).toHaveBeenCalledWith(candidate);
    expect(input.onSelect).not.toHaveBeenCalled();
    (control(input, `${candidate.title} auswählen`).onCheckedChange as (value: boolean) => void)(
      true,
    );
    expect(input.onSelect).toHaveBeenCalledWith(candidate, true);
  });
  it("keeps off-page selection visible and requires an explicit destination", () => {
    const input = {
      ...props(),
      selected: new Map([[candidate.candidateId, candidate]]),
      inspection: { sources: [], candidates: [], truncated: false, nextOffset: null },
    };
    const confirm = visitElements(
      SessionImportBrowser(input),
      (node) => node.props["data-workjet-action"] === "session-import.confirm",
    );
    expect(confirm?.props.disabled).toBe(true);
    expect(control(input, "Zielprojekt").value).toBe("");
  });
  it("supports existing and new destination projects through the same visible selector", () => {
    const input = props();
    (control(input, "Zielprojekt").onChange as (event: { target: { value: string } }) => void)({
      target: { value: "new" },
    });
    expect(input.onDestinationChange).toHaveBeenCalledWith("new");
    expect(control({ ...input, destination: "new" }, "Projektname")).toBeDefined();
    expect(control({ ...input, destination: "new" }, "Projektordner")).toBeDefined();
  });
  it("disables writes for read-only connections and holds the inline section during an import", () => {
    const input = { ...props(), readOnly: true, progress: "Importing 1–20 of 40…" };
    expect(control(input, `${candidate.title} auswählen`).disabled).toBe(true);
    expect(control(input, "Zielprojekt").disabled).toBe(true);
    const close = control(input, "Schließen");
    expect(close.disabled).toBe(true);
    (close.onClick as () => void)();
    expect(input.onOpenChange).not.toHaveBeenCalled();
  });

  it("renders inline instead of a dialog and closes through its own button", () => {
    const input = props();
    const root = SessionImportBrowser(input);
    expect(root?.type).toBe("div");
    expect(root?.props["data-workjet-action"]).toBe("session-import.browser");
    expect(visitElements(root, (node) => node.props["role"] === "dialog")).toBeNull();
    (control(input, "Schließen").onClick as () => void)();
    expect(input.onOpenChange).toHaveBeenCalledWith(false);
    expect(SessionImportBrowser({ ...input, open: false })).toBeNull();
  });
});
