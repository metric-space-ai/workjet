import { ProjectId } from "@workjet/contracts";
import { describe, expect, it } from "vite-plus/test";
import type { GalleryProject } from "../../projectOverview";
import { instanceOnlyProjects, instanceProjectSettingsKey } from "./InstanceProjectSettings";

const entry = (id: string, title: string, extra: Partial<GalleryProject> = {}): GalleryProject => ({
  key: `welsch:${id}`,
  id,
  title,
  local: null,
  native: true,
  configuration: { id: ProjectId.make(id), title },
  ...extra,
});

describe("instance projects in settings (#492)", () => {
  it("lists native projects without a local copy, sorted by title", () => {
    const listed = instanceOnlyProjects([
      entry("b", "doomify.dev"),
      entry("a", "ctox.dev"),
      entry("c", "Local", { local: {} as NonNullable<GalleryProject["local"]> }),
      entry("d", "Legacy", { native: false }),
    ]);
    expect(listed.map((project) => project.title)).toEqual(["ctox.dev", "doomify.dev"]);
  });

  it("uses a route key that cannot collide with local project keys", () => {
    expect(instanceProjectSettingsKey("ctox-dev")).toBe("instance:ctox-dev");
  });
});
