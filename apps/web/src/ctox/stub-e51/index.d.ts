// CTOX App-API 4.0 – Typpaket (Quelle für ctox-app-api.d.ts, §16.10).
// Vertrag: ctox-sync-v4-architektur.md §10.2, §10.2a, §16.7, §16.10, §16.15, §16.19.
// Teil 1: normative App-API. Teil 2: Shell-Kernel-API (nur Shell). Teil 3: Stub-Kernel + Sim-Hooks (nur Stub).

// ============================================================================================================
// Teil 1 – App-API (an jede App übergeben, app_api_ver = 4.0)
// ============================================================================================================

/** E47: read-only local view metadata; confirmed opaque revision (same token as expected_revision), null for local-only rows. */
export type ReadDocument<T> = T & {readonly _rev: string | null; readonly _pending: boolean};

/** Live-Ergebnis einer Abfrage. Ergebnisse sortiert, Gleichstände nach `id`; ohne Zeilendeckel. */
export interface LiveQuery<T> {
  get(): T[];
  /** Ruft `cb` sofort mit dem aktuellen Stand und danach bei jeder Änderung; liefert die Abmeldung. */
  subscribe(cb: (rows: T[]) => void): () => void;
}

/** Live-Einzelwert. */
export interface LiveDoc<T> {
  get(): T;
  subscribe(cb: (value: T) => void): () => void;
}

/** Mango-Teilmenge (§10.2a Nr. 5). Fehlendes Feld ≠ null; `$exists:false` trifft fehlende Felder; `$eq:null` nur null. */
export type Query = {
  selector?: Selector;
  /** Mehrere Felder, z. B. `[{prio: 'desc'}, {title: 'asc'}]`. Gleichstand → `id` aufsteigend. */
  sort?: Array<Record<string, 'asc' | 'desc'>>;
  limit?: number;
  skip?: number;
};
export type Selector = {
  $and?: Selector[];
  $or?: Selector[];
  $not?: Selector;
  [field: string]: FieldCondition | Selector[] | Selector | undefined;
};
export type Scalar = string | number | boolean | null;
export type FieldCondition =
  | Scalar
  | RegExp
  | unknown[]
  | { [key: string]: unknown } // Gleichheit mit einem Objekt
  | FieldOperators;
export interface FieldOperators {
  $eq?: unknown;
  $ne?: unknown;
  $gt?: number | string;
  $gte?: number | string;
  $lt?: number | string;
  $lte?: number | string;
  $in?: unknown[];
  $nin?: unknown[];
  $exists?: boolean;
  /** JS-Regex; einziges erlaubtes Flag: `i` (über `$options: 'i'` oder `/x/i`). */
  $regex?: string | RegExp;
  $options?: 'i' | '';
  $not?: FieldOperators | RegExp;
  /** Eine Ebene: Selektor für Objekt-Elemente oder Operatoren für skalare Elemente. */
  $elemMatch?: Selector | FieldOperators;
}

export type WriteResult = {
  /** Full locally acknowledged version and canonical replacement retained atomically in archive_local. */
  local_archived_ref?: string;
  status: 'accepted' | 'rejected' | 'migrated';
  code?: CtoxErrorCode;
  rev?: string;
  reason?: string;
  archived_ref?: string;
  /** Stub/Draht: globale Folgenummer der bestätigten Änderung (§2.2). */
  seq?: number;
  /** Klartext zur Ablehnung (z. B. „Migration fehlt: items“, §16.22 A2). Nur für die Zustandszone. */
  detail?: string;
};

export interface WriteHandle<Extra = {}> {
  /** Stub: Vorgangs-ID (UUIDv7) des Outbox-Eintrags. */
  op_id?: string;
  /** Lokal in IDB committet. Lehnt mit `CtoxError{code:'invalid', path}` ab, wenn das Dokument ungültig ist – dann wird nichts geschrieben. */
  local: Promise<void>;
  /** Core-Ergebnis. Lehnt nie ab; bleibt offen, solange offline. */
  result: Promise<WriteResult & Extra>;
  /** Nur vor dem Senden möglich; `true` = zurückgenommen (result → rejected/cancelled). */
  cancel(): boolean;
}

export type CommandState = {
  status: 'queued' | 'accepted' | 'running' | 'done' | 'failed';
  progress?: number;
  result?: unknown;
  error?: string;
};
export interface CommandHandle {
  /** ID des Befehlsdokuments in `business_commands`. */
  id: string;
  /** Gepushter Status, kein Warten auf Annahme. */
  status: LiveDoc<CommandState>;
  local: Promise<void>;
  result: Promise<WriteResult>;
  cancel(): boolean;
}

