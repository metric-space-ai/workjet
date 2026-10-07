import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ProjectId } from "@workjet/contracts";
import { ProjectCalendar } from "./ProjectCalendar";
import type { GalleryProject } from "../projectOverview";

function project(id: string, meeting?: { weekday: number; time: string; timezone: string }) {
  return {
    key: `instance:${id}`,
    id,
    title: id,
    native: true,
    local: null,
    configuration: { id: ProjectId.make(id), title: id, ...(meeting ? { jourFixe: meeting } : {}) },
    onOpen: () => {},
  } satisfies GalleryProject & { onOpen: () => void };
}

describe("weekly project calendar", () => {
  it("preserves the native weekday, wall-clock time and timezone without inventing dates", () => {
    const html = renderToStaticMarkup(<ProjectCalendar projects={[
      project("ctox.dev", { weekday: 3, time: "09:30", timezone: "Europe/Berlin" }),
      project("greppy.xyz", { weekday: 3, time: "08:00", timezone: "America/New_York" }),
    ]} />);
    const wednesday = html.slice(html.indexOf('aria-label="Wednesday"'), html.indexOf('aria-label="Thursday"'));
    expect(wednesday).toContain("09:30");
    expect(wednesday).toContain("Europe/Berlin");
    expect(wednesday).toContain("08:00");
    expect(wednesday).toContain("America/New_York");
    expect(wednesday.indexOf("greppy.xyz")).toBeLessThan(wednesday.indexOf("ctox.dev"));
    expect(html).not.toContain("No regular meeting configured");
    expect(html).not.toContain("datetime=");
  });

  it("keeps projects with no native meeting visible and does not manufacture appointments", () => {
    const html = renderToStaticMarkup(<ProjectCalendar projects={[project("miltonticket.app")]} />);
    expect(html).toContain('aria-label="Projects without a regular meeting"');
    expect(html).toContain("miltonticket.app");
    expect(html).toContain('data-workjet-action="project.open.calendar:instance:miltonticket.app"');
    expect(html).not.toContain("Europe/Berlin");
    expect(html).not.toContain("09:00");
  });
});
