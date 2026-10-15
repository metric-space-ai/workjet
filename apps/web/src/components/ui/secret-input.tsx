import { EyeIcon, EyeOffIcon } from "lucide-react";
import { useState } from "react";

/**
 * Masked, write-only secret field for the chat secret request card and the
 * Secrets settings tab (same input contract as the gateway API-key form). Never autofilled or
 * spell-checked, marked sensitive for privacy mode, and the show toggle is a
 * visible button with a word (no hover-only control).
 */
export function SecretInput(props: {
  readonly id?: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
  readonly placeholder?: string;
  readonly maxLength?: number;
  readonly language: "de" | "en";
}) {
  const [visible, setVisible] = useState(false);
  const de = props.language === "de";
  return (
    <span className="flex min-w-0 items-center gap-1.5" data-sensitive="">
      <input
        id={props.id}
        aria-label={props.label}
        type={visible ? "text" : "password"}
        autoComplete="new-password"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        data-1p-ignore=""
        data-lpignore="true"
        data-workjet-secret-input=""
        maxLength={props.maxLength}
        value={props.value}
        disabled={props.disabled}
        placeholder={props.placeholder}
        onChange={(event) => props.onChange(event.target.value)}
        className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs text-foreground"
      />
      <button
        type="button"
        aria-pressed={visible}
        disabled={props.disabled}
        onClick={() => setVisible((v) => !v)}
        className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        {visible ? (
          <EyeOffIcon className="size-3.5" aria-hidden />
        ) : (
          <EyeIcon className="size-3.5" aria-hidden />
        )}
        <span>{visible ? (de ? "Verbergen" : "Hide") : de ? "Anzeigen" : "Show"}</span>
      </button>
    </span>
  );
}
