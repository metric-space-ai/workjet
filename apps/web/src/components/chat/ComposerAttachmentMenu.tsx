import { memo, useRef } from "react";
import { FileSearchIcon, ImagePlusIcon, PlusIcon } from "lucide-react";

import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

export interface ComposerAttachmentMenuProps {
  readonly disabled?: boolean;
  readonly onAttachImages: (files: File[]) => void;
  readonly onAddProjectFile: () => void;
}

/**
 * The composer's single, visible attachment entry point.
 *
 * Provider transports currently accept image bytes. Project files use the
 * existing path picker and are attached as workspace references, which keeps
 * large or sensitive files out of renderer memory and preserves the same
 * semantics as typing `@` in the prompt.
 */
export const ComposerAttachmentMenu = memo(function ComposerAttachmentMenu(
  props: ComposerAttachmentMenuProps,
) {
  const imageInputRef = useRef<HTMLInputElement>(null);

  return (
    <span className="inline-flex shrink-0 items-center" data-composer-attachment-menu="true">
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (files.length > 0) props.onAttachImages(files);
        }}
      />
      <Menu>
        <MenuTrigger
          disabled={props.disabled}
          render={
            <ComposerControl
              type="button"
              className="size-7 shrink-0 justify-center px-0"
              aria-label="Add images or project files"
            />
          }
        >
          <ComposerControlIcon icon={PlusIcon} />
        </MenuTrigger>
        <MenuPopup align="start" side="top" className="w-52">
          <MenuItem onClick={() => imageInputRef.current?.click()}>
            <ImagePlusIcon />
            Upload images
          </MenuItem>
          <MenuItem onClick={props.onAddProjectFile}>
            <FileSearchIcon />
            Add project file
          </MenuItem>
        </MenuPopup>
      </Menu>
    </span>
  );
});
