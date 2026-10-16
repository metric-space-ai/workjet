import { workjetUiLanguage } from "../../workjetProjectControl";

/**
 * Die Instanz kennt eine Aktion noch nicht (Bridge antwortet „unsupported“). Statt eines
 * endlosen Ladeskeletts oder eines falschen „nicht verbunden“ steht klar, was fehlt (#799).
 */
export function InstanceUpdateRequired(props: { readonly feature?: string }) {
  const en = workjetUiLanguage() === "en";
  return (
    <div
      role="status"
      data-workjet-instance-update-required=""
      className="flex flex-col gap-0.5 px-3 py-2.5 text-[13px] sm:px-4"
    >
      <span className="font-medium text-foreground">
        {en ? "Instance update required" : "Instanz-Update nötig"}
      </span>
      <span className="text-muted-foreground">
        {en
          ? `This instance does not support ${props.feature ?? "this feature"} yet. It appears here after the instance is updated.`
          : `Diese Instanz unterstützt ${props.feature ?? "diese Funktion"} noch nicht. Nach einem Update der Instanz erscheint sie hier.`}
      </span>
    </div>
  );
}
