import { ProviderInteractionMode } from "@t3tools/contracts";
import { memo, type ReactNode } from "react";
import { EllipsisIcon } from "lucide-react";
import { Button } from "../ui/button";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  interactionMode: ProviderInteractionMode;
  showInteractionModeToggle: boolean;
  /** Worker + Computer groups, so both choices exist below the breakpoint. */
  workerMenuContent?: ReactNode;
  traitsMenuContent?: ReactNode;
  /** Workjet role radio group plus the settings item; omitted on a draft thread. */
  workjetRoleMenuContent?: ReactNode;
  workjetMenuContent?: ReactNode;
  onToggleInteractionMode: () => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 px-2 text-muted-foreground/70 hover:text-foreground/80"
            aria-label="More composer controls"
          />
        }
      >
        <EllipsisIcon aria-hidden="true" className="size-4" />
      </MenuTrigger>
      <MenuPopup align="start">
        {props.workerMenuContent ? (
          <>
            {props.workerMenuContent}
            <MenuDivider />
          </>
        ) : null}
        {props.traitsMenuContent ? (
          <>
            {props.traitsMenuContent}
            <MenuDivider />
          </>
        ) : null}
        {props.workjetRoleMenuContent ? (
          <>
            {props.workjetRoleMenuContent}
            <MenuDivider />
          </>
        ) : null}
        {props.workjetMenuContent ? (
          <>
            {props.workjetMenuContent}
            <MenuDivider />
          </>
        ) : null}
        {props.showInteractionModeToggle ? (
          <>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Mode</div>
            <MenuRadioGroup
              value={props.interactionMode}
              onValueChange={(value) => {
                if (!value || value === props.interactionMode) return;
                props.onToggleInteractionMode();
              }}
            >
              <MenuRadioItem value="default">Chat</MenuRadioItem>
              <MenuRadioItem value="plan">Plan</MenuRadioItem>
            </MenuRadioGroup>
            <MenuDivider />
          </>
        ) : null}
        {/* No Access group: permission is ALWAYS full by the operator's
            rule, and DEFAULT_RUNTIME_MODE is "full-access" already. */}
      </MenuPopup>
    </Menu>
  );
});
