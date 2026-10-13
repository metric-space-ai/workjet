import { EnvironmentId } from "@workjet/contracts";
import * as Cause from "effect/Cause";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import chatIndexSource from "../routes/_chat.index.tsx?raw";
import {
  ProjectCloneFields,
  ProjectCreateRequirementLine,
  ProjectCreateSourceSegment,
  ProjectFolderFields,
} from "./ProjectCreateSources";
import {
  buildCloneRepositoryInput,
  buildProjectComputerOptions,
  cloneProjectRepository,
  deriveRepositoryFolderName,
  readableProjectTitle,
  findDuplicateProjectForName,
  joinCloneDestination,
  knownCloneTargetFolders,
  pickProjectFolder,
  readyCloneProviders,
  resolveProjectComputer,
} from "./ProjectCreateSources.logic";
import hookSource from "./useProjectCreateSources.ts?raw";

const local = EnvironmentId.make("environment-local");
const remote = EnvironmentId.make("environment-remote");

describe("Projekt anlegen: Segment Neu | Aus Ordner | Repository klonen", () => {
  it("renders the three sources as one inline segment", () => {
    const html = renderToStaticMarkup(
      <ProjectCreateSourceSegment value="folder" onChange={() => {}} />,
    );
    expect(html).toContain("Neu");
    expect(html).toContain("Aus Ordner");
    expect(html).toContain("Repository klonen");
    expect(html).not.toContain('role="dialog"');
  });

  it("puts the segment, folder and clone fields into the inline panel, no dialog", () => {
    const start = chatIndexSource.indexOf("function InlineProjectCreate(");
    const end = chatIndexSource.indexOf("export const Route", start);
    const panel = chatIndexSource.slice(start, end);
    expect(panel).toContain("<ProjectCreateSourceSegment");
    expect(panel).toContain("<ProjectFolderFields");
    expect(panel).toContain("<ProjectCloneFields");
    expect(panel).toContain("submitFromSource()");
    expect(panel).toContain("openCreatedProject(");
    expect(panel).toContain('"/settings/business-os"');
    expect(panel).not.toMatch(/<Dialog|CommandDialog|role="dialog"/);
  });
});

describe("Aus Ordner", () => {
  it("opens the desktop folder chooser and derives the name from the folder", async () => {
    const pickFolder = vi.fn(async () => "/Users/dev/projekte/workjet-site");
    const picked = await pickProjectFolder(pickFolder, {
      initialPath: "~/projekte",
      targetEnvironmentId: "wsl:Ubuntu",
    });
    expect(pickFolder).toHaveBeenCalledWith({
      initialPath: "~/projekte",
      targetEnvironmentId: "wsl:Ubuntu",
    });
    expect(picked).toEqual({ path: "/Users/dev/projekte/workjet-site", title: "workjet-site" });
  });

  it("passes no options for the plain native picker and accepts a cancel", async () => {
    const pickFolder = vi.fn(async () => null);
    expect(await pickProjectFolder(pickFolder, {})).toBeNull();
    expect(pickFolder).toHaveBeenCalledWith(undefined);
  });

  it("wires the panel's button to the pickFolder bridge", () => {
    expect(hookSource).toContain("api.dialogs.pickFolder(options)");
    expect(hookSource).toContain("resolveProjectPickerTarget(");
    const html = renderToStaticMarkup(
      <ProjectFolderFields
        computer={null}
        path="~/projekte/"
        onPathChange={() => {}}
        onPick={() => {}}
        suggestions={[
          { name: "alpha", fullPath: "/Users/dev/projekte/alpha" },
          { name: "beta", fullPath: "/Users/dev/projekte/beta" },
        ]}
        onSuggestion={() => {}}
      />,
    );
    expect(html).toContain("Ordner wählen");
    expect(html).toContain('data-workjet-folder-suggestion="/Users/dev/projekte/alpha"');
    expect(html).toContain("beta");
  });

  it("hides „Ordner wählen“ where no folder chooser can be routed", () => {
    const html = renderToStaticMarkup(
      <ProjectFolderFields
        computer={null}
        path=""
        onPathChange={() => {}}
        onPick={null}
        suggestions={[]}
        onSuggestion={() => {}}
      />,
    );
    expect(html).not.toContain("Ordner wählen");
    expect(html).toContain('aria-label="Ordner"');
  });
});

