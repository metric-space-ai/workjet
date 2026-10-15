import { useAtomValue } from "@effect/atom-react";
import { useMemo } from "react";

import { primaryServerKeybindingsAtom } from "../../state/server";
import { Kbd } from "../ui/kbd";
import { Row } from "../ui/row";
import {
  buildKeybindingRows,
  commandLabel,
  keybindingPillParts,
} from "./KeybindingsSettings.logic";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

/** Tastenkürzel (Entwicklermodus, #568): alle wirksamen Kürzel als Zeilen. */
export function KeybindingsSettings() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const rows = useMemo(() => buildKeybindingRows(keybindings, ""), [keybindings]);
  return (
    <SettingsPageContainer>
      <SettingsSection title="Tastenkürzel">
        <div className="divide-y divide-border/60" data-workjet-settings-keybindings="">
          {rows.map((row) => (
            <Row
              key={row.id}
              name={commandLabel(row.command)}
              chips={
                <span className="flex flex-wrap items-center gap-1">
                  {keybindingPillParts(row.key).map((part) => (
                    <Kbd key={part.key} className="h-5 min-w-0 px-1.5 text-[11px]">
                      {part.value}
                    </Kbd>
                  ))}
                </span>
              }
            />
          ))}
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
