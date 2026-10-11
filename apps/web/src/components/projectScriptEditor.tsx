import type {
  ProjectScript,
  ProjectScriptIcon,
  ResolvedKeybindingsConfig,
} from "@workjet/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@workjet/client-runtime/state/runtime";
import {
  BugIcon,
  FlaskConicalIcon,
  HammerIcon,
  ListChecksIcon,
  PlayIcon,
  WrenchIcon,
} from "lucide-react";
import { type FormEvent, type KeyboardEvent, useEffect, useId, useState } from "react";

import {
  keybindingValueForCommand,
  decodeProjectScriptKeybindingRule,
} from "~/lib/projectScriptKeybindings";
import { keybindingFromKeyboardEvent } from "~/components/settings/KeybindingsSettings.logic";
import { commandForProjectScript, nextProjectScriptId } from "~/projectScripts";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Switch } from "./ui/switch";
import { Textarea } from "./ui/textarea";
import { cn } from "~/lib/utils";

export const SCRIPT_ICONS: Array<{ id: ProjectScriptIcon; label: string }> = [
  { id: "play", label: "Start" },
  { id: "test", label: "Test" },
  { id: "lint", label: "Lint" },
  { id: "configure", label: "Konfigurieren" },
  { id: "build", label: "Bauen" },
  { id: "debug", label: "Debuggen" },
];

export function ScriptIcon({
  icon,
  className = "size-3.5",
}: {
  icon: ProjectScriptIcon;
  className?: string;
}) {
  if (icon === "test") return <FlaskConicalIcon className={className} />;
  if (icon === "lint") return <ListChecksIcon className={className} />;
  if (icon === "configure") return <WrenchIcon className={className} />;
  if (icon === "build") return <HammerIcon className={className} />;
  if (icon === "debug") return <BugIcon className={className} />;
  return <PlayIcon className={className} />;
}

export interface NewProjectScriptInput {
  name: string;
  command: string;
  icon: ProjectScriptIcon;
  runOnWorktreeCreate: boolean;
  keybinding: string | null;
  /** Optional URL to open in the in-app preview when this script runs. */
  previewUrl: string | null;
  /** When true, automatically open the preview panel pointed at `previewUrl`. */
  autoOpenPreview: boolean;
}

export type ProjectScriptActionResult = AtomCommandResult<void, unknown>;

export const EMPTY_PROJECT_SCRIPT_INPUT: NewProjectScriptInput = {
  name: "",
  command: "",
  icon: "play",
  runOnWorktreeCreate: false,
  keybinding: null,
  previewUrl: null,
  autoOpenPreview: false,
};

/** What the inline editor opens with. `scriptId: null` means "add". */
export interface ProjectScriptEditorRequest {
  scriptId: string | null;
  initial: NewProjectScriptInput;
  /** Validation error to show immediately (e.g. a failed workjet.json import). */
  error?: string;
}

export function editorRequestForScript(
  script: ProjectScript,
  keybindings: ResolvedKeybindingsConfig,
): ProjectScriptEditorRequest {
  return {
    scriptId: script.id,
    initial: {
      name: script.name,
      command: script.command,
      icon: script.icon,
      runOnWorktreeCreate: script.runOnWorktreeCreate,
      keybinding: keybindingValueForCommand(keybindings, commandForProjectScript(script.id)),
      previewUrl: script.previewUrl ?? null,
      autoOpenPreview: script.autoOpenPreview ?? false,
    },
  };
}

/**
 * Inline add/edit form for a project script (drei Orte, keine Popups): it
 * renders in place under the script list of Einstellungen › Projekte ›
 * <Projekt> or under the scripts control. The parent owns which script (if
 * any) is being edited via `request`; the form owns its state and validation.
 * Delete asks inline, never in a dialog.
 */
