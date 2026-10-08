import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { JourFixeSpeechRoom } from "./JourFixeSpeechRoom";
import type { JourFixeSpeechProvider } from "../lib/jourFixeSpeech";
import { nativeJourFixeNarrationProvider } from "../lib/nativeJourFixeNarrationProvider";
import type { JourFixeRoomSnapshot } from "../lib/jourFixeRoom";
import fixture from "../fixtures/jour-fixe.contract.json";

const meeting = fixture.meeting as JourFixeRoomSnapshot;
const props = {
  instanceId: "instance",
  projectTitle: "Fixture",
  meeting,
  onBack: () => {},
  onMessage: async () => {},
};
const provider = (kind: JourFixeSpeechProvider["kind"]): JourFixeSpeechProvider => ({
  kind,
  startListening: async () => {
    throw new Error("Fixture only");
  },
  prepareNarration: async () => {
    throw new Error("Fixture only");
  },
});
describe("Jour fixe speech room hook", () => {
  it("leaves the microphone unavailable without an installed adapter", () => {
    const html = renderToStaticMarkup(
      <JourFixeSpeechRoom {...props} meeting={{ ...meeting, state: "live" }} />,
    );
    expect(html).not.toContain("Start microphone");
  });
  it("keeps live microphone capture unavailable when only native narration is installed", () => {
    const html = renderToStaticMarkup(
      <JourFixeSpeechRoom
        {...props}
        speechProvider={nativeJourFixeNarrationProvider}
        meeting={{ ...meeting, state: "live" }}
      />,
    );
    expect(html).not.toContain("Start microphone");
    expect(html).toContain("Next slide");
  });
  it("keeps the same room controls for the local helper and gateway", () => {
    const render = (kind: JourFixeSpeechProvider["kind"]) =>
      renderToStaticMarkup(
        <JourFixeSpeechRoom
          {...props}
          speechProvider={provider(kind)}
          meeting={{ ...meeting, state: "live" }}
        />,
      );
    expect(render("local-helper")).toBe(render("ctox-gateway"));
    expect(render("local-helper")).toContain("Start microphone");
  });
  it("does not offer live capture during review", () => {
    const html = renderToStaticMarkup(
      <JourFixeSpeechRoom {...props} speechProvider={provider("local-helper")} />,
    );
    expect(html).not.toContain("Start microphone");
  });
});