export type CtoxErrorCode = 'revision_conflict' | 'invalid' | 'forbidden' | 'not_found' | 'conflict' | 'revoked' | 'expired' | 'quota' | 'unavailable';
export declare class CtoxError extends Error {
  readonly name: 'CtoxError';
  readonly code: CtoxErrorCode;
  readonly path?: string;
  readonly reason?: string;
  constructor(code: CtoxErrorCode, message?: string, extra?: { path?: string; reason?: string });
}

export type StatusItem = { level: 'info' | 'warn' | 'error'; code: string; text: string; ref?: string };

/** Unix epoch milliseconds, first observation of each stage; null = not observed.
 * queued = local durable queue, sent = first transport dispatch, acked = validated
 * Core receipt (including rejection), completed = canonical terminal state or rejection.
 * Observational per-tab ring, creation order, at most 500; not durable or a completion authority.
 */
export type CommandTiming = Readonly<{command_id:string; queued:number; sent:number|null; acked:number|null; completed:number|null}>;
/** Bridge adapter hook: forward timing snapshots here, never command payloads.
 * Exceptions are isolated from the data path. Cross-tab updates can repeat; key by command_id.
 */
export interface CommandDiagnostics { onCommandTiming?(timing:CommandTiming):void | Promise<void>; }
export interface CommandMetrics extends LiveDoc<Metrics> { readonly commands:ReadonlyArray<CommandTiming>; }
export type Metrics = {
  commands: ReadonlyArray<CommandTiming>;
  backlog: number;
  outbox: { count: number; oldest_ms: number };
  /** §16.19 Nr. 7: state ∈ online | offline. */
  link: { state: 'online' | 'offline'; rtt_ms: number; relay: boolean };  /** §16.45 Collection-Liveness: live = Verbindung oben und Backlog 0; catching_up; offline; error mit Code (§16.42). */
  collections: Record<string, CollectionLiveness>;
};
export type CollectionLiveness = {
  state: 'live' | 'catching_up' | 'offline' | 'error';
  backlog: number;
  gen: number;
  /** Zeitpunkt des letzten Zustandswechsels (ms seit Epoche). */
  since_ms: number;
  error?: { code: string; message: string };
};

export interface RouteEvent { from: string; to: string; params: Record<string, unknown> }

/** §10.2a Nr. 2 – gehört der Shell, versioniert mit app_api_ver. */
export interface ShellApi {
  setTitle(title: string): void;
  /** §16.19 Nr. 5: App rendert ihr Kopfzeilen-Element, die Shell setzt es in den Kopf-Slot. null entfernt es. */
  registerHeader(el: HTMLElement | null): void;
  /** Unbekanntes Ziel → Fehler in der Zustandszone, `false`, nie stiller Fallback. */
  /** Read-only: no navigation or status entry is emitted. */
  canNavigate(appId: string, params?: Record<string, unknown>): boolean;
  /** E48: ref grants one files.get to target, bound to this user/session for at most one hour; audited before routing. */
  navigate(appId: string, params: Record<string, unknown> & {ref: string | {id?: string; ref?: string}}): Promise<boolean>;
  navigate(appId: string, params?: Record<string, unknown>): boolean;
  onRoute(cb: (ev: RouteEvent) => void): () => void;
  locale: LiveDoc<string>;
  t(key: string): string;
  theme: LiveDoc<Record<string, string>>;
  /** Nur innerhalb des App-Fensters. */
  dialog(spec: unknown): Promise<unknown>;
  menu(spec: unknown): Promise<unknown>;
  window: {
    size: LiveDoc<{ width: number; height: number }>;
    mode: LiveDoc<string>;
    close(): void;
  };
  openFile(ref: string): void;
}

/** §10.2a Nr. 3 – nur Spiegel, Entscheidung im Core. */
export interface Actor {
  readonly id: string;
  readonly display_name: string;
  readonly role: string;
  permissions: LiveDoc<string[]>;
}

