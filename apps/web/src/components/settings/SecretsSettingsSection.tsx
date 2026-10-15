import { KeyRoundIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkjetCredentialRecord } from "@workjet/contracts";
import { useUiText } from "../../hooks/useUiText";
import { useProjectOverviewLanguage } from "../../hooks/useProjectOverviewLanguage";
import { scheduleUndoableDelete } from "../../lib/undoableDelete";
import { Button } from "../ui/button";
import { SecretInput } from "../ui/secret-input";
import { deleteCredential, listCredentials, putCredential } from "../../workjetSecretRequests";
import { SettingsSection } from "./settingsLayout";

const NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Write-only secrets of the selected CTOX instance. Values go straight into
 * the encrypted CTOX secret store and are never read back. Every change is
 * instant; removing runs after the shared undo window (no confirmation).
 */
export function SecretsSettingsSection(props: { readonly instanceId: string | null }) {
  const t = useUiText();
  const language = useProjectOverviewLanguage();
  const [rows, setRows] = useState<readonly WorkjetCredentialRecord[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
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
    setFailed(list === null);
    if (list !== null) setRows(list);
  }, [props.instanceId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!props.instanceId) return null;
  const instanceId = props.instanceId;

  const store = async (name: string) => {
    if (!value || busy) return;
    const submitted = value;
    setValue("");
    setBusy(true);
    const ok = await putCredential(instanceId, name, submitted).catch(() => false);
    if (!alive.current) return;
    setBusy(false);
    setStatus(
      ok
        ? t(`${name} gespeichert`, `${name} saved`)
        : t("Nicht gespeichert. Erneut versuchen", "Not saved. Try again"),
    );
    if (ok) {
      setEditing(null);
      setAdding(false);
      setNewName("");
      void refresh();
    }
  };
  const remove = (name: string) => {
    setHidden((prev) => new Set(prev).add(name));
    scheduleUndoableDelete({
      title: t(`${name} entfernt`, `${name} removed`),
      undoLabel: t("Rückgängig", "Undo"),
      run: async () => {
        const ok = await deleteCredential(instanceId, name).catch(() => false);
        if (!alive.current) return;
        if (!ok)
          setStatus(
            t(`${name} nicht entfernt. Erneut versuchen`, `${name} not removed. Try again`),
          );
        setHidden((prev) => {
          const next = new Set(prev);
          next.delete(name);
          return next;
        });
        void refresh();
      },
      onUndo: () =>
        setHidden((prev) => {
          const next = new Set(prev);
          next.delete(name);
          return next;
        }),
    });
  };
  const editor = (name: string) => (
    <form
      className="flex flex-col gap-2 pt-2"
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        void store(name);
      }}
    >
      <SecretInput
        label={t(`Wert für ${name}`, `Value for ${name}`)}
        value={value}
        onChange={setValue}
        disabled={busy}
        placeholder={t("Wert eingeben", "Enter value")}
        maxLength={8192}
        language={language}
      />
      <div>
        <Button type="submit" size="sm" disabled={busy || value.length === 0}>
          {t("Sicher speichern", "Store securely")}
        </Button>
      </div>
    </form>
  );
  const visible = (rows ?? []).filter((row) => !hidden.has(row.name));
  return (
    <SettingsSection title={t("Zugangsdaten", "Secrets")}>
      <div
        className="flex flex-col gap-3 px-3 py-3 text-sm sm:px-4"
        data-workjet-secrets-settings=""
      >
        <p className="text-xs text-muted-foreground">
          {t(
            "Werte liegen verschlüsselt im CTOX-Speicher dieser Instanz. Workjet und Agents lesen sie nie zurück, Agents nutzen sie nur über den Verweis.",
            "Values are stored encrypted in this instance's CTOX store. Workjet and agents never read them back; agents use them only by reference.",
          )}
        </p>
        {failed && rows === null ? (
          <p role="alert" className="text-xs text-destructive">
            {t("Zugangsdaten nicht erreichbar. ", "Secrets unavailable. ")}
            <button type="button" className="underline" onClick={() => void refresh()}>
              {t("Erneut versuchen", "Try again")}
            </button>
          </p>
        ) : null}
        <ul className="flex flex-col divide-y rounded-lg border">
          {visible.map((row) => (
            <li
              key={row.name}
              className="flex flex-col px-3 py-2"
              data-workjet-secret-row={row.name}
            >
              <div className="flex flex-wrap items-center gap-2">
                <KeyRoundIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="font-mono text-xs">{row.name}</span>
                <span className="text-xs text-muted-foreground">
                  {row.isSet ? t("Gesetzt", "Set") : t("Nicht gesetzt", "Not set")}
                </span>
                <span className="ms-auto flex gap-1.5">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    aria-expanded={editing === row.name}
                    onClick={() => {
                      setValue("");
                      setEditing(editing === row.name ? null : row.name);
                    }}
                  >
                    {row.isSet ? t("Ersetzen", "Replace") : t("Setzen", "Set")}
                  </Button>
                  {row.isSet ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => remove(row.name)}
                    >
                      <Trash2Icon aria-hidden />
                      {t("Entfernen", "Remove")}
                    </Button>
                  ) : null}
                </span>
              </div>
              {row.description ? (
                <p className="text-xs text-muted-foreground">{row.description}</p>
              ) : null}
              {editing === row.name ? editor(row.name) : null}
            </li>
          ))}
        </ul>
        {adding ? (
          <div className="flex flex-col gap-2 rounded-lg border p-3">
            <label className="flex flex-col gap-1 text-xs">
              <span>{t("Schlüssel", "Key")}</span>
              <input
                className="rounded-md border border-border bg-background px-2 py-1 font-mono text-xs"
                value={newName}
                spellCheck={false}
                autoComplete="off"
                placeholder="CUSTOM_KEY"
                onChange={(event) => setNewName(event.target.value.toUpperCase())}
              />
            </label>
            {NAME_PATTERN.test(newName) ? editor(newName) : null}
          </div>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="self-start"
            onClick={() => setAdding(true)}
          >
            <PlusIcon aria-hidden />
            {t("Zugangsdaten hinzufügen", "Add secret")}
          </Button>
        )}
        {status ? (
          <p role="status" className="text-xs text-muted-foreground">
            {status}
          </p>
        ) : null}
      </div>
    </SettingsSection>
  );
}
