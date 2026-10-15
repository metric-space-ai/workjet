import { PlusIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkjetCredentialRecord } from "@workjet/contracts";
import { useUiText } from "../../hooks/useUiText";
import { useProjectOverviewLanguage } from "../../hooks/useProjectOverviewLanguage";
import { scheduleUndoableDelete } from "../../lib/undoableDelete";
import { Button } from "../ui/button";
import { InlineExpand } from "../ui/inline-expand";
import { Row } from "../ui/row";
import { SecretInput } from "../ui/secret-input";
import { toastManager } from "../ui/toast";
import { deleteCredential, listCredentials, putCredential } from "../../workjetSecretRequests";
import { SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const RETRY_MS = 10_000;
const NO_HIDDEN: ReadonlySet<string> = new Set();

/**
 * One write-only editor. It owns the typed value, so the value never sits in
 * the parent, in props of a kept element, or in a shared field. The value is
 * cleared before the request is awaited and dies with the editor.
 */
function CredentialEditor(props: {
  readonly fixedName?: string;
  readonly language: "de" | "en";
  readonly onStore: (name: string, value: string) => Promise<boolean>;
}) {
  const t = useUiText();
  const [name, setName] = useState(props.fixedName ?? "");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const target = props.fixedName ?? name;
  const ready = NAME_PATTERN.test(target) && value.length > 0 && !busy;
  return (
    <form
      className="flex flex-col gap-2 px-3 pb-2 sm:flex-row sm:items-center"
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        const submitted = value;
        setValue("");
        setBusy(true);
        void props.onStore(target, submitted).finally(() => setBusy(false));
      }}
    >
      {props.fixedName === undefined ? (
        <input
          aria-label={t("Schlüssel", "Key")}
          className="min-w-0 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs sm:w-56"
          value={name}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="characters"
          placeholder="API_KEY"
          maxLength={64}
          onChange={(event) => setName(event.target.value.toUpperCase())}
        />
      ) : null}
      <span className="min-w-0 flex-1">
        <SecretInput
          label={t(`Wert für ${target || "Schlüssel"}`, `Value for ${target || "key"}`)}
          value={value}
          onChange={setValue}
          disabled={busy}
          placeholder={t("Wert", "Value")}
          maxLength={8192}
          language={props.language}
        />
      </span>
      <Button type="submit" size="sm" disabled={!ready} className="self-start sm:self-auto">
        {t("Speichern", "Save")}
      </Button>
    </form>
  );
}

/**
 * Write-only credentials of the selected CTOX instance: names and whether a
 * value is set, never a value. Saving is instant; removing uses the shared
 * undo window.
 */
export function SecretsSettingsSection(props: { readonly instanceId: string | null }) {
  const t = useUiText();
  const language = useProjectOverviewLanguage();
  const [rows, setRows] = useState<readonly WorkjetCredentialRecord[] | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [hidden, setHidden] = useState(NO_HIDDEN);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const refresh = useCallback(async () => {
    if (!props.instanceId) return;
    const list = await listCredentials(props.instanceId).catch(() => null);
    if (!alive.current) return;
    setReadFailed(list === null);
    if (list !== null) setRows(list);
  }, [props.instanceId]);
  useEffect(() => {
    setRows(null);
    void refresh();
  }, [refresh]);
  // Ein Lesefehler wird still wiederholt; bis dahin steht „—“.
  useEffect(() => {
    if (!readFailed) return;
    const timer = window.setTimeout(() => void refresh(), RETRY_MS);
    return () => window.clearTimeout(timer);
  }, [readFailed, refresh]);

  if (!props.instanceId) return null;
  const instanceId = props.instanceId;

  const store = async (name: string, value: string): Promise<boolean> => {
    const ok = await putCredential(instanceId, name, value).catch(() => false);
    if (!alive.current) return ok;
    if (!ok) {
      toastManager.add({
        type: "error",
        title: t(`${name} nicht gespeichert`, `${name} not saved`),
      });
      return false;
    }
    setEditing(null);
    setAdding(false);
    void refresh();
    return true;
  };
  const unhide = (name: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      next.delete(name);
      return next;
    });
  const remove = (name: string) => {
    setEditing(null);
    setHidden((prev) => new Set(prev).add(name));
    scheduleUndoableDelete({
      title: t(`${name} entfernt`, `${name} removed`),
      undoLabel: t("Rückgängig", "Undo"),
      run: async () => {
        const ok = await deleteCredential(instanceId, name).catch(() => false);
        if (!alive.current) return;
        if (!ok) {
          toastManager.add({
            type: "error",
            title: t(`${name} nicht entfernt`, `${name} not removed`),
          });
        }
        unhide(name);
        void refresh();
      },
      onUndo: () => unhide(name),
    });
  };
  const visible = (rows ?? []).filter((row) => {
    return !hidden.has(row.name);
  });
  const section = searchableSetting("instance-secrets");
  return (
    <SettingsSection {...section} data-workjet-secrets-settings="">
      {rows === null ? (
        <p className="px-3 py-2 text-[13.5px] text-muted-foreground sm:px-4">—</p>
      ) : visible.length === 0 ? null : (
        <ul aria-label={section.title} className="divide-y divide-border/60">
          {visible.map((row) => (
            <li key={row.name} data-workjet-secret-row={row.name}>
              <Row
                name={<span className="font-mono text-xs">{row.name}</span>}
                {...(row.description ? { meta: row.description } : {})}
                status={row.isSet ? "ok" : "off"}
                statusLabel={row.isSet ? t("Gesetzt", "Set") : t("Nicht gesetzt", "Not set")}
                expanded={editing === row.name}
                onToggleExpanded={() => {
                  setAdding(false);
                  setEditing(editing === row.name ? null : row.name);
                }}
                {...(row.isSet ? { onDelete: () => remove(row.name), undoableDelete: true } : {})}
                deleteLabel={t("Entfernen", "Remove")}
              />
              <InlineExpand
                label={row.name}
                open={editing === row.name}
                onOpenChange={(open) => setEditing(open ? row.name : null)}
                // The row's own chevron and Esc collapse it.
                hideCollapseControl
              >
                <CredentialEditor
                  key={row.name}
                  fixedName={row.name}
                  language={language}
                  onStore={store}
                />
              </InlineExpand>
            </li>
          ))}
        </ul>
      )}
      <div className="px-3 pt-1 pb-1 sm:px-4">
        <InlineExpand
          label={t("Zugangsdaten hinzufügen", "Add credential")}
          open={adding}
          onOpenChange={setAdding}
          className="pt-8"
        >
          <CredentialEditor language={language} onStore={store} />
        </InlineExpand>
        {adding ? null : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setEditing(null);
              setAdding(true);
            }}
          >
            <PlusIcon aria-hidden />
            {t("Hinzufügen", "Add")}
          </Button>
        )}
      </div>
    </SettingsSection>
  );
}