export type FileMeta = { id: string; name: string; mime: string; size: number; ref: string; owner_app: string; state?: 'rejected' };
export interface FileUploadHandle extends WriteHandle<{ ref: string }> {
  /** sha256 des Inhalts (hex). */
  ref: Promise<string>;
  /** Resolves on Core acceptance + upload; rejects with CtoxError {code,reason}; rejected file metadata remains locally. */
  done: Promise<WriteResult & { ref: string }>;
  upload: { progress: LiveDoc<{ sent: number; total: number }> };
}
/** §10.2a Nr. 4 + §16.10. Metadaten = Dokumente der Collection `files`. */
export type FileInfo = { id: string; ref: string; name: string | null; mime: string; size: number };
/** CAP-3b (#844): Ergebnis von files.get – Text nur für UTF-8 ≤ 512 KiB, sonst Bytes; nie Base64. */
export type FileGetResult = ({ found: true } & FileInfo & ({ text: string } | { bytes: Uint8Array })) | { found: false; ref: string | null; id?: string };
export interface FilesApi {
  /** E30: own file, readable desktop_files row with the same id (including read export), or BlobRef in a readable canonical document; otherwise forbidden. list/delete remain own-app only. */
  /** E26: end exclusive; range returns bytes and total file size; invalid bounds → CtoxError invalid/path range. */
  get(sel: ({ ref: string } | { id: string }) & { range: { start: number; end: number } }): Promise<({ found: true } & FileInfo & { bytes: Uint8Array }) | { found: false; ref: string | null; id?: string }>;
  get(sel: ({ ref: string } | { id: string }) & { range?: { start: number; end: number } }): Promise<FileGetResult>;
  /** @deprecated Altform: Blob aus dem Cache bzw. über Spur 4. */
  get(ref: string): Promise<Blob>;
  /** CAP-3b: put(bytes | {text}, {name, mime}) → {id, ref} nach lokalem Commit; Upload über Spur 4. */
  put(content: Uint8Array | ArrayBuffer | { text: string }, meta?: { id?: string; name?: string; mime?: string }): Promise<{ id: string; ref: string; done: FileUploadHandle['done'] }>;
  /** @deprecated Altform: Blob mit Upload-Handle. */
  put(blob: Blob, meta?: { id?: string; name?: string; mime?: string }): FileUploadHandle;
  list(): Promise<{ files: FileInfo[] }>;
  delete(sel: { ref: string } | { id: string }): Promise<{ deleted: boolean; id?: string }>;
}
/** #830 / CATALOG §6: Responses-förmige Antwort von model.run. */
export type ModelResponse = {
  id: string; object: 'response'; model: string; status: 'completed' | 'failed';
  output: Array<{ type: 'message'; role: 'assistant'; content: Array<{ type: 'output_text'; text: string }> }>;
  output_text: string; usage?: { input_tokens: number; output_tokens: number };
};
export interface ModelApi {
  /** Nur mit `model` in capabilities_required; Stub: deterministische simulierte Antwort. */
  run(req: { model?: string; input?: string | Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>; prompt?: string; [k: string]: unknown }): Promise<ModelResponse>;
}

/** E51: identity is bound to the caller. Limits: 64 keys, 16 KiB JSON, key [a-z0-9._-]{1,64}. */
export interface PreferencesApi {
  get<T = unknown>(key: string): T | null;
  set(key: string, value: unknown): WriteHandle;
  delete(key: string): WriteHandle;
}
export interface CtoxAppApi {
  version: '4.0';
  app: { id: string; ver: string };
  // Lesen – nur lokal, nie Netzwerk, keine Lesesperre
  query<T = any>(collection: string, q: Query): LiveQuery<ReadDocument<T>>;
  get<T = any>(collection: string, id: string): LiveDoc<ReadDocument<T> | null>;
  // Schreiben – lokal sofort, Outbox
  put<T>(collection: string, doc: T & { id: string }): WriteHandle;
  /** E35: Core writer transaction compares expected_revision; mismatch resolves result as rejected/code revision_conflict. */
  patch(collection: string, id: string, patch: object, options?: { expected_revision?: string }): WriteHandle;
  remove(collection: string, id: string): WriteHandle;
  // Befehle – Dokument mit gepushtem Status
  /** opts.record_id (§16.19 Nr. 8): optionaler Bezug des Befehls auf einen Datensatz. */
  /** E26: idempotency_key ≤ 128 characters, scoped to app + actor. SHA-256(app|user|key) → UUIDv8; repeat reuses the stored intent/state. */
  /** opts.on_complete/on_failed: Rückruf-Befehlstypen der eigenen App (§16.39 Nr. 3), als Felder am Befehlsdokument.
   *  Plattformbefehle §16.44: ctox.coding.turn {app_id, draft_id, base_draft_rev, prompt, model?, turn_id?}, ctox.coding.cancel {turn_id};
   *  Ablehnung im write_result {status:'rejected', code, reason}. */
  command(type: string, payload: object, opts?: { record_id?: string; on_complete?: string; on_failed?: string; idempotency_key?: string; target_app?: string }): CommandHandle;
  // Priorität (E1) – reiner Hinweis
  setVisible(collections: string[]): void;
  // Zustand – nur an die Zustandszone der Shell (Anf. 27)
  status: {
    report(item: StatusItem): void;
    clear(code: string): void;
  };
  // Messwerte (lesend, für die Zustandszone; Apps zeigen sie nicht selbst). Leser-Tabs: link = Zustand des Leiters.
  metrics: CommandMetrics;
  shell: ShellApi;
  actor: Actor;
  prefs: PreferencesApi;
  files: FilesApi;
  model: ModelApi;
}

