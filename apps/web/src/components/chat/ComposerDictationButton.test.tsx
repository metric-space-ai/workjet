import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CommandId } from "@workjet/contracts";
import { ComposerDictationButton } from "./ComposerDictationButton";
import { requestSpeechSettings } from "../../lib/workjetSpeechSettings";
import { captureJourFixeMicrophone } from "../../lib/jourFixeBrowserMicrophone";

const hooks = vi.hoisted(() => ({
  values: [] as unknown[],
  refs: [] as unknown[],
  valueIndex: 0,
  refIndex: 0,
  effects: [] as Array<() => () => void>,
}));
const stream = vi.hoisted(() => ({
  open: vi.fn(async () => {}),
  write: vi.fn(),
  finish: vi.fn(async () => "A dictated message"),
  cancel: vi.fn(),
}));
const capture = vi.hoisted(() => ({ finish: vi.fn(async () => {}), cancel: vi.fn() }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: <T,>(initial: T) => {
    const index = hooks.valueIndex++;
    if (hooks.values.length <= index) hooks.values.push(initial);
    return [
      hooks.values[index] as T,
      (next: T) => {
        hooks.values[index] = next;
      },
    ] as const;
  },
  useRef: <T,>(initial: T) => {
    const index = hooks.refIndex++;
    if (hooks.refs.length <= index) hooks.refs.push({ current: initial });
    return hooks.refs[index] as { current: T };
  },
  useEffect: (effect: () => () => void) => {
    hooks.effects.push(effect);
  },
}));
vi.mock("../../lib/composerDictation", () => ({
  ComposerDictationStream: class {
    open = stream.open;
    write = stream.write;
    finish = stream.finish;
    cancel = stream.cancel;
  },
}));
vi.mock("../../lib/workjetSpeechSettings", () => ({ requestSpeechSettings: vi.fn() }));
vi.mock("../../lib/jourFixeBrowserMicrophone", () => ({ captureJourFixeMicrophone: vi.fn() }));
const configured = {
  action: "speech.settings.read",
  commandId: CommandId.make("speech-settings-test"),
  ttsCheck: null,
  status: {
    config: { synthesis: "mistral", transcription: "mistral", voice_id: null, rate: 1 },
    mistral_credential_present: true,
    mistral_voice_configured: false,
    streaming_stt_selected: true,
    stt: "available",
    tts: "unknown",
  },
} as const;
const onTranscript = vi.fn();
function render(instanceId: string | null = "selected-instance", disabled = false) {
  hooks.valueIndex = 0;
  hooks.refIndex = 0;
  return ComposerDictationButton({ instanceId, disabled, onTranscript });
}
function button(instanceId?: string | null, disabled = false) {
  return render(instanceId, disabled).props.children[0];
}
beforeEach(() => {
  hooks.values = [];
  hooks.refs = [];
  hooks.effects = [];
  vi.clearAllMocks();
  vi.stubGlobal("window", { location: { hash: "#/projects" } });
  vi.mocked(requestSpeechSettings).mockResolvedValue(configured);
  vi.mocked(captureJourFixeMicrophone).mockResolvedValue(capture);
});
afterEach(() => {
  for (const effect of hooks.effects) effect()();
  vi.unstubAllGlobals();
});
describe("composer microphone", () => {
  it("opens Speech settings without opening a microphone when no instance is configured", async () => {
    const microphone = button(null, true);
    expect(microphone.props.disabled).toBe(false);
    await microphone.props.onClick();
    expect(window.location.hash).toBe("#/settings/speech");
    expect(requestSpeechSettings).not.toHaveBeenCalled();
    expect(captureJourFixeMicrophone).not.toHaveBeenCalled();
  });
  it("opens Speech settings when its configured backend is unavailable", async () => {
    vi.mocked(requestSpeechSettings).mockResolvedValue({
      ...configured,
      status: { ...configured.status, stt: "unavailable" },
    });
    await button().props.onClick();
    expect(window.location.hash).toBe("#/settings/speech");
    expect(stream.open).not.toHaveBeenCalled();
    expect(captureJourFixeMicrophone).not.toHaveBeenCalled();
  });
  it("records through the selected instance and appends text only after Stop", async () => {
    await button().props.onClick();
    expect(requestSpeechSettings).toHaveBeenCalledWith(
      "selected-instance",
      { action: "speech.settings.read" },
      expect.any(AbortSignal),
    );
    expect(stream.open).toHaveBeenCalledTimes(1);
    expect(captureJourFixeMicrophone).toHaveBeenCalledTimes(1);
    expect(onTranscript).not.toHaveBeenCalled();
    const stop = button("selected-instance", true);
    expect(stop.props["aria-label"]).toBe("Stop dictation");
    expect(stop.props.disabled).toBe(false);
    await stop.props.onClick();
    expect(capture.finish).toHaveBeenCalledTimes(1);
    expect(onTranscript).toHaveBeenCalledExactlyOnceWith("A dictated message");
    expect(button().props["aria-label"]).toBe("Dictate message");
  });
  it("cancels owned audio and transcription when leaving the composer", async () => {
    await button().props.onClick();
    hooks.effects[0]!()();
    expect(capture.cancel).toHaveBeenCalledTimes(1);
    expect(stream.cancel).toHaveBeenCalledTimes(1);
    expect(onTranscript).not.toHaveBeenCalled();
  });
});