describe("Repository klonen", () => {
  it("clones a Git URL into base folder plus repository name", async () => {
    const cloneRepository = vi.fn(async () => ({
      _tag: "Success" as const,
      value: { cwd: "/Users/dev/projekte/workjet", remoteUrl: "x", repository: null },
    }));
    const cwd = await cloneProjectRepository(cloneRepository as never, {
      environmentId: local,
      provider: "url",
      repository: "https://github.com/metricspace/workjet.git",
      baseDirectory: "~/projekte/",
    });
    expect(cloneRepository).toHaveBeenCalledWith({
      environmentId: local,
      input: {
        remoteUrl: "https://github.com/metricspace/workjet.git",
        destinationPath: "~/projekte/workjet",
      },
    });
    expect(cwd).toBe("/Users/dev/projekte/workjet");
  });

  it("clones a provider repository by owner/repo", () => {
    expect(
      buildCloneRepositoryInput({
        environmentId: remote,
        provider: "github",
        repository: "metricspace/ctox",
        baseDirectory: "/srv/code",
      }),
    ).toEqual({
      provider: "github",
      repository: "metricspace/ctox",
      destinationPath: "/srv/code/ctox",
    });
  });

  it("reports a clone failure and refuses an empty repository", async () => {
    const failing = vi.fn(async () => ({
      _tag: "Failure" as const,
      cause: Cause.fail(new Error("Zielordner nicht leer.")),
    }));
    await expect(
      cloneProjectRepository(failing as never, {
        environmentId: local,
        provider: "url",
        repository: "   ",
        baseDirectory: "~/",
      }),
    ).rejects.toThrow("Repository fehlt.");
    expect(failing).not.toHaveBeenCalled();
    await expect(
      cloneProjectRepository(failing as never, {
        environmentId: local,
        provider: "url",
        repository: "git@github.com:a/b.git",
        baseDirectory: "~/",
      }),
    ).rejects.toThrow("Zielordner nicht leer.");
  });

  it("derives folder names from URLs, SSH remotes and owner/repo", () => {
    expect(deriveRepositoryFolderName("https://github.com/a/b.git")).toBe("b");
    expect(deriveRepositoryFolderName("git@github.com:a/site.git")).toBe("site");
    expect(deriveRepositoryFolderName("owner/repo/")).toBe("repo");
    expect(readableProjectTitle("metric")).toBe("Metric");
    expect(readableProjectTitle("light-gun-heroes")).toBe("Light Gun Heroes");
    expect(readableProjectTitle("WorkJet")).toBe("WorkJet");
    expect(deriveRepositoryFolderName("")).toBe("");
    expect(joinCloneDestination("", "x")).toBe("~/x");
    expect(joinCloneDestination("/", "x")).toBe("/x");
    expect(joinCloneDestination("C:\\Code\\", "x")).toBe("C:\\Code\\x");
  });

  it("offers a provider only when it is installed and signed in", () => {
    expect(readyCloneProviders(null)).toEqual(["url"]);
    const discovery = {
      sourceControlProviders: [
        { kind: "github", status: "available", auth: { status: "authenticated" } },
        { kind: "gitlab", status: "available", auth: { status: "unauthenticated" } },
        { kind: "bitbucket", status: "missing", auth: { status: "unknown" } },
      ],
    };
    expect(readyCloneProviders(discovery as never)).toEqual(["url", "github"]);
  });

  it("renders URL, provider choice and target folder inline", () => {
    const html = renderToStaticMarkup(
      <ProjectCloneFields
        computer={null}
        providers={["url", "github"]}
        provider="url"
        onProviderChange={() => {}}
        repository=""
        onRepositoryChange={() => {}}
        baseDirectory="~/projekte"
        onBaseDirectoryChange={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Repository"');
    expect(html).toContain('aria-label="Anbieter"');
    // One destination line with one button; the folder controls stay closed (#507).
    expect(html).toContain("Wird geklont nach ~/projekte/…");
    expect(html).toContain('data-workjet-action="project.add.clone.change-target"');
    expect(html).not.toContain('aria-label="Zielordner"');
    const urlOnly = renderToStaticMarkup(
      <ProjectCloneFields
        computer={null}
        providers={["url"]}
        provider="url"
        onProviderChange={() => {}}
        repository=""
        onRepositoryChange={() => {}}
        baseDirectory="~/"
        onBaseDirectoryChange={() => {}}
      />,
    );
    expect(urlOnly).not.toContain('aria-label="Anbieter"');
  });

  it("offers known folders and „Ordner wählen“ for the target folder, free text as fallback", () => {
    expect(
      knownCloneTargetFolders("~/projekte/", [
        "/Users/m/code/alpha",
        "/Users/m/code/beta",
        null,
        "~/projekte/gamma",
      ]),
    ).toEqual([
      { path: "~/projekte", label: "projekte" },
      { path: "/Users/m/code", label: "code" },
    ]);
    const html = renderToStaticMarkup(
      <ProjectCloneFields
        computer={null}
        providers={["url"]}
        provider="url"
        onProviderChange={() => {}}
        repository=""
        onRepositoryChange={() => {}}
        baseDirectory="~/projekte/"
        onBaseDirectoryChange={() => {}}
        targetFolders={knownCloneTargetFolders("~/projekte", ["/Users/m/code/alpha"])}
        onPickTarget={() => {}}
        defaultEditingTarget
      />,
    );
    expect(html).toContain('data-workjet-clone-target="~/projekte"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('data-workjet-action="project.add.clone.pick-target"');
    expect(html).toContain("Ordner wählen");
    expect(html).toContain('aria-label="Zielordner"');
  });

  it("stacks provider and URL at narrow width instead of truncating", () => {
    const html = renderToStaticMarkup(
      <ProjectCloneFields
        computer={null}
        providers={["url", "github"]}
        provider="url"
        onProviderChange={() => {}}
        repository="https://github.com/metric-space-ai/workjet.git"
        onRepositoryChange={() => {}}
        baseDirectory="~/"
        onBaseDirectoryChange={() => {}}
      />,
    );
    expect(html).toContain("grid min-w-0 gap-2 sm:flex");
  });
});

describe("Rechner und fehlende Voraussetzungen", () => {
  it("lists connected computers first with this computer on top", () => {
    const options = buildProjectComputerOptions([
      { environmentId: remote, label: "gpu3", isPrimary: false, connected: true },
      { environmentId: local, label: "Local", isPrimary: true, connected: true },
      {
        environmentId: EnvironmentId.make("environment-off"),
        label: "alt",
        isPrimary: false,
        connected: false,
      },
    ]);
    expect(options.map((option) => option.label)).toEqual(["Dieser Rechner", "gpu3", "alt"]);
    expect(resolveProjectComputer(options, null)).toBe(local);
    expect(resolveProjectComputer(options, remote)).toBe(remote);
    expect(resolveProjectComputer(options, EnvironmentId.make("environment-off"))).toBe(local);
    expect(resolveProjectComputer([], null)).toBeNull();
  });

  it("shows one status line with one button instead of a dead end", () => {
    const html = renderToStaticMarkup(
      <ProjectCreateRequirementLine
        text="Keine Instanz verbunden"
        actionLabel="Einstellungen › Instanzen"
        onAction={() => {}}
      />,
    );
    expect(html).toContain("Keine Instanz verbunden");
    expect(html).toContain("Einstellungen › Instanzen");
    expect(html).toContain("<button");
  });
});

describe("onboarding duplicates and names", () => {
  it("does not derive a name from a bare scheme or host", () => {
    expect(deriveRepositoryFolderName("https")).toBe("");
    expect(deriveRepositoryFolderName("https://")).toBe("");
    expect(deriveRepositoryFolderName("https://github.com")).toBe("");
    expect(deriveRepositoryFolderName("https://github.com/metric-space-ai/Metric.git")).toBe(
      "Metric",
    );
    expect(deriveRepositoryFolderName("git@github.com:metric-space-ai/metric.git")).toBe("metric");
    expect(deriveRepositoryFolderName("metric-space-ai/metric")).toBe("metric");
  });

  it("finds the existing project case-insensitively by title or folder", () => {
    const projects = [
      { title: "Metric", workspaceRoot: "/home/box/Metric" },
      { title: "Light Gun Heroes", workspaceRoot: "/home/box/vcop2-test" },
    ];
    expect(findDuplicateProjectForName(projects, "metric")?.title).toBe("Metric");
    expect(findDuplicateProjectForName(projects, "vcop2-test")?.title).toBe("Light Gun Heroes");
    expect(findDuplicateProjectForName(projects, "other")).toBeUndefined();
  });
});