/** §10.2a Nr. 1 – jede App exportiert mount(). */
export interface AppMountHandle {
  unmount(): void | Promise<void>;
  /** structured-clone-fähig, ≤ 1 MiB. */
  snapshot?(): unknown;
}
export type AppMount = (root: HTMLElement, api: CtoxAppApi, ctx: { restored?: unknown }) => AppMountHandle | Promise<AppMountHandle>;
export interface AppModule { mount: AppMount }

/** §16.15 – die Shell exportiert startShell/stopShell; der Loader tauscht damit live. */
export interface ShellModule {
  startShell(kernel: StubKernel, opts: { restored?: unknown }): void | Promise<void>;
  stopShell(): unknown | Promise<unknown>;
}

// ============================================================================================================
// Teil 2 – Shell-Kernel-API (§10.2a Nr. 6–8, §16.15) – nur für die Shell
// ============================================================================================================

export type ActivationState = 'received' | 'fetched' | 'data-ready' | 'activated' | 'failed';
/** §16.19 Nr. 6 – fehlende Felder sind null. */
export type AppLayout = {
  icon_asset: string | null;
  icon_svg: string | null;
  category: string | null;
  frame_palette: string | null;
  default_width: number | null;
  default_height: number | null;
  min_width: number | null;
  min_height: number | null;
  presentation: string | null;
};
export type AppEntry = {
  id: string;
  title: string;
  /** vom Core veröffentlicht */
  active_ver: string;
  /** lokal aktiviert (läuft) */
  activated_ver: string | null;
  /** Zustand der Aktivierung von target_ver */
  state: ActivationState;
  target_ver: string | null;
  error: string | null;
  layout: AppLayout;
  styles: string[];
};
export type Activation = {
  app_id: string;
  activated_ver: string | null;
  target_ver: string | null;
  previous_ver?: string | null;
  /** Stub: zuletzt erfolgreich aktivierte Versionen (für reportFailed). */
  good_vers?: string[];
  state: ActivationState | null;
  error: string | null;
  at_seq?: number;
  updated_at: number;
};
export type ActivationEvent = { app_id: string; ver: string | null; state: ActivationState; activated_ver: string | null; error: string | null };

export type AppManifest = {
  app_id: string;
  app_ver: string;
  files: Record<string, string>; // Pfad → sha256
  entry: string;
  collections: Record<string, { schema?: object; class?: string; client_limit?: number; byte_budget?: number; rights?: unknown }>;
  /** §16.4: Generation je Collection (fehlt = 1); Namensraum `name@g<k>`. */
  generations: Record<string, number>;
  /** Stub: durch diese Version abgelöste Namensräume (werden nach generationGraceMs lokal verworfen, §16.16). */
  retires: Record<string, string>;
  /** §16.19 Nr. 6 */
  layout: AppLayout;
  styles: string[];
  handlers: Record<string, string>;
  min_app_api: string;
  capabilities_required: string[];
  provenance: { base_release: string | null; base_hash: string | null; locally_modified: boolean };
  author: string;
  created_at: string;
};

/** §16.22 A9: Inhalt von collections.schema.json. */
export type CollectionsFile = {
  collections?: Record<string, object | { schema: object; indexes?: unknown[]; class?: string; rights?: unknown; client_limit?: number; byte_budget?: number }>;
  migrations?: Record<string, { from_ver: string; migrate_fn: string } | { from_ver: string; steps: MigrationStep[] }>;
};
/** Stub-Teilmenge deklarativer Migrationsschritte. */
export type MigrationStep =
  | { op: 'rename'; from: string; to: string }
  | { op: 'add'; field: string; value?: unknown }
  | { op: 'remove'; field: string }
  | { op: 'cast'; field: string; to: 'string' | 'number' | 'boolean' };
export type CollectionDiff = {
  name: string;
  kind: 'unchanged' | 'compatible' | 'new' | 'generation' | 'removed';
  reasons: string[];
  needsMigration: boolean;
  migration: { from_ver: string; migrate_fn?: string; steps?: MigrationStep[] } | null;
};
/** §16.22 A4. files: Pfad → Text, null = im Entwurf gelöscht. */
export interface DraftWriteHandle extends Promise<void> {
  local: Promise<void>;
  result: Promise<{ status: 'accepted'; rev: string } | { status: 'rejected'; code: string; reason?: string }>;
}
export type DraftInfo = { base_app_ver: string | null; files: Record<string, string | null>; manifest: Record<string, unknown>; updated_at: number;
  /** Bestätigte Revision der app_drafts-Zeile (= base_draft_rev, §16.44); null, solange Änderungen ausstehen oder ein neuer Entwurf noch unbestätigt ist. */
  rev: string | null };
