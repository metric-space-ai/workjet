import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const add = vi.fn();
vi.mock("../ui/toast", () => ({ toastManager: { add } }));

const { DESKTOP_MENU_FEEDBACK_ACTIONS, handleDesktopMenuFeedback } =
  await import("./desktopMenuFeedback");

afterEach(() => add.mockReset());

describe("handleDesktopMenuFeedback (D44: Rückmeldung in der App statt nativer Dialog)", () => {
  it("shows one German line per menu result", () => {
    for (const action of Object.values(DESKTOP_MENU_FEEDBACK_ACTIONS)) {
      expect(handleDesktopMenuFeedback(action, undefined)).toBe(true);
    }
    const titles = add.mock.calls.map(([toast]) => toast.title as string);
    expect(titles).toEqual([
      "Workjet ist aktuell",
      "Update-Prüfung fehlgeschlagen",
      "Updates hier nicht verfügbar",
      "Support-Paket gespeichert, Pfad kopiert",
      "Support-Paket nicht gespeichert",
    ]);
    for (const [toast] of add.mock.calls) expect(toast.description).toBeUndefined();
  });

  it("offers exactly one retry on a failed update check", () => {
    handleDesktopMenuFeedback(DESKTOP_MENU_FEEDBACK_ACTIONS.updateCheckFailed, {
      checkForUpdate: async () => ({ checked: true, state: { status: "up-to-date" } as never }),
    });
    expect(add.mock.calls[0]?.[0].actionProps.children).toBe("Erneut prüfen");
  });

  it("ignores other menu actions", () => {
    expect(handleDesktopMenuFeedback("open-settings", undefined)).toBe(false);
    expect(add).not.toHaveBeenCalled();
  });
});
