import { describe, expect, it, vi } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { ComposerBar, ComposerBarLayout } from "./ComposerBar";
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
      ">Ohne Preset<",
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
  });
  it("folds the target chips into ONE collapse chip in a narrow composer (Audit B #6)", () => {
    const html = renderToStaticMarkup(
      <ComposerBarLayout
        narrow
        targetSummary="Molecularity"
        attachments={<button>Anhang</button>}
        worker={<button>Preset</button>}
        manual={
          <>
            <button>Harness</button>
            <button>Modell</button>
            <button>Rechner</button>
          </>
        }
        settings={<button>Optionen</button>}
        dictation={<button>Diktieren</button>}
      />,
    );
    expect(html.match(/data-composer-bar-collapsed="true"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Ziel wählen"');
    expect(html).toContain(">Molecularity<");
    // The chips are not laid out inline next to the collapse chip.
    expect(html).not.toMatch(/data-composer-bar-target="true"[^>]*>\s*<button>Preset</);
    // Folded inline under the bar (no popover), mounted but hidden until opened.
    expect(html).toMatch(/data-composer-bar-collapsed-targets="true" hidden=""/);
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("popover");
  });
  it("lays the target chips out inline when the composer is wide", () => {
    const html = render();
    expect(html).not.toContain("data-composer-bar-collapsed");
  });
  it("keeps a chosen Luma in the bar without competing manual controls", () => {
    const html = render(true);
    expect(html).toContain("Selected Luma");
    expect(html).not.toContain(">Ohne Preset<");
    for (const label of ["Harness", "Modell", "Rechner"]) expect(html).not.toContain(`>${label}<`);
    expect(html).toContain('aria-label="Optionen"');
    expect(html).toContain('aria-label="Diktieren"');
  });
});