/** §16.44: Plattform-Collection coding_turns/<turn_id> (schreibt nur der Core; messages/tool_events erst am Turn-Ende). */
export type CodingTurn = {
  id: string; app_id: string; draft_id: string; user_id: string; command_id: string; origin_app: string; base_draft_rev: string;
  prompt: string; model: string | null;
  state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'conflict';
  messages: Array<{ role: 'user' | 'assistant'; text: string; at_ms: number }>;
  tool_events: Array<{ kind: string; path?: string; at_ms: number }>;
  draft_rev_after: string | null; changed_files: string[];
  patch?: { ref: string; file_id: string };
  error?: { status: 'failed'; code: string; reason: string; detail?: string };
  callback: { on_complete: string | null; on_failed: string | null };
  created_at_ms: number; updated_at_ms: number; finished_at_ms?: number;
};

/** §10.2a Nr. 7 + §16.22. Entwürfe je (App, Nutzer), gespeichert als Collection app_drafts (Eigentum ctox-platform). */
export interface SourceApi {
  /** Recht apps.source.view. Ohne `ver`: Basis des eigenen Entwurfs (sonst aktive Version) überlagert mit dem Entwurf. */
  list(ver?: string): Promise<string[]>;
  /** Recht apps.source.view. Ohne `ver`: Entwurfsfassung, sonst Basis. Gelöschte Datei → not_found. */
  read(path: string, ver?: string): Promise<string>;
  draft: {
    /** A4 – null, wenn kein eigener Entwurf. */
    info(): Promise<DraftInfo | null>;
    /** Recht apps.source.edit (gilt für alle schreibenden Entwurfsaufrufe). `manifest.json` → invalid (§16.26). */
    /** §16.44-Ergänzung (3): Promise auf den lokalen Commit mit {local, result}; result = vom Core bestätigte Revision {status:'accepted', rev} bzw. rejected{code}. */
    write(path: string, text: string): DraftWriteHandle;
    /** A7 – not_found, wenn die Datei nicht existiert. */
    remove(path: string): Promise<void>;
    /** A7 – not_found (Quelle fehlt), conflict (Ziel existiert). Verweise im Manifest (entry, handlers, styles) wandern mit (§16.26). */
    rename(from: string, to: string): Promise<void>;
    /** A5/§16.26 – einzige Quelle der Manifest-Felder im Entwurf (title, entry, handlers, …); null entfernt ein Feld bzw. einen Handler. */
    setManifest(fields: Record<string, unknown>): Promise<void>;
    /** A6 – vollständiger Inhalt von collections.schema.json; liefert den Diff gegen die Entwurfsbasis. */
    setCollections(content: string | CollectionsFile): Promise<{ base_app_ver: string | null; diff: CollectionDiff[] }>;
    discard(): Promise<void>;
    /** Basis des Entwurfs umsetzen (Änderungen bleiben). */
    rebase(ver: string | null): Promise<void>;
    /**
     * A2/A3 – Vergleich-und-Setzen gegen die aktive Version; base_app_ver = null legt eine neue App an; ohne Angabe gilt
     * die Basis des Entwurfs. result.rev = neue Version. Gründe: forbidden | stale_base | busy | invalid (detail z. B.
     * „Migration fehlt: <coll>“ oder „Verweis auf fehlende Datei: …“, §16.26). Bei Ablehnung bleibt der Entwurf erhalten.
     */
    publish(opts?: { base_app_ver?: string | null }): WriteHandle<{ diff?: Array<{ name: string; kind: CollectionDiff['kind'] }> }>;
  };
}

/** @deprecated Alter Name (66edb98) für StatusEntry / StatusStream. */
export type StatusZoneEntry = StatusEntry;
/** @deprecated */
export type StatusZone = StatusStream;
export type StatusEntry = Readonly<StatusItem & { app_id: string; ref: string | null; source: 'app' | 'kernel' | 'shell'; at: number }>;
/** §16.19 Nr. 1: Strom der Zustandseinträge; rendern macht die Shell. Gleicher (app_id, code) ersetzt. */
export interface StatusStream extends LiveQuery<StatusEntry> {
  forApp(appId: string): LiveQuery<StatusEntry>;
  /** Eigene Einträge der Shell (source 'shell'). */
  report(appId: string, item: StatusItem): void;
  clear(appId: string, code: string): void;
}