export function ProjectScriptEditor({
  request,
  scripts,
  onSubmit,
  onDelete,
  onClose,
  className,
}: {
  request: ProjectScriptEditorRequest | null;
  /** Existing scripts, used to derive a unique id for new scripts. */
  scripts: ReadonlyArray<ProjectScript>;
  onSubmit: (
    scriptId: string | null,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDelete: (scriptId: string) => void;
  onClose: () => void;
  className?: string;
}) {
  const formId = useId();
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [icon, setIcon] = useState<ProjectScriptIcon>("play");
  const [runOnWorktreeCreate, setRunOnWorktreeCreate] = useState(false);
  const [keybinding, setKeybinding] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [autoOpenPreview, setAutoOpenPreview] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [saving, setSaving] = useState(false);

  const isEditing = request?.scriptId != null;

  // Hydrate the form whenever a new request opens the editor.
  useEffect(() => {
    if (!request) return;
    setName(request.initial.name);
    setCommand(request.initial.command);
    setIcon(request.initial.icon);
    setRunOnWorktreeCreate(request.initial.runOnWorktreeCreate);
    setKeybinding(request.initial.keybinding ?? "");
    setPreviewUrl(request.initial.previewUrl ?? "");
    setAutoOpenPreview(request.initial.autoOpenPreview);
    setValidationError(request.error ?? null);
    setConfirmingDelete(false);
  }, [request]);

  if (request === null) return null;

  const captureKeybinding = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Tab") return;
    event.preventDefault();
    if (event.key === "Backspace" || event.key === "Delete") {
      setKeybinding("");
      return;
    }
    const next = keybindingFromKeyboardEvent(event, navigator.platform);
    if (!next) return;
    setKeybinding(next);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const trimmedName = name.trim();
    const trimmedCommand = command.trim();
    if (trimmedName.length === 0) {
      setValidationError("Name fehlt.");
      return;
    }
    if (trimmedCommand.length === 0) {
      setValidationError("Befehl fehlt.");
      return;
    }

    setValidationError(null);
    let payload: NewProjectScriptInput;
    try {
      const scriptIdForValidation =
        request.scriptId ??
        nextProjectScriptId(
          trimmedName,
          scripts.map((script) => script.id),
        );
      const keybindingRule = decodeProjectScriptKeybindingRule({
        keybinding,
        command: commandForProjectScript(scriptIdForValidation),
      });
      const trimmedPreviewUrl = previewUrl.trim();
      payload = {
        name: trimmedName,
        command: trimmedCommand,
        icon,
        runOnWorktreeCreate,
        keybinding: keybindingRule?.key ?? null,
        previewUrl: trimmedPreviewUrl.length > 0 ? trimmedPreviewUrl : null,
        autoOpenPreview: trimmedPreviewUrl.length > 0 ? autoOpenPreview : false,
      } satisfies NewProjectScriptInput;
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : "Skript nicht gespeichert.");
      return;
    }

    setSaving(true);
    try {
      const result = await onSubmit(request.scriptId, payload);
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          setValidationError(error instanceof Error ? error.message : "Skript nicht gespeichert.");
        }
        return;
      }
    } finally {
      setSaving(false);
    }
    onClose();
  };

  return (
    <form
      id={formId}
      aria-label={isEditing ? "Skript bearbeiten" : "Skript hinzufügen"}
      className={cn("flex flex-col gap-3 rounded-lg border bg-card/40 p-3", className)}
      data-slot="inline-panel"
      data-settings-inline-editor=""
      onSubmit={submit}
    >
      <div className="font-medium text-[13.5px]">
        {isEditing ? "Skript bearbeiten" : "Skript hinzufügen"}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${formId}-name`}>Name</Label>
        <Input
          id={`${formId}-name`}
          autoFocus
          placeholder="Test"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="grid gap-1.5">
        <span className="text-[13.5px] font-medium">Symbol</span>
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Symbol">
          {SCRIPT_ICONS.map((entry) => {
            const isSelected = entry.id === icon;
            return (
              <button
                key={entry.id}
                type="button"
                role="radio"
                aria-checked={isSelected}
                className={cn(
                  "flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs",
                  isSelected
                    ? "border-primary/70 bg-primary/10"
                    : "border-border/70 hover:bg-accent/60",
                )}
                onClick={() => setIcon(entry.id)}
              >
                <ScriptIcon icon={entry.id} className="size-3.5" />
                <span>{entry.label}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${formId}-command`}>Befehl</Label>
        <Textarea
          id={`${formId}-command`}
          placeholder="bun test"
          value={command}
          onChange={(event) => setCommand(event.target.value)}
        />
      </div>
      <div className="grid gap-1.5 sm:grid-cols-2 sm:gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor={`${formId}-keybinding`}>Tastenkürzel</Label>
          <Input
            id={`${formId}-keybinding`}
            placeholder="Kürzel drücken"
            value={keybinding}
            readOnly
            onKeyDown={captureKeybinding}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${formId}-preview-url`}>Vorschau-URL</Label>
          <Input
            id={`${formId}-preview-url`}
            placeholder="http://localhost:5173"
            value={previewUrl}
            onChange={(event) => setPreviewUrl(event.target.value)}
          />
        </div>
      </div>
      <label className="flex items-center justify-between gap-3 text-[13.5px]">
        <span>Beim Anlegen ausführen</span>
        <Switch
          checked={runOnWorktreeCreate}
          onCheckedChange={(checked) => setRunOnWorktreeCreate(Boolean(checked))}
        />
      </label>
      <label
        className={cn(
          "flex items-center justify-between gap-3 text-[13.5px]",
          previewUrl.trim().length === 0 && "opacity-60",
        )}
      >
        <span>Vorschau automatisch öffnen</span>
        <Switch
          checked={autoOpenPreview}
          disabled={previewUrl.trim().length === 0}
          onCheckedChange={(checked) => setAutoOpenPreview(Boolean(checked))}
        />
      </label>
      {validationError ? (
        <div className="text-xs text-destructive" role="alert" data-slot="inline-panel-status">
          {validationError}
        </div>
      ) : null}
      <div className="flex items-center justify-end gap-2" data-slot="inline-panel-footer">
        {isEditing && !confirmingDelete ? (
          <Button
            type="button"
            size="sm"
            variant="destructive-outline"
            className="mr-auto"
            onClick={() => setConfirmingDelete(true)}
          >
            Löschen
          </Button>
        ) : null}
        {isEditing && confirmingDelete ? (
          <div className="mr-auto flex items-center gap-1.5" role="group" data-slot="row-confirm">
            <span className="text-xs text-muted-foreground">„{name}“ löschen?</span>
            <Button
              type="button"
              size="xs"
              variant="destructive"
              onClick={() => {
                if (!request.scriptId) return;
                setConfirmingDelete(false);
                onClose();
                onDelete(request.scriptId);
              }}
            >
              Löschen
            </Button>
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => setConfirmingDelete(false)}
            >
              Abbrechen
            </Button>
          </div>
        ) : null}
        <Button type="button" size="sm" variant="outline" onClick={onClose}>
          Abbrechen
        </Button>
        <Button type="submit" size="sm" disabled={saving}>
          Speichern
        </Button>
      </div>
    </form>
  );
}
