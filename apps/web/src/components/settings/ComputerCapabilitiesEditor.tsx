import type {
  CtoxComputerOperationalCapability,
  CtoxWorkjetComputerProjection,
  WorkjetComputer,
} from "@workjet/contracts";
import { useState } from "react";
import type { OperationalComputerEnrollment } from "../../computerCapabilityEnrollment";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

const SSH_HOST_KEY_TYPES = [
  { value: "ssh-ed25519", label: "Ed25519" },
  { value: "ecdsa-sha2-nistp256", label: "ECDSA P-256" },
  { value: "ecdsa-sha2-nistp384", label: "ECDSA P-384" },
  { value: "ecdsa-sha2-nistp521", label: "ECDSA P-521" },
  { value: "rsa-sha2-256", label: "RSA SHA-256" },
  { value: "rsa-sha2-512", label: "RSA SHA-512" },
] as const;

export function ComputerCapabilitiesEditor({
  computer,
  nativeComputer,
  preserveExistingCapabilities = false,
  onSave,
  onCancel,
}: {
  readonly computer?: WorkjetComputer;
  readonly nativeComputer?: CtoxWorkjetComputerProjection;
  readonly preserveExistingCapabilities?: boolean;
  readonly onSave: (enrollment: OperationalComputerEnrollment) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const savedBuild = nativeComputer?.capabilityConfig?.find((entry) => entry.kind === "build");
  const savedStorage = nativeComputer?.capabilityConfig?.find((entry) => entry.kind === "storage");
  const savedGpu = nativeComputer?.capabilityConfig?.find((entry) => entry.kind === "gpu");
  const [computerId] = useState(
    () => nativeComputer?.id ?? computer?.id ?? `computer-${randomUUID()}`,
  );
  const [endpointRef] = useState(() => `endpoint-${randomUUID()}`);
  const [name, setName] = useState(nativeComputer?.displayName ?? computer?.label ?? "");
  const [storageOnly, setStorageOnly] = useState(
    nativeComputer?.agentless ?? computer === undefined,
  );
  const [preserve, setPreserve] = useState(preserveExistingCapabilities);
  const [build, setBuild] = useState(false);
  const [storage, setStorage] = useState(
    nativeComputer ? nativeComputer.agentless === true : computer === undefined,
  );
  const [gpu, setGpu] = useState(false);
  const [purposes, setPurposes] = useState<readonly ("artifacts" | "backups" | "exchange")[]>(
    savedStorage?.purposes ?? ["artifacts"],
  );
  const [protocol, setProtocol] = useState<"ssh" | "smb">(
    savedStorage?.protocol === "smb" ? "smb" : "ssh",
  );
  const [hostKeyType, setHostKeyType] = useState<(typeof SSH_HOST_KEY_TYPES)[number]["value"] | "">(
    "",
  );
  const [usePassphrase, setUsePassphrase] = useState(false);
  const [fields, setFields] = useState({
    host: "",
    port: "22",
    username: "",
    root: savedBuild?.lane_root ?? savedStorage?.root ?? "",
    keyPin: "",
    credentialScope: "computer-access",
    credentialName: "",
    passphraseScope: "computer-access",
    passphraseName: "",
    share: "",
    slots: String(savedBuild?.slots ?? 1),
    jobs: String(savedBuild?.jobs ?? 2),
    diskFloor: String(savedBuild?.disk_floor_gib ?? 20),
    toolchains: savedBuild?.toolchains.join(", ") ?? "rust-stable",
    gpuModel: savedGpu?.model ?? "",
    vram: savedGpu ? String(savedGpu.vram_gib) : "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = (key: keyof typeof fields, label: string, number = false) => (
    <label className="grid gap-1 text-sm">
      <span>{label}</span>
      <Input
        type={number ? "number" : "text"}
        min={number ? 1 : undefined}
        step={number ? 1 : undefined}
        value={fields[key]}
        required
        disabled={busy}
        onChange={(event) => setFields((current) => ({ ...current, [key]: event.target.value }))}
      />
    </label>
  );
  const hasEndpoint = build || storage;
  if (savedStorage?.protocol === "nfs")
    return (
      <div className="space-y-3">
        <p role="alert">NFS storage is not supported by this editor.</p>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    );

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        const capabilities: CtoxComputerOperationalCapability[] = [];
        if (build)
          capabilities.push({
            kind: "build",
            ssh_endpoint_ref: endpointRef,
            slots: Number(fields.slots),
            jobs: Number(fields.jobs),
            lane_root: fields.root.trim(),
            disk_floor_gib: Number(fields.diskFloor),
            toolchains: fields.toolchains
              .split(",")
              .map((entry) => entry.trim())
              .filter(Boolean),
          });
        if (storage)
          capabilities.push({
            kind: "storage",
            endpoint_ref: endpointRef,
            protocol,
            root: fields.root.trim(),
            quota_gib: savedStorage?.quota_gib ?? null,
            purposes,
          });
        if (gpu)
          capabilities.push({
            kind: "gpu",
            model: fields.gpuModel.trim(),
            vram_gib: Number(fields.vram),
          });
        const credential = {
          scope: fields.credentialScope.trim(),
          name: fields.credentialName.trim(),
        };
        const connection = hasEndpoint
          ? {
              host: fields.host.trim(),
              port: Number(fields.port),
              username: fields.username.trim(),
              root: fields.root.trim(),
            }
          : null;
        const enrollment: OperationalComputerEnrollment = {
          computerId,
          displayName: name.trim(),
          hostingMode: storageOnly ? "self_hosted" : "workstation",
          agentless: storageOnly,
          agentCapabilities: storageOnly
            ? []
            : (computer?.harnesses
                .filter((harness) => harness.available)
                .map((harness) => harness.harness) ??
              nativeComputer?.capabilities.filter(
                (kind) => !["build", "storage", "gpu"].includes(kind),
              ) ??
              []),
          capabilityConfig: capabilities,
          preserveOperationalCapabilities: preserve,
          endpoint:
            connection === null
              ? null
              : {
                  ref: endpointRef,
                  connection:
                    protocol === "ssh"
                      ? {
                          ...connection,
                          protocol: "ssh",
                          host_key_sha256: fields.keyPin.trim(),
                          ...(hostKeyType ? { host_key_algorithm: hostKeyType } : {}),
                          private_key: credential,
                          passphrase: usePassphrase
                            ? {
                                scope: fields.passphraseScope.trim(),
                                name: fields.passphraseName.trim(),
                              }
                            : null,
                        }
                      : {
                          ...connection,
                          protocol: "smb",
                          share: fields.share.trim(),
                          password: credential,
                        },
                },
        };
        setBusy(true);
        setError(null);
        void onSave(enrollment)
          .catch((failure: unknown) => {
            setError(failure instanceof Error ? failure.message : "Could not save this computer.");
          })
          .finally(() => setBusy(false));
      }}
    >
      <label className="grid gap-1 text-sm">
        <span>Computer name</span>
        <Input
          value={name}
          required
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      {computer === undefined ? (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={storageOnly}
            disabled={busy}
            onChange={(event) => {
              setStorageOnly(event.target.checked);
              if (event.target.checked) {
                setStorage(true);
                setBuild(false);
                setGpu(false);
              }
            }}
          />
          Storage-only computer (NAS)
        </label>
      ) : null}
      {preserveExistingCapabilities ? (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={preserve}
            disabled={busy}
            onChange={(event) => {
              setPreserve(event.target.checked);
              if (event.target.checked) {
                setBuild(false);
                setStorage(false);
                setGpu(false);
              }
            }}
          />
          Keep saved build, storage, and GPU settings
        </label>
      ) : null}
      <fieldset className="flex flex-wrap gap-4" disabled={busy || preserve}>
        <legend className="mb-2 text-sm font-medium">Capabilities</legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={build}
            disabled={storageOnly}
            onChange={(event) => {
              setBuild(event.target.checked);
              if (event.target.checked) {
                setProtocol("ssh");
                setFields((current) => ({ ...current, port: "22" }));
              }
            }}
          />{" "}
          Build
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={storage}
            disabled={storageOnly}
            onChange={(event) => setStorage(event.target.checked)}
          />{" "}
          Storage
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={gpu}
            disabled={storageOnly}
            onChange={(event) => setGpu(event.target.checked)}
          />{" "}
          GPU
        </label>
      </fieldset>
      {hasEndpoint ? (
        <fieldset className="grid gap-3 sm:grid-cols-2" disabled={busy}>
          <legend className="mb-2 text-sm font-medium">Access</legend>
          <label className="grid gap-1 text-sm">
            <span>Protocol</span>
            <select
              className="h-9 rounded-md border bg-background px-3"
              value={protocol}
              disabled={build}
              onChange={(event) => {
                const next = event.target.value === "smb" ? "smb" : "ssh";
                setProtocol(next);
                setFields((current) => ({ ...current, port: next === "ssh" ? "22" : "445" }));
              }}
            >
              <option value="ssh">SSH</option>
              <option value="smb">SMB</option>
            </select>
          </label>
          {field("host", "Host")}
          {field("port", "Port", true)}
          {field("username", "Username")}
          {field("root", build ? "Build and storage directory" : "Storage directory")}
          {protocol === "ssh"
            ? field("keyPin", "SSH host-key SHA256 fingerprint")
            : field("share", "SMB share")}
          {protocol === "ssh" ? (
            <label className="grid gap-1 text-sm">
              <span>SSH host-key type</span>
              <select
                className="h-9 rounded-md border bg-background px-3"
                value={hostKeyType}
                onChange={(event) =>
                  setHostKeyType(
                    SSH_HOST_KEY_TYPES.find((entry) => entry.value === event.target.value)?.value ??
                      "",
                  )
                }
              >
                <option value="">Automatic negotiation</option>
                {SSH_HOST_KEY_TYPES.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {field("credentialScope", "Saved credential group")}
          {field(
            "credentialName",
            protocol === "ssh" ? "Saved SSH key name" : "Saved password name",
          )}
          {protocol === "ssh" ? (
            <>
              <label className="flex items-center gap-2 text-sm sm:col-span-2">
                <input
                  type="checkbox"
                  checked={usePassphrase}
                  onChange={(event) => setUsePassphrase(event.target.checked)}
                />
                SSH key uses a saved passphrase
              </label>
              {usePassphrase ? (
                <>
                  {field("passphraseScope", "Saved SSH passphrase group")}
                  {field("passphraseName", "Saved SSH passphrase name")}
                </>
              ) : null}
            </>
          ) : null}
          <p className="text-xs text-muted-foreground sm:col-span-2">
            Choose a credential already saved in the CTOX Secret Store.
          </p>
        </fieldset>
      ) : null}
      {storage ? (
        <fieldset className="flex flex-wrap gap-4" disabled={busy}>
          <legend className="mb-2 text-sm font-medium">Storage uses</legend>
          {(["artifacts", "backups", "exchange"] as const).map((purpose) => (
            <label key={purpose} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={purposes.includes(purpose)}
                onChange={(event) =>
                  setPurposes((current) =>
                    event.target.checked
                      ? [...current, purpose]
                      : current.filter((entry) => entry !== purpose),
                  )
                }
              />
              {purpose === "artifacts"
                ? "Build artifacts"
                : purpose === "backups"
                  ? "Backups"
                  : "File exchange"}
            </label>
          ))}
        </fieldset>
      ) : null}
      {build ? (
        <fieldset className="grid gap-3 sm:grid-cols-2" disabled={busy}>
          <legend className="mb-2 text-sm font-medium">Build capacity</legend>
          {field("slots", "Concurrent builds", true)}
          {field("jobs", "Workers per build", true)}
          {field("diskFloor", "Minimum free disk (GiB)", true)}
          {field("toolchains", "Toolchains (comma-separated)")}
        </fieldset>
      ) : null}
      {gpu ? (
        <fieldset className="grid gap-3 sm:grid-cols-2" disabled={busy}>
          <legend className="mb-2 text-sm font-medium">GPU</legend>
          {field("gpuModel", "GPU model")}
          {field("vram", "VRAM (GiB)", true)}
        </fieldset>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={busy || (storageOnly && !storage) || (storage && purposes.length === 0)}
        >
          {busy ? "Waiting for confirmation…" : "Save computer"}
        </Button>
      </div>
    </form>
  );
}