/** §16.19 Nr. 3 – je Tab und Nutzer, IDB window_state. Werte structured-clone-fähig. */
export interface WindowStateApi {
  get<T = unknown>(key: string): Promise<T | null>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface WindowState { title: string; header: HTMLElement | null; size: { width: number; height: number }; mode: string; closed: boolean }

export interface ShellKernelApi {
  apps: LiveQuery<AppEntry>;
  activation: {
    get(appId: string): LiveDoc<Activation | null>;
    onChange(cb: (ev: ActivationEvent) => void): () => void;
    /** §16.19 Nr. 2: Version für diesen Client failed, Zeiger zurück auf die letzte funktionierende, app_activation failed. */
    reportFailed(appId: string, ver: string, reason: string): Promise<Activation>;
  };
  artifacts: {
    read(hash: string): Promise<Blob>;
    manifest(appId: string, ver: string): Promise<AppManifest | null>;
    /** §16.39 Nr. 1 (A6), synchron: /~a/<app>@<ver>~shell@<sv>~lib:<name>@<M.m>…/<path>; sv = opts.shellVer, sonst aktuell aktive Shell.
     *  lib:<name> mit "<M.m>" → /~a/lib:<name>@<M.m>[~lib:…]/<path>; Shell: /~a/shell@<sv>~lib:…/<path>. */
    url(appId: string, ver: string, path: string, opts?: { shellVer?: string; libs?: Record<string, string> }): string;
    /** §16.39 Bindung je MOUNT: beim Mount einmal aufrufen; eingefroren (Shell-Version + Lib-Minors), url(path) synchron. */
    bind(appId: string, ver: string, opts?: { shellVer?: string; libs?: Record<string, string> }): ArtifactBinding;
  };
  source(appId: string): SourceApi;
  metrics: CommandMetrics;
  leader: LiveDoc<{ isLeader: boolean; leader_gen: number; tab_id: string }>;
  identity: {
    readonly instance_id: string;
    readonly user_id: string;
    /** §16.43: eigene device_pairing_id; Stub deterministisch je (Instanz, Nutzer, Gerät). */
    readonly device_id: string | null;
    /** Schließt DB, beendet Callbacks, sperrt Zugriff. Löschen nur mit deleteData:true. */
    logout(opts?: { deleteData?: boolean }): Promise<void>;
    /** Schließt diesen Kernel und liefert einen Kernel für (Instanz, Nutzer). */
    switchInstance(next: { instanceId?: string; userId?: string }): Promise<StubKernel>;
  };
  status: StatusStream;
  /** @deprecated Alias für `status` (seit §16.19, siehe CHANGES.md). */
  statusZone: StatusStream;
  windowState: WindowStateApi;
  /** Stub: Fensterdaten, die Apps über api.shell setzen (Titel, Header-Element, …). Rendern macht die Shell. */
  window(appId: string): {
    state: LiveDoc<WindowState>;
    setSize(size: { width: number; height: number }): void;
    setMode(mode: string): void;
    reopen(): void;
  };
}

export declare function createShellKernel(kernel: StubKernel): ShellKernelApi;

// ============================================================================================================
// Teil 3 – Stub-Kernel und Sim-Hooks (nur Stub, kein Vertrag)
// ============================================================================================================

export interface StubKernelOptions {
  diagnostics?: CommandDiagnostics;
  instanceId?: string;
  userId?: string;
  /** Standard: `ctox-<instanceId>-<userId>` (§16.7). */
  dbName?: string;
  /** Simulierte Core-Latenz je Schritt (Standard 50). */
  latencyMs?: number;
  /** 'indexeddb' | 'memory'; Standard: IndexedDB, wenn vorhanden. */
  storage?: 'indexeddb' | 'memory';
  /** Native Fähigkeiten dieses Teilnehmers (für capabilities_required → needs_update). */
  capabilities?: string[];
  actor?: Partial<{ id: string; display_name: string; role: string; permissions: string[] }>;
  locale?: string;
  theme?: Record<string, string>;
  /** Startfrist der neuen Shell bei swapShell (Standard 9000, §16.19 Nr. 4). */
  shellStartTimeoutMs?: number;
  /** Alte Generation lokal behalten, bis die neue Version so lange ohne Rückfall lief (Standard 600000, §16.16). */
  generationGraceMs?: number;
  /** Tab-Identität für windowState (Standard: sessionStorage, sonst je Kernel neu). */
  tabKey?: string;
  /** §16.43: device_pairing_id aus der Gerätebindung. */
  deviceId?: string;
  /** Gerätekennung für die deterministische device_id (Standard 'browser'). */
  deviceLabel?: string;
  /** Laufzeit des simulierten Coding-Agent-Turns (§16.44, Standard 60 ms). */
  codingDelayMs?: number;
  /** false = Ein-Tab-Betrieb erzwingen. */
  multiTab?: boolean;
  /** Explicit LockManager seam for Node 20 conformance; browser default = navigator.locks. */
  locks?: Pick<LockManager, "request">;
}

export interface PublishOptions {
  /** Pfad → Inhalt (UTF-8). In-Memory-Module registriert testkit/app-host.mjs, nicht der Kernel. */
  files?: Record<string, string>;
  entry?: string;
  title?: string;
  layout?: Partial<AppLayout>;
  styles?: string[];
  collections?: AppManifest['collections'];
  /** Wasserstand; Standard = aktueller Core-Kopf. Aktivierung wartet auf Checkpoint ≥ migratedAtSeq. */
  migratedAtSeq?: number;
  /** §16.4: diese Collections bekommen eine neue Generation `name@g<k+1>`. */
  incompatible?: string[];
  /** Migrationsfunktion je Collection für die neue Generation (Standard: Identität). Nur im Leiter-Tab. */
  migrate?: Record<string, (doc: any) => any>;
  capabilitiesRequired?: string[];
  minAppApi?: string;
}

export interface StubSim {
  /** Nächster bestätigter Write wird abgelehnt. */
  rejectNext(reason?: string | {code: CtoxErrorCode; reason: string}): Promise<void>;
  /** Test Core: terminal CAS rejection, independent of the metadata write receipt. */
  rejectNextUpload(reason?: {code: CtoxErrorCode; reason: string}): Promise<void>;
  /** Nächster bestätigter Write wird `migrated`; `dropFields` wandern ins Core-Archiv. */
  migrateNext(opts?: { dropFields?: string[] }): Promise<void>;
  /** Nächster Befehl dieses Typs endet `failed`. */
  failCommand(type: string, error?: string): Promise<void>;
  /** Ergebnis-Handler für Befehle (läuft im Leiter-Tab). */
  /** K-WJ-B2: registriert den Typ zugleich in der Befehls-Registry des simulierten Cores. Typen ohne Route (kein onCommand/failCommand,
   *  kein ctox.coding.*, kein handlers-Eintrag der aktiven Version der sendenden App) → write_result {status:'rejected', code:'unknown_command'}. */
  onCommand(type: string, fn: (payload: any, ctx: { app_id: string; command_id: string; model(req: Parameters<ModelApi['run']>[0]): Promise<ModelResponse>; cap: { process: { run(req: ProcessRunRequest): Promise<ProcessRunResult> } } }) => unknown): void;
  /** CAP-3d: Plattform-Allowlist für process.run (Name → Pfad oder {program | interpreter+script, env}); null = Standard. */
  setProcessAllowlist(map: Record<string, string | { program?: string; interpreter?: string; script?: string; env?: Record<string, string> }> | null): void;
  /** Live-Änderung aus dem Core; `{id, _deleted: true}` = Löschung. Liefert vergebene seq. */
  push(collection: string, docs: Array<{ id: string; _deleted?: boolean; [k: string]: unknown }> | { id: string; [k: string]: unknown }): Promise<number[]>;
  /** state 'offline' hält Senden und Zustellung an (Rückstand wächst). */
  setLink(link: Partial<{ state: 'online' | 'offline'; rtt_ms: number; relay: boolean }>): Promise<Metrics['link']>;
  setBacklog(n: number, collection?: string): Promise<void>;
  /** §16.45: Collection in den Zustand error setzen (code null hebt auf). */
  failCollection(collection: string, code?: string | null, message?: string): Promise<void>;
  readonly transportConnects: number;
  /** Veröffentlichen + Aktivieren (received → fetched → data-ready → activated|failed). Liefert den Endzustand. */
  publishAppVersion(appId: string, ver: string, opts?: PublishOptions): Promise<Activation | null>;
  /** §16.15a Nr. 3: die nächsten n Artefakt-Abrufe liefern beschädigte Bytes. */
  corruptNextFetch(n?: number): Promise<void>;
  /** Abgelöste Generationen sofort lokal verwerfen (statt nach generationGraceMs). */
  retireGenerationsNow(appId: string): Promise<number | undefined>;
  /** Loader-Rolle: Shell starten. */
  startShell(shell: ShellModule, opts?: { restored?: unknown }): Promise<boolean>;
  /** stopShell → snapshot (window_state) → startShell(kernel, {restored}); Fehler/10 s → vorherige Shell. */
  swapShell(next: ShellModule): Promise<{ swapped: boolean; restored: unknown; error?: string }>;
  setPermissions(list: string[]): void;
  setActor(partial: Partial<{ id: string; display_name: string; role: string; permissions: string[] }>): void;
  setLocale(locale: string): void;
  setTranslations(locale: string, dict: Record<string, string>): void;
  setTheme(tokens: Record<string, string>): void;
  /** LRU-Räumung simulieren: unbestätigte (gepinnte) Blobs bleiben. */
  evictBlobs(): Promise<number>;
  /** Simuliert einen fremden Leiter (leader_gen +1) → nächste Leiteroperation wird verworfen. */
  bumpLeaderGen(): Promise<void>;
  dropBroadcasts(on?: boolean): void;
  /** Leser-Abgleich über meta.local_seq; liefert Zahl nachgeholter Dokumente. */
  reconcile(): Promise<number>;
  inspect(collection: string, id: string): Promise<any>;
  fileGrants(): Promise<Array<{event:string;from:string;to:string;ref:string;user_id:string;expires_at:number;at_ms:number}>>;
  outbox(): Promise<any[]>;
  archiveLocal(): Promise<any[]>;
  windowStateRows(): Promise<any[]>;
  /** @deprecated Alias für `windowStateRows` (seit §16.19). */
  windowState(): Promise<any[]>;
  coreHead(): Promise<number>;
  /** Wartet, bis Outbox, Zustellung und Hintergrundaufgaben ruhen. */
  settle(timeoutMs?: number): Promise<true>;
  readonly checkpoint: number;
  readonly lastVisible: { app_id: string; collections: string[]; at: number } | null;
  readonly activationReports: Array<{ app_id: string; app_ver: string; state: ActivationState; at_seq: number; error?: string }>;
  readonly navigations: RouteEvent[];
  readonly dialogs: Array<{ app_id: string; kind: 'dialog' | 'menu'; spec: unknown }>;
  readonly openedFiles: Array<{ app_id: string; ref: string }>;
  readonly staleDiscards: number;
  readonly refetches: number;
}

export interface StubKernel {
  readonly instanceId: string;
  readonly userId: string;
  readonly dbName: string;
  readonly tabId: string;
  readonly ready: Promise<void>;
  readonly isLeader: boolean;
  readonly storageKind: 'indexeddb' | 'memory' | null;
  appApi(appId: string, appVer: string): CtoxAppApi;
  // Shell-Kernel-Schnittstelle direkt am Kernel (§16.15, §16.19) – identisch mit kernel.shell
  apps: ShellKernelApi['apps'];
  activation: ShellKernelApi['activation'];
  metrics: ShellKernelApi['metrics'];
  leader: ShellKernelApi['leader'];
  status: StatusStream;
  /** @deprecated Alias für `status` (seit §16.19, siehe CHANGES.md). */
  statusZone: StatusStream;
  windowState: WindowStateApi;
  artifacts: ShellKernelApi['artifacts'];
  source: ShellKernelApi['source'];
  identity: ShellKernelApi['identity'];
  shell: ShellKernelApi;
  shellApi(): ShellKernelApi;
  /** §16.45 „Neu verbinden“: voller Neuaufbau der Verbindung (nie Seiten-Reload). */
  reconnect(): Promise<{ link: Metrics['link']; collections: Metrics['collections'] }>;
  sim: StubSim;
  close(): Promise<void>;
  logout(opts?: { deleteData?: boolean }): Promise<void>;
}

export declare const APP_API_VERSION: '4.0';
export declare function createStubKernel(opts?: StubKernelOptions): StubKernel;
export declare function compileQuery(q: Query): unknown;
export declare function runCompiledQuery<T>(docs: T[], compiled: unknown): T[];
export declare function uuidv7(): string;
export declare function sha256Hex(content: string | Blob | ArrayBuffer | ArrayBufferView): Promise<string>;
export declare function mergePatch<T>(target: T, patch: object): T;
export declare const SCHEMA_FILE: 'collections.schema.json';
export declare function parseCollectionsFile(input: string | CollectionsFile): { collections: Record<string, { schema: any; indexes: unknown[]; class: string | null; rights: unknown; client_limit: number | null; byte_budget: number | null }>; migrations: CollectionsFile['migrations'] };
export declare function classifyCollections(base: ReturnType<typeof parseCollectionsFile>, next: ReturnType<typeof parseCollectionsFile>, opts?: { baseVer?: string | null }): CollectionDiff[];
export declare function applyMigrationSteps<T extends object>(doc: T, steps: MigrationStep[]): T;

export interface ArtifactBinding {
  readonly appId: string;
  readonly ver: string;
  readonly shellVer: string | null;
  readonly libs: Readonly<Record<string, string>>;
  readonly root: string;
  url(path: string): string;
  /** §16.50: gleich-ursprüngliche Worker-URL unter der gebundenen Lib-Wurzel `/~a/lib:<name>@<M.m>[~lib:…]/<path>` (nie data:/blob:); nicht gebunden → not_found. */
  workerUrl(lib: string, path: string): string;
}

/** CAP-3d (#844, §16.47): process.run – program = Name aus der Plattform-Allowlist; env ergänzt nur die Grund-Umgebung
 *  (PATH, CTOX_BIN, LANG; Ersetzen → invalid); stdin (UTF-8 ≤ 1 MiB) ODER stdin_ref (files der eigenen App). Stub: simuliert. */
export type ProcessRunRequest = { program: string; args?: string[]; env?: Record<string, string>; stdin?: string; stdin_ref?: { ref: string }; timeout_ms?: number };
export type ProcessRunResult = { exit_code: number | null; stdout: string; stderr: string; timed_out: boolean };
