import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { ComposerBar } from "./ComposerBar";
import { ComposerAttachmentMenu } from "./ComposerAttachmentMenu";
import { ComposerWorkerControl } from "./ComposerWorkerControl";
import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { ComposerDictationButton } from "./ComposerDictationButton";

function render(workerMode = false) {
  return renderToStaticMarkup(
    <ComposerBar
      attachments={<ComposerAttachmentMenu onAttachImages={() => {}} onAddProjectFile={() => {}} />}
      worker={
        workerMode ? (
          <span>Selected Luma</span>
        ) : (
          <ComposerWorkerControl
            workers={[]}
            selectedWorkerId={null}
            onSelectWorker={() => {}}
            onOpenWorkjetSettings={() => {}}
          />
        )
      }
      manual={
        workerMode ? null : (
          <>
            <button>Harness</button>
            <button>Model</button>
            <button>Computer</button>
          </>
        )
      }
      settings={
        <CompactComposerControlsMenu
          interactionMode="default"
          showInteractionModeToggle
          onToggleInteractionMode={() => {}}
        />
      }
      dictation={<ComposerDictationButton instanceId={null} onTranscript={() => {}} />}
      actions={<button type="submit">Send</button>}
    />,
  );
}
describe("shared composer bar", () => {
  it("orders attachment-only plus, Manual, harness, model, computer, gear, mic and send", () => {
    const html = render();
    const labels = [
      'aria-label="Add images or project files"',
      ">Manual<",
      ">Harness<",
      ">Model<",
      ">Computer<",
      'aria-label="Advanced settings"',
      'aria-label="Dictate message"',
      ">Send<",
    ];
    const positions = labels.map((label) => html.indexOf(label));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(html).toContain("lucide-plus");
    expect(html).toContain("lucide-settings");
  });
  it("keeps a chosen Luma in the bar without competing manual controls", () => {
    const html = render(true);
    expect(html).toContain("Selected Luma");
    expect(html).not.toContain(">Manual<");
    for (const label of ["Harness", "Model", "Computer"]) expect(html).not.toContain(`>${label}<`);
    expect(html).toContain('aria-label="Advanced settings"');
    expect(html).toContain('aria-label="Dictate message"');
  });
});
