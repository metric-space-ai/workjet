import { describe, expect, it, vi } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { ComposerBar } from "./ComposerBar";
import { ComposerAttachmentMenu } from "./ComposerAttachmentMenu";
import { ComposerWorkerControl } from "./ComposerWorkerControl";
import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { ComposerDictationButton } from "./ComposerDictationButton";
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

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
            <button>Modell</button>
            <button>Rechner</button>
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
  it("orders attachment-only plus, Manuell, harness, model, computer, gear, mic and send", () => {
    const html = render();
    const labels = [
      'aria-label="Anhang hinzufügen"',
      ">Manuell<",
      ">Harness<",
      ">Modell<",
      ">Rechner<",
      'aria-label="Optionen"',
      'aria-label="Diktieren"',
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
    expect(html).not.toContain(">Manuell<");
    for (const label of ["Harness", "Modell", "Rechner"]) expect(html).not.toContain(`>${label}<`);
    expect(html).toContain('aria-label="Optionen"');
    expect(html).toContain('aria-label="Diktieren"');
  });
});
