import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { UserDataMigrationBanner } from "./UserDataMigrationDialog";

function render(previousAttemptFailed: boolean, responseError: string | null = null) {
  return renderToStaticMarkup(
    <UserDataMigrationBanner
      isResponding={false}
      offer={{ previousAttemptFailed }}
      responseError={responseError}
      onRespond={() => undefined}
    />,
  );
}

describe("user data migration banner", () => {
  it("offers the import as one inline line with two buttons, no modal", () => {
    const markup = render(false);
    expect(markup).toContain("data-user-data-migration-banner");
    expect(markup).toContain("Früheres Profil gefunden");
    expect(markup).toMatch(/data-user-data-migration-decline[^>]*>Überspringen</);
    expect(markup).toMatch(/data-user-data-migration-accept[^>]*>Importieren</);
    expect(markup).not.toContain('role="dialog"');
    expect(markup).not.toContain("aria-modal");
  });

  it("turns a failed attempt and a failed request into one status line", () => {
    expect(render(true)).toContain("Profilimport unvollständig");
    expect(render(true)).toMatch(/data-user-data-migration-accept[^>]*>Erneut importieren</);
    expect(render(false, "kein Platz")).toContain("Import fehlgeschlagen: kein Platz");
  });

  it("forwards the answer", () => {
    const answers: boolean[] = [];
    const element = UserDataMigrationBanner({
      isResponding: false,
      offer: { previousAttemptFailed: false },
      responseError: null,
      onRespond: (accept) => answers.push(accept),
    });
    const actions = (
      element.props as {
        actions: { props: { children: Array<{ props: { onClick: () => void } }> } };
      }
    ).actions.props.children;
    actions[0]?.props.onClick();
    actions[1]?.props.onClick();
    // Eine Knopfreihenfolge überall: [Importieren] [Überspringen].
    expect(answers).toEqual([true, false]);
  });
});
