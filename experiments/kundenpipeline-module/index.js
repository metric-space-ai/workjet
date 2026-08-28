const MODULE_ID = "kundenpipeline";
const COL_VORGAENGE = "kundenpipeline_vorgaenge";
const COL_ENTSCHEIDUNGEN = "kundenpipeline_entscheidungen";
const COL_PROJEKTE = "kundenpipeline_projekte";

// Cache-Buster der Shell an Markup/CSS/Locales weiterreichen.
const VERSION = new URL(import.meta.url).searchParams.get("v") || "";
const withV = (path) => `${path}${VERSION ? `?v=${VERSION}` : ""}`;

export async function mount(ctx) {
  if (!ctx?.host) throw new Error(`[${MODULE_ID}] mount(ctx) requires ctx.host`);
  // Renderer mit demselben Cache-Buster laden wie Markup/CSS/Locales —
  // ein statischer Import bliebe über Modulversionen hinweg gecacht.
  const {
    renderView,
    buildView,
    decisionIcons,
    hitTest,
    clampScroll,
    layoutText,
    typLabel,
    BODY_LINES,
  } = await import(new URL(withV("./core/glasses-renderer.mjs"), import.meta.url).href);
  await ensureStyles();
  const locale = ctx.locale === "en" ? "en" : "de";
  const copy = await loadJson(withV(`./locales/${locale}.json`));
  ctx.host.innerHTML = await loadMarkup();
  const root = ctx.host.querySelector("[data-kpl-root]");
  applyCopy(root, copy);

  const el = {
    leftPane: root.querySelector(".kpl-left"),
    navList: root.querySelector("[data-nav-list]"),
    canvas: root.querySelector("[data-glass-canvas]"),
    gestureRow: root.querySelector("[data-gesture-row]"),
    displayTitle: root.querySelector("[data-display-title]"),
    contextToggle: root.querySelector("[data-toggle-context]"),
    contextPanel: root.querySelector("[data-context-panel]"),
    vorgangFields: root.querySelector("[data-vorgang-fields]"),
    auditList: root.querySelector("[data-audit-list]"),
    empty: root.querySelector("[data-empty-state]"),
    setupList: root.querySelector("[data-setup-list]"),
    footer: root.querySelector("[data-pg-footer]"),
    mobileBack: root.querySelector("[data-mobile-back]"),
    stage: root.querySelector(".kpl-stage"),
    glassFrame: root.querySelector(".kpl-glass-frame"),
    desktopView: root.querySelector("[data-desktop-view]"),
    dvKicker: root.querySelector("[data-dv-kicker]"),
    dvTitel: root.querySelector("[data-dv-titel]"),
    dvSections: root.querySelector("[data-dv-sections]"),
  };

  const vorgaenge = getCollection(ctx, COL_VORGAENGE);
  const entscheidungen = getCollection(ctx, COL_ENTSCHEIDUNGEN);
  const projekte = getCollection(ctx, COL_PROJEKTE);
  const canWrite = ctx.permissions?.canWriteCollection?.(COL_VORGAENGE) !== false;

  const state = {
    vorgaenge: [],
    entscheidungen: [],
    projekte: [],
    band: "offen",
    search: "",
    typFilter: "all",
    view: "cards",
    selectedId: "",
    displayMode: "glass",
    focusIcon: -1,
    scroll: 0,
    contextOpen: false,
    clickTimer: 0,
  };

  buildCorrectionComposer();
  wireCreateModal();
  wireProjectModal();
  await refresh();
  // Abo nur mit Leserecht: schon der Zugriff auf `$` wirft sonst synchron.
  const safeSubscribe = (collection) => {
    try {
      return collection?.$?.subscribe?.(() => refresh().catch(reportError)) || null;
    } catch {
      return null;
    }
  };
  const subs = [safeSubscribe(vorgaenge), safeSubscribe(entscheidungen), safeSubscribe(projekte)];

  // Pane-Grammar: die Shell verdrahtet data-pg-*; das Modul hört auf das
  // Change-Event. Standalone-Fallback nur, wenn keine Shell-Wiring existiert.
  const grammarHandler = (event) => {
    const s = event.detail || el.leftPane.__ctoxPaneGrammar?.state || {};
    state.search = (s.search || "").toLowerCase();
    state.band = s.band || state.band;
    state.view = s.view || state.view;
    state.typFilter = s.filters?.typ ?? state.typFilter;
    renderList();
    renderStage();
  };
  el.leftPane.addEventListener("ctox-pane-grammar-change", grammarHandler);
  const standaloneCleanup = el.leftPane.__ctoxPaneGrammar
    ? null
    : wireStandaloneGrammar(el.leftPane, grammarHandler);

  const clickHandler = (event) => {
    const modeNode = event.target.closest("[data-mode-tab]");
    if (modeNode) {
      state.displayMode = modeNode.dataset.modeTab;
      for (const tab of root.querySelectorAll("[data-mode-tab]")) {
        const active = tab === modeNode;
        tab.classList.toggle("is-active", active);
        tab.setAttribute("aria-selected", String(active));
      }
      renderStage();
      return;
    }
    const gestureNode = event.target.closest("[data-gesture]");
    if (gestureNode) return handleGesture(gestureNode.dataset.gesture, "desktop-geste");
    const actionNode = event.target.closest("[data-action]");
    if (actionNode) return handleAction(actionNode.dataset.action);
    const rowNode = event.target.closest("[data-context-record-id]");
    if (rowNode && rowNode.dataset.contextRecordType === "projekt") {
      openProjectModal(
        state.projekte.find((p) => p.id === rowNode.dataset.contextRecordId) || null,
      );
      return;
    }
    if (rowNode && rowNode.dataset.contextRecordType === "entscheidung") {
      selectDecision(rowNode.dataset.contextRecordId);
      root.classList.add("is-detail");
    } else if (rowNode) {
      selectVorgang(rowNode.dataset.contextRecordId);
      root.classList.add("is-detail");
    }
  };
  const backHandler = () => root.classList.remove("is-detail");
  const wheelHandler = (event) => {
    event.preventDefault();
    // Trackpads feuern viele kleine Deltas: akkumulieren, ein Schritt je 70px.
    state.wheelAcc = (state.wheelAcc || 0) + event.deltaY;
    if (Math.abs(state.wheelAcc) < 70) return;
    const richtung = Math.sign(state.wheelAcc);
    state.wheelAcc = 0;
    scrollDisplay(richtung);
  };
  const canvasClickHandler = (event) => {
    window.clearTimeout(state.clickTimer);
    const rect = el.canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) * (576 / rect.width);
    const y = (event.clientY - rect.top) * (288 / rect.height);
    const hit = hitTest(buildView(viewState()), x, y);
    if (hit?.typ === "tab") {
      const open = filteredOpen();
      if (open[hit.index]) selectDecision(open[hit.index].id);
      renderStage();
      return;
    }
    if (hit?.typ === "icon") {
      state.focusIcon = hit.index;
      renderStage();
      const decision = currentDecision();
      const icons = decisionIcons(decision, copy);
      state.clickTimer = window.setTimeout(
        () => activateIcon(icons[hit.index], decision, "desktop-klick"),
        260,
      );
      return;
    }
    state.clickTimer = window.setTimeout(() => handleGesture("press", "desktop-geste"), 260);
  };
  const canvasDblHandler = () => {
    window.clearTimeout(state.clickTimer);
    handleGesture("doublePress", "desktop-geste");
  };
  const keyHandler = (event) => {
    if (event.target.closest("input, textarea, select")) return;
    const map = {
      Enter: "press",
      Backspace: "doublePress",
      ArrowRight: "swipe",
      ArrowLeft: "swipeBack",
    };
    if (map[event.key]) {
      event.preventDefault();
      handleGesture(map[event.key], "desktop-taste");
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      scrollDisplay(1);
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      scrollDisplay(-1);
    }
  };
  root.addEventListener("click", clickHandler);
  el.mobileBack.addEventListener("click", backHandler);
  el.canvas.addEventListener("wheel", wheelHandler, { passive: false });
  el.canvas.addEventListener("click", canvasClickHandler);
  el.canvas.addEventListener("dblclick", canvasDblHandler);
  window.addEventListener("keydown", keyHandler);

  return () => {
    for (const sub of subs) sub?.unsubscribe?.();
    standaloneCleanup?.();
    el.leftPane.removeEventListener("ctox-pane-grammar-change", grammarHandler);
    root.removeEventListener("click", clickHandler);
    el.canvas.removeEventListener("wheel", wheelHandler);
    window.removeEventListener("keydown", keyHandler);
    ctx.host.replaceChildren();
  };

  // ---------- Daten ----------

  async function refresh() {
    try {
      state.vorgaenge = await readAll(vorgaenge);
      state.entscheidungen = await readAll(entscheidungen);
      state.projekte = await readAll(projekte);
      state.permissionDenied = false;
    } catch (error) {
      // Fehlende Datenrechte sind ein regulärer Zustand, kein Crash:
      // Permission-Callout mit Anforderungsweg statt Fehlerseite.
      if (
        error?.code === "CTOX_BUSINESS_OS_PERMISSION_DENIED" ||
        error?.name === "BusinessOsPermissionError"
      ) {
        state.permissionDenied = true;
        state.vorgaenge = [];
        state.entscheidungen = [];
        renderPermissionState();
        return;
      }
      throw error;
    }
    const open = filteredOpen();
    if (!open.some((d) => d.id === state.selectedId)) {
      state.selectedId = open[0]?.id || "";
      state.scroll = 0;
    }
    renderCounts();
    renderList();
    renderStage();
  }

  async function readAll(collection) {
    if (!collection?.find) return [];
    const docs = await collection.find().exec();
    return docs
      .map((doc) => doc.toJSON?.() || doc)
      .filter((record) => !record.is_deleted)
      .sort((a, b) => Number(a.created_at_ms) - Number(b.created_at_ms));
  }

  function openDecisions() {
    return state.entscheidungen.filter((d) => d.status === "offen");
  }

  function filteredOpen() {
    return openDecisions().filter(
      (d) =>
        (state.typFilter === "all" || !state.typFilter || d.typ === state.typFilter) &&
        matchesSearch(d.titel + " " + (d.zeilen_json || []).join(" ")),
    );
  }

  function matchesSearch(text) {
    return !state.search || String(text).toLowerCase().includes(state.search);
  }

  function currentDecision() {
    return filteredOpen().find((d) => d.id === state.selectedId) || null;
  }

  function vorgangOf(decision) {
    return state.vorgaenge.find((v) => v.id === decision?.vorgang_id) || null;
  }

  async function writeVorgang(record) {
    ensureWrite();
    await mustCollection(vorgaenge, COL_VORGAENGE).upsert({ ...record, updated_at_ms: Date.now() });
  }

  async function writeDecision(record) {
    ensureWrite();
    await mustCollection(entscheidungen, COL_ENTSCHEIDUNGEN).upsert({
      ...record,
      updated_at_ms: Date.now(),
    });
  }

  async function writeProjekt(record) {
    ensureWrite();
    await mustCollection(projekte, COL_PROJEKTE).upsert({ ...record, updated_at_ms: Date.now() });
  }

  // Routing: Absender -> Projekt (exakte Adresse) bzw. Domain-Vorschlag.
  function projektFuerAbsender(absender) {
    const adresse = String(absender || "")
      .toLowerCase()
      .trim();
    if (!adresse) return { treffer: null, vorschlag: null };
    const domain = adresse.split("@")[1] || "";
    let treffer = null;
    let vorschlag = null;
    for (const projekt of state.projekte) {
      if (projekt.aktiv === false) continue;
      const adressen = (projekt.adressen_json || []).map((a) => String(a).toLowerCase().trim());
      if (adressen.includes(adresse)) {
        treffer = projekt;
        break;
      }
      const domains = (projekt.domains_json || []).map((d) => String(d).toLowerCase().trim());
      if (domain && domains.includes(domain)) vorschlag = vorschlag || projekt;
    }
    return { treffer, vorschlag };
  }

  function ensureWrite() {
    if (!canWrite) throw new Error(copy.no_write);
  }

  // ---------- Pipeline ----------

  // Serverseitige Pipeline-Commands (Versand, Delegation) — nur nach
  // menschlicher Annahme der jeweiligen Entscheidung.
  async function dispatchPipelineCommand(commandType, payload) {
    if (!ctx.commandBus?.dispatch) {
      ctx.notifications?.show?.({
        type: "warning",
        title: copy.error_title,
        message: copy.no_command_bus,
      });
      return null;
    }
    return ctx.commandBus.dispatch({
      command_type: commandType,
      module_id: MODULE_ID,
      payload,
    });
  }

  async function answerDecision(decision, wert, kanal) {
    if (!decision) return;
    const vorgang = vorgangOf(decision);
    const now = Date.now();
    const status = wert === "annehmen" ? "entschieden" : "abgelehnt";
    await writeDecision({
      ...decision,
      status,
      antwort_json: { ...decision.antwort_json, wert, kanal, zeit_ms: now },
    });
    // The RxDB write above drives the UI instantly; this command is what makes
    // the answer authoritative natively (and closes the Threads inbox item).
    await dispatchPipelineCommand("kundenpipeline.decision.answer", {
      vorgang_id: vorgang?.id || decision.vorgang_id || "",
      entscheidung_id: decision.id,
      wert,
      kanal,
    })?.catch?.(reportError);
    if (vorgang) {
      const audit = [
        ...(vorgang.audit_json || []),
        { zeit_ms: now, aktion: `${decision.typ}:${wert}`, akteur: "owner", kanal },
      ];
      const next = transition(vorgang, decision, wert);
      await writeVorgang({ ...vorgang, ...next.patch, audit_json: audit });
      for (const folge of next.folgen) await writeDecision(makeDecision(folge, vorgang));
      // Versand und Delegation loest kundenpipeline.decision.answer
      // serverseitig aus — sonst wuerde dieselbe Annahme von Desktop UND
      // Brille je eine Mail verschicken.
    }
    ctx.notifications?.show?.({
      type: "success",
      title: wert === "annehmen" ? copy.accepted : copy.rejected,
      message: decision.titel,
    });
    state.scroll = 0;
    await refresh();
  }

  async function submitCorrection(text) {
    const decision = currentDecision();
    if (!decision || !text.trim()) return;
    const vorgang = vorgangOf(decision);
    const now = Date.now();
    const korrekturen = [
      ...(decision.antwort_json?.korrekturen || []),
      { text: text.trim(), zeit_ms: now, kanal: "desktop" },
    ];
    const seiten = [
      ...(decision.detail_seiten_json || []),
      { titel: copy.correction_section, zeilen: layoutText(text.trim()) },
    ];
    await writeDecision({
      ...decision,
      antwort_json: { ...decision.antwort_json, korrekturen },
      detail_seiten_json: seiten,
    });
    if (vorgang) {
      await writeVorgang({
        ...vorgang,
        audit_json: [
          ...(vorgang.audit_json || []),
          { zeit_ms: now, aktion: `${decision.typ}:korrektur`, akteur: "owner", kanal: "desktop" },
        ],
      });
    }
    await dispatchRework(decision, text.trim()).catch(reportError);
    ctx.notifications?.show?.({
      type: "success",
      title: copy.correction_saved,
      message: text.trim().slice(0, 80),
    });
    await refresh();
  }

  // Automation: Korrektur als echten CTOX-Auftrag dispatchen (Vorschlag neu
  // erarbeiten). Ohne Command-Bus (Standalone-Preview) still überspringen.
  async function dispatchRework(decision, korrektur) {
    if (!ctx.commandBus?.dispatch) return;
    const vorgang = vorgangOf(decision);
    await ctx.commandBus.dispatch({
      command_type: "business_os.chat.task",
      module_id: MODULE_ID,
      payload: {
        intent: "kundenpipeline.vorschlag_rework",
        vorgang_id: vorgang?.id || "",
        entscheidung_id: decision.id,
        korrektur,
      },
    });
  }

  function transition(vorgang, decision, wert) {
    const ok = wert === "annehmen";
    switch (decision.typ) {
      case "zuordnung":
        return ok
          ? {
              patch: { status: "zugeordnet" },
              folgen: vorgang.triage_json ? [triageDecision(vorgang)] : [],
            }
          : { patch: { status: "abgelehnt" }, folgen: [] };
      case "triage":
        return ok
          ? { patch: { status: "freigegeben" }, folgen: [mailDecision(vorgang, "bestaetigung")] }
          : { patch: { status: "abgelehnt" }, folgen: [] };
      case "mailfreigabe":
        return ok
          ? {
              patch: { status: decision.backing_ref === "ergebnis" ? "abgeschlossen" : "inArbeit" },
              folgen: [],
            }
          : { patch: {}, folgen: [] };
      case "ergebnisfreigabe":
        return ok
          ? {
              patch: { status: "ergebnisFreigegeben" },
              folgen: [mailDecision(vorgang, "ergebnis")],
            }
          : { patch: { status: "inArbeit" }, folgen: [] };
      default:
        return { patch: {}, folgen: [] };
    }
  }

  // Triage-Karte: bereinigter Mail-Body, Antwort-Vorschlag, Agent-Aufgabe.
  function triageDecision(vorgang) {
    const triage = vorgang.triage_json || {};
    const zeilen = [];
    const body = vorgang.quelle_json?.body_clean || "";
    if (body) zeilen.push(`▸ ${copy.section_mail}`, ...layoutText(body), "");
    if (triage.antwort_vorschlag)
      zeilen.push(`▸ ${copy.section_reply}`, ...layoutText(triage.antwort_vorschlag), "");
    if (triage.aufgabe) {
      zeilen.push(
        `▸ ${copy.section_task} → ${triage.aufgabe.agent || "Agent"}`,
        ...layoutText(triage.aufgabe.beschreibung || ""),
      );
    }
    return {
      typ: "triage",
      titel: kurz(`${vorgang.kunde_name || vorgang.title}`, 40),
      zeilen,
    };
  }

  function mailDecision(vorgang, art) {
    const text =
      art === "ergebnis"
        ? vorgang.run_json?.zusammenfassung || copy.result_placeholder
        : vorgang.triage_json?.antwort_vorschlag || copy.confirm_placeholder;
    return {
      typ: "mailfreigabe",
      backing_ref: art,
      titel: kurz(
        `${art === "ergebnis" ? copy.result_mail : copy.confirm_mail}: ${vorgang.kunde_name || vorgang.title}`,
        40,
      ),
      zeilen: [`▸ ${copy.mail_preview}`, ...layoutText(text)],
    };
  }

  function makeDecision(spec, vorgang) {
    return {
      id: `kpl-e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      vorgang_id: vorgang.id,
      typ: spec.typ,
      titel: spec.titel,
      zeilen_json: spec.zeilen || [],
      detail_seiten_json: spec.detailSeiten || [],
      aktionen_json: spec.aktionen || [],
      backing_ref: spec.backing_ref || "",
      status: "offen",
      antwort_json: {},
      is_deleted: false,
      created_at_ms: Date.now(),
      updated_at_ms: Date.now(),
    };
  }

  // ---------- Gesten ----------

  function handleGesture(geste, kanal) {
    const open = filteredOpen();
    const decision = currentDecision();
    if (!decision) return;
    const index = open.findIndex((d) => d.id === decision.id);
    const icons = decisionIcons(decision, copy);
    const view = buildView(viewState());
    const maxScroll = Math.max(0, view.zeilen.length - BODY_LINES);

    if (geste === "swipe") {
      // Ein Fluss: Text scrollen → Icons fokussieren → nächstes Item.
      if (state.focusIcon < 0 && state.scroll < maxScroll) {
        state.scroll = clampScroll(state.scroll + 2, view.zeilen.length, BODY_LINES);
      } else if (state.focusIcon < icons.length - 1) {
        state.focusIcon += 1;
      } else {
        state.selectedId = open[(index + 1) % open.length].id;
        state.scroll = 0;
        state.focusIcon = -1;
        flipSelection();
      }
      renderStage();
      return;
    }
    if (geste === "swipeBack") {
      if (state.focusIcon > 0) {
        state.focusIcon -= 1;
      } else if (state.focusIcon === 0) {
        state.focusIcon = -1;
      } else if (state.scroll > 0) {
        state.scroll = clampScroll(state.scroll - 2, view.zeilen.length, BODY_LINES);
      } else {
        state.selectedId = open[(index - 1 + open.length) % open.length].id;
        const prev = currentDecision();
        state.focusIcon = prev ? decisionIcons(prev, copy).length - 1 : -1;
        state.scroll = 0;
        flipSelection();
      }
      renderStage();
      return;
    }
    if (geste === "press") {
      if (state.focusIcon >= 0) activateIcon(icons[state.focusIcon], decision, kanal);
      return;
    }
    if (geste === "doublePress") {
      if (state.focusIcon >= 0) {
        state.focusIcon = -1;
      } else {
        state.scroll = 0;
      }
      renderStage();
    }
  }

  function activateIcon(icon, decision, kanal) {
    if (!icon) return;
    if (icon.wert === "korrektur") {
      el.correction.hidden = false;
      el.correction.querySelector("textarea")?.focus();
      return;
    }
    if (icon.wert === "vertagt") {
      snoozeDecision(decision, kanal).catch(reportError);
      return;
    }
    answerDecision(decision, icon.wert, kanal).catch(reportError);
  }

  // Auf später verschieben: ans Ende der Queue (Sortierung: created_at_ms).
  async function snoozeDecision(decision, kanal) {
    const now = Date.now();
    await writeDecision({ ...decision, created_at_ms: now });
    const vorgang = vorgangOf(decision);
    if (vorgang) {
      await writeVorgang({
        ...vorgang,
        audit_json: [
          ...(vorgang.audit_json || []),
          { zeit_ms: now, aktion: `${decision.typ}:vertagt`, akteur: "owner", kanal },
        ],
      });
    }
    state.focusIcon = -1;
    state.scroll = 0;
    ctx.notifications?.show?.({ type: "success", title: copy.snoozed, message: decision.titel });
    await refresh();
  }

  function scrollDisplay(deltaLines) {
    handleGesture(deltaLines > 0 ? "swipe" : "swipeBack", "desktop-rad");
  }

  function selectDecision(id) {
    state.selectedId = id;
    state.focusIcon = -1;
    state.scroll = 0;
    flipSelection();
    renderStage();
  }

  function selectVorgang(id) {
    const decision = openDecisions().find((d) => d.vorgang_id === id);
    if (decision) {
      selectDecision(decision.id);
      return;
    }
    state.contextOpen = true;
    renderContext(state.vorgaenge.find((v) => v.id === id) || null);
    el.contextPanel.hidden = false;
  }

  // ---------- Aktionen ----------

  function handleAction(action) {
    if (action === "close-project-modal") {
      el.projectModal.hidden = true;
      return;
    }
    if (action === "dv-annehmen" || action === "dv-ablehnen" || action === "dv-vertagt") {
      const decision = currentDecision();
      if (!decision) return;
      if (action === "dv-vertagt") return snoozeDecision(decision, "desktop").catch(reportError);
      return answerDecision(
        decision,
        action === "dv-annehmen" ? "annehmen" : "ablehnen",
        "desktop",
      ).catch(reportError);
    }
    if (action === "create-vorgang") {
      if (state.band === "projekte") {
        openProjectModal(null);
        return;
      }
      el.modal.hidden = false;
      el.modalForm.elements.titel.focus();
      return;
    }
    if (action === "close-modal") {
      el.modal.hidden = true;
      return;
    }
    if (action === "seed") return seedDemo().catch(reportError);
    if (action === "export") return exportRecords();
    if (action === "import") return importRecords();
    if (action === "toggle-context") {
      state.contextOpen = !state.contextOpen;
      el.contextToggle.setAttribute("aria-pressed", String(state.contextOpen));
      renderStage();
    }
  }

  function exportRecords() {
    const payload = { vorgaenge: state.vorgaenge, entscheidungen: state.entscheidungen };
    const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${MODULE_ID}-export.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function importRecords() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.addEventListener(
      "change",
      async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          const parsed = JSON.parse(await file.text());
          for (const record of parsed.vorgaenge || []) await writeVorgang(record);
          for (const record of parsed.entscheidungen || []) await writeDecision(record);
        } catch (error) {
          reportError(error);
        }
      },
      { once: true },
    );
    input.click();
  }

  // ---------- Rendering ----------

  function renderCounts() {
    const counts = {
      offen: openDecisions().length,
      vorgaenge: state.vorgaenge.filter((v) => !["abgeschlossen", "abgelehnt"].includes(v.status))
        .length,
      erledigt: state.vorgaenge.filter((v) => ["abgeschlossen", "abgelehnt"].includes(v.status))
        .length,
      projekte: state.projekte.length,
    };
    for (const [key, value] of Object.entries(counts)) {
      const node = el.leftPane.querySelector(`[data-pg-count="${key}"]`);
      if (node) node.textContent = ` (${value})`;
    }
  }

  function bandItems() {
    if (state.band === "projekte") {
      return state.projekte
        .filter((p) =>
          matchesSearch(
            `${p.name} ${(p.adressen_json || []).join(" ")} ${(p.domains_json || []).join(" ")}`,
          ),
        )
        .map((p) => ({
          id: p.id,
          type: "projekt",
          title: p.name,
          sub: [
            (p.adressen_json || []).length + " " + copy.project_addresses_short,
            (p.domains_json || []).join(", "),
            p.code_projekt,
          ]
            .filter(Boolean)
            .join(" · "),
        }));
    }
    if (state.band === "offen") {
      return filteredOpen().map((d) => ({
        id: d.id,
        type: "entscheidung",
        title: d.titel,
        sub: `${typLabel(d.typ)} · ${vorgangOf(d)?.kunde_name || vorgangOf(d)?.quelle_json?.absender || ""}`,
      }));
    }
    const done = state.band === "erledigt";
    return state.vorgaenge
      .filter((v) => done === ["abgeschlossen", "abgelehnt"].includes(v.status))
      .filter((v) => matchesSearch(`${v.title} ${v.kunde_name}`))
      .map((v) => ({
        id: v.id,
        type: "vorgang",
        title: v.title,
        sub: `${copy[`status_${v.status}`] || v.status} · ${v.kunde_name || v.quelle_json?.absender || ""}`,
      }));
  }

  function renderList() {
    const items = bandItems();
    el.navList.replaceChildren();
    for (const item of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `ctox-list-item${item.id === state.selectedId ? " is-selected" : ""}`;
      button.dataset.contextRecordId = item.id;
      button.dataset.contextRecordType = item.type;
      button.dataset.contextLabel = item.title;
      const strong = document.createElement("strong");
      strong.textContent = item.title;
      const small = document.createElement("small");
      small.textContent = item.sub;
      button.append(strong, small);
      el.navList.append(button);
    }
    if (el.footer)
      el.footer.textContent = `${items.length} ${copy.entries} · ${copy[`band_${state.band}`] || state.band}`;
  }

  function flipSelection() {
    for (const node of el.navList.querySelectorAll("[data-context-record-id]")) {
      node.classList.toggle("is-selected", node.dataset.contextRecordId === state.selectedId);
    }
  }

  // Lazy setup instead of a blocking wizard: name what is still missing and
  // link straight to the app that fixes it.
  function renderSetupList() {
    if (!el.setupList) return;
    const steps = [
      {
        done: state.projekte.length > 0,
        label: copy.setup_project,
        action: () => openProjectModal(null),
      },
      {
        done: state.vorgaenge.length > 0,
        label: copy.setup_mailbox,
        action: () => window.CTOX_BUSINESS_OS_APP?.openModule?.("mail"),
      },
    ];
    if (steps.every((step) => step.done)) {
      el.setupList.hidden = true;
      el.setupList.replaceChildren();
      return;
    }
    el.setupList.hidden = false;
    el.setupList.replaceChildren(
      ...steps.map((step) => {
        const item = document.createElement("li");
        item.dataset.done = String(step.done);
        const mark = document.createElement("span");
        mark.className = "kpl-setup-mark";
        mark.textContent = step.done ? "✓" : "○";
        item.append(mark);
        if (step.done) {
          item.append(document.createTextNode(step.label));
        } else {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "ctox-button ctox-button--sm";
          button.textContent = step.label;
          button.addEventListener("click", step.action);
          item.append(button);
        }
        return item;
      }),
    );
  }

  function renderStage() {
    const decision = currentDecision();
    el.displayTitle.textContent = decision ? decision.titel : copy.display_empty;
    el.empty.hidden = Boolean(decision);
    if (!decision) renderSetupList();
    const glass = state.displayMode === "glass";
    el.glassFrame.hidden = !glass || !decision;
    el.desktopView.hidden = glass || !decision;
    if (glass) {
      drawDisplay();
      renderGestures(decision);
    } else if (decision) {
      renderDesktopView(decision);
    }
    const showContext = state.contextOpen && Boolean(decision);
    el.contextPanel.hidden = !showContext;
    if (showContext) renderContext(vorgangOf(decision));
    el.correction.hidden = !decision;
  }

  // Desktop-Modus: dieselbe Entscheidung als Arbeitsseite mit Direkt-Editing.
  function renderDesktopView(decision) {
    const vorgang = vorgangOf(decision);
    el.dvKicker.textContent = [
      typLabel(decision.typ),
      vorgang?.kunde_name || vorgang?.quelle_json?.absender,
    ]
      .filter(Boolean)
      .join(" · ");
    el.dvTitel.textContent = decision.titel;
    el.dvSections.replaceChildren();
    const quelle = vorgang?.quelle_json || {};
    const triage = vorgang?.triage_json || {};

    if (quelle.body_clean) {
      el.dvSections.append(
        sectionNode(copy.section_mail, quelle.absender, (p) => {
          p.textContent = quelle.body_clean;
        }),
      );
    }

    // Antwort-Vorschlag: direkt editierbar + Diktat.
    el.dvSections.append(
      sectionNode(copy.section_reply, null, (bodyNode, section) => {
        const textarea = document.createElement("textarea");
        textarea.className = "ctox-textarea kpl-dv-edit";
        textarea.rows = 5;
        textarea.value = triage.antwort_vorschlag || vorgang?.run_json?.zusammenfassung || "";
        textarea.placeholder = copy.reply_placeholder;
        textarea.addEventListener("change", () =>
          saveTriagePatch(vorgang, decision, { antwort_vorschlag: textarea.value }),
        );
        bodyNode.append(textarea);
        section
          .querySelector("h4")
          .append(
            micButton(textarea, () =>
              saveTriagePatch(vorgang, decision, { antwort_vorschlag: textarea.value }),
            ),
          );
      }),
    );

    // Aufgabe: Agent + Beschreibung editierbar + Diktat.
    el.dvSections.append(
      sectionNode(copy.section_task, null, (bodyNode, section) => {
        const agent = document.createElement("input");
        agent.className = "ctox-input kpl-dv-agent";
        agent.value = triage.aufgabe?.agent || "";
        agent.placeholder = copy.task_agent_placeholder;
        agent.setAttribute("aria-label", copy.task_agent_placeholder);
        const beschreibung = document.createElement("textarea");
        beschreibung.className = "ctox-textarea kpl-dv-edit";
        beschreibung.rows = 4;
        beschreibung.value = triage.aufgabe?.beschreibung || "";
        beschreibung.placeholder = copy.task_placeholder;
        const speichern = () =>
          saveTriagePatch(vorgang, decision, {
            aufgabe: { agent: agent.value.trim(), beschreibung: beschreibung.value },
          });
        agent.addEventListener("change", speichern);
        beschreibung.addEventListener("change", speichern);
        bodyNode.append(agent, beschreibung);
        section.querySelector("h4").append(micButton(beschreibung, speichern));
      }),
    );

    for (const seite of decision.detail_seiten_json || []) {
      el.dvSections.append(
        sectionNode(seite.titel || "", null, (p) => {
          p.textContent = (seite.zeilen || []).join("\n");
        }),
      );
    }
  }

  function sectionNode(kicker, meta, fill) {
    const section = document.createElement("section");
    section.className = "kpl-desktop-section";
    const h = document.createElement("h4");
    h.textContent = kicker;
    if (meta) {
      const span = document.createElement("span");
      span.className = "kpl-agent";
      span.textContent = meta;
      h.append(span);
    }
    const body = document.createElement("div");
    body.className = "kpl-dv-body";
    section.append(h, body);
    const p = document.createElement("p");
    const maybe = fill(fill.length > 1 ? body : p, section);
    if (p.textContent) body.append(p);
    return section;
  }

  // Editierte Triage speichern und die offene Entscheidung neu aufbauen,
  // damit Brillen-Ansicht und Karte denselben Stand zeigen.
  async function saveTriagePatch(vorgang, decision, patch) {
    if (!vorgang) return;
    try {
      const triage = { ...vorgang.triage_json, ...patch };
      const updated = {
        ...vorgang,
        triage_json: triage,
        audit_json: [
          ...(vorgang.audit_json || []),
          {
            zeit_ms: Date.now(),
            aktion: `${decision.typ}:bearbeitet`,
            akteur: "owner",
            kanal: "desktop",
          },
        ],
      };
      await writeVorgang(updated);
      if (decision.typ === "triage") {
        const spec = triageDecision(updated);
        await writeDecision({ ...decision, zeilen_json: spec.zeilen });
      }
      ctx.notifications?.show?.({ type: "success", title: copy.saved, message: decision.titel });
    } catch (error) {
      reportError(error);
    }
  }

  // Echtes Mikrofon-Diktat (Web Speech API), Ergebnis wird angehängt.
  function micButton(textarea, onDone) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ctox-pane-icon kpl-mic";
    button.setAttribute("aria-label", copy.dictate);
    button.title = copy.dictate;
    button.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      button.disabled = true;
      button.title = copy.dictate_unavailable;
      return button;
    }
    let recognizer = null;
    button.addEventListener("click", () => {
      if (recognizer) {
        recognizer.stop();
        return;
      }
      recognizer = new Recognition();
      recognizer.lang = locale === "en" ? "en-US" : "de-DE";
      recognizer.continuous = true;
      recognizer.interimResults = false;
      button.classList.add("is-recording");
      recognizer.onresult = (event) => {
        const text = [...event.results]
          .slice(event.resultIndex)
          .map((r) => r[0].transcript)
          .join(" ")
          .trim();
        if (text) textarea.value = `${textarea.value.trim()} ${text}`.trim();
      };
      recognizer.onend = () => {
        button.classList.remove("is-recording");
        recognizer = null;
        onDone?.();
      };
      recognizer.onerror = () => {
        button.classList.remove("is-recording");
        recognizer = null;
      };
      recognizer.start();
    });
    return button;
  }

  function viewState() {
    const open = filteredOpen();
    const decision = currentDecision();
    return {
      decisions: open,
      index: Math.max(
        0,
        open.findIndex((d) => d.id === decision?.id),
      ),
      focusIcon: state.focusIcon,
      scroll: state.scroll,
      copy,
      vorgangOf,
    };
  }

  function drawDisplay() {
    renderView(el.canvas, currentDecision() ? buildView(viewState()) : null);
  }

  function renderGestures(decision) {
    el.gestureRow.replaceChildren();
    if (!decision) return;
    const defs = [
      ["swipeBack", "←", copy.hint_swipeBack],
      ["press", "◉", copy.hint_press],
      ["doublePress", "◉◉", copy.hint_doublePress],
      ["swipe", "→", copy.hint_swipe],
    ];
    for (const [geste, symbol, hint] of defs) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "kpl-gesture";
      button.dataset.gesture = geste;
      button.title = hint || "";
      button.setAttribute("aria-label", hint || geste);
      button.textContent = symbol;
      el.gestureRow.append(button);
    }
  }

  function openProjectModal(projekt) {
    el.projectModal.hidden = false;
    const f = el.projectForm.elements;
    f.projekt_id.value = projekt?.id || "";
    f.name.value = projekt?.name || "";
    f.adressen.value = (projekt?.adressen_json || []).join(", ");
    f.domains.value = (projekt?.domains_json || []).join(", ");
    f.code_projekt.value = projekt?.code_projekt || "";
    f.notizen.value = projekt?.notizen || "";
    root.querySelector("[data-project-modal-title]").textContent = projekt
      ? copy.project_title_edit
      : copy.project_title;
    f.name.focus();
  }

  function wireProjectModal() {
    el.projectModal = root.querySelector("[data-project-modal]");
    el.projectForm = root.querySelector("[data-project-form]");
    el.projectForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const f = el.projectForm.elements;
      const liste = (wert) =>
        String(wert || "")
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
      const now = Date.now();
      const record = {
        id: f.projekt_id.value || `kpl-p-${now}-${Math.random().toString(36).slice(2, 6)}`,
        name: f.name.value.trim(),
        adressen_json: liste(f.adressen.value),
        domains_json: liste(f.domains.value),
        code_projekt: f.code_projekt.value.trim(),
        notizen: f.notizen.value,
        aktiv: true,
        is_deleted: false,
        created_at_ms: f.projekt_id.value
          ? state.projekte.find((p) => p.id === f.projekt_id.value)?.created_at_ms || now
          : now,
        updated_at_ms: now,
      };
      if (!record.name) return;
      writeProjekt(record)
        .then(() => {
          el.projectModal.hidden = true;
          el.projectForm.reset();
          return refresh();
        })
        .catch(reportError);
    });
  }

  function wireCreateModal() {
    el.modal = root.querySelector("[data-create-modal]");
    el.modalForm = root.querySelector("[data-create-form]");
    el.modalForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(el.modalForm);
      createVorgang({
        titel: String(data.get("titel") || "").trim(),
        absender: String(data.get("absender") || "").trim(),
        body: String(data.get("body") || ""),
      })
        .then(() => {
          el.modal.hidden = true;
          el.modalForm.reset();
        })
        .catch(reportError);
    });
  }

  async function createVorgang({ titel, absender, body }) {
    if (!titel) return;
    const now = Date.now();
    const clean = stripMailBody(body);
    const { treffer, vorschlag } = projektFuerAbsender(absender);
    const vorgang = {
      id: `kpl-v-${now}-${Math.random().toString(36).slice(2, 6)}`,
      title: kurz(titel, 120),
      status: treffer ? "zugeordnet" : "eingegangen",
      kunde_id: treffer?.id || "",
      kunde_name: treffer?.name || "",
      quelle_json: {
        kanal: "manuell",
        absender,
        betreff: titel,
        body_clean: clean,
        eingegangen_ms: now,
      },
      triage_json: null,
      run_json: null,
      mails_json: [],
      audit_json: [{ zeit_ms: now, aktion: "manuell-angelegt", akteur: "owner", kanal: "desktop" }],
      notes: "",
      is_deleted: false,
      created_at_ms: now,
      updated_at_ms: now,
    };
    await writeVorgang(vorgang);
    if (!treffer) {
      await writeDecision(
        makeDecision(
          {
            typ: "zuordnung",
            titel: kurz(absender || titel, 40),
            zeilen: [
              `▸ ${copy.section_mail}`,
              ...layoutText(clean || titel),
              ...(vorschlag
                ? ["", ...layoutText(`${copy.routing_suggestion} ${vorschlag.name}`)]
                : []),
            ],
          },
          vorgang,
        ),
      );
    } else if (vorgang.triage_json) {
      await writeDecision(makeDecision(triageDecision(vorgang), vorgang));
    }
    await refresh();
  }

  function buildCorrectionComposer() {
    const wrap = document.createElement("div");
    wrap.className = "kpl-correction";
    wrap.hidden = true;
    const textarea = document.createElement("textarea");
    textarea.className = "ctox-textarea";
    textarea.rows = 1;
    textarea.placeholder = copy.correction_placeholder;
    textarea.setAttribute("aria-label", copy.correction_placeholder);
    const send = document.createElement("button");
    send.type = "button";
    send.className = "ctox-pane-icon";
    send.setAttribute("aria-label", copy.correction_send);
    send.title = copy.correction_send;
    send.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 12 16-7-5 7 5 7z"/></svg>';
    send.addEventListener("click", () => {
      submitCorrection(textarea.value)
        .then(() => {
          textarea.value = "";
        })
        .catch(reportError);
    });
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        submitCorrection(textarea.value)
          .then(() => {
            textarea.value = "";
          })
          .catch(reportError);
      }
    });
    wrap.append(textarea, micButton(textarea), send);
    el.stage.insertBefore(wrap, el.contextPanel);
    el.correction = wrap;
  }

  function renderContext(vorgang) {
    el.vorgangFields.replaceChildren();
    el.auditList.replaceChildren();
    if (!vorgang) return;
    const fields = [
      [copy.field_status, copy[`status_${vorgang.status}`] || vorgang.status],
      [copy.field_customer, vorgang.kunde_name || "—"],
      [copy.field_channel, vorgang.quelle_json?.kanal || "—"],
      [copy.field_sender, vorgang.quelle_json?.absender || "—"],
    ];
    for (const [dt, dd] of fields) {
      const dtNode = document.createElement("dt");
      dtNode.textContent = dt;
      const ddNode = document.createElement("dd");
      ddNode.textContent = String(dd);
      el.vorgangFields.append(dtNode, ddNode);
    }
    for (const eintrag of [...(vorgang.audit_json || [])].toReversed()) {
      const li = document.createElement("li");
      const meta = document.createElement("span");
      meta.className = "kpl-audit-meta";
      meta.textContent = `${new Date(eintrag.zeit_ms).toLocaleString(locale)} · ${eintrag.kanal} — `;
      li.append(meta, document.createTextNode(eintrag.aktion));
      el.auditList.append(li);
    }
  }

  function renderPermissionState() {
    renderCounts();
    el.navList.replaceChildren();
    renderView(el.canvas, null);
    el.gestureRow.replaceChildren();
    el.displayTitle.textContent = copy.permission_title;
    el.correction.hidden = true;
    el.contextPanel.hidden = true;
    el.empty.hidden = false;
    el.empty.replaceChildren();
    const strong = document.createElement("strong");
    strong.textContent = copy.permission_title;
    const span = document.createElement("span");
    span.textContent = copy.permission_hint;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ctox-button is-primary";
    button.textContent = copy.permission_request;
    button.addEventListener("click", async () => {
      try {
        await ctx.contextActions?.dispatch?.("data", {
          target: root,
          prompt: copy.permission_prompt,
          title: copy.permission_request,
        });
        ctx.notifications?.show?.({
          type: "success",
          title: copy.permission_request,
          message: copy.permission_requested,
        });
      } catch (error) {
        reportError(error);
      }
    });
    el.empty.append(strong, span, button);
    if (el.footer) el.footer.textContent = copy.permission_title;
  }

  function reportError(error) {
    const message = error?.message || String(error);
    ctx.notifications?.show?.({ type: "error", title: copy.error_title, message });
  }

  // ---------- Demo ----------

  async function seedDemo() {
    const now = Date.now();
    const beispiele = [
      {
        titel: "Problem mit dem API Key",
        kunde: "REM Capital",
        absender: "j.cakmak@remcapital.de",
        body: "Hi Michael,\n\nDie Lösung funktioniert, jedoch scheint es ein Problem mit dem API Key zu geben. Mir wird folgender Fehler angezeigt:\nNetzwerk- oder CORS-Problem beim API-Aufruf.\n\nMit freundlichen Grüßen\nJill Cakmak",
        status: "zugeordnet",
        typ: "triage",
        triage: {
          einordnung: "arbeit",
          aufwand: "S",
          antwort_vorschlag:
            "Hallo Frau Cakmak, danke für die Meldung. Das ist ein CORS-Problem auf unserer Gateway-Seite, kein Fehler Ihres API-Keys. Wir spielen heute noch einen Fix ein und melden uns, sobald der Aufruf wieder durchläuft.",
          aufgabe: {
            agent: "Sol · Completion",
            beschreibung:
              "Im REM-Gateway die CORS-Allowlist um die Portal-Origin ergänzen, Preflight-Antwort prüfen, Regressionstest für den API-Aufruf ergänzen.",
          },
        },
      },
      {
        titel: "Frage zur Rechnung 2024-118",
        kunde: "",
        absender: "j.weber@schulz-partner.de",
        body: "Guten Tag,\n\nkönnen Sie mir sagen, ob in der Rechnung 2024-118 die Lizenzverlängerung bereits enthalten ist? Unser Einkauf benötigt eine Aufschlüsselung.\n\nViele Grüße\nJulia Weber",
        status: "eingegangen",
        typ: "zuordnung",
        zuordnungHinweis: "Domain passt zu: Schulz & Partner",
      },
      {
        titel: "Login geht nicht",
        kunde: "Bäckerei Hoffmann",
        absender: "info@baeckerei-hoffmann.de",
        body: "Hallo,\n\nseit heute Morgen können wir uns nicht mehr im Portal anmelden. Nach dem Login springt die Seite sofort zurück.\n\nBeste Grüße\nK. Hoffmann",
        status: "ergebnisVorliegend",
        typ: "ergebnisfreigabe",
        run: {
          zusammenfassung:
            "Session-Timeout korrigiert, 3 Regressionstests ergänzt, Fix auf Staging verifiziert und produktiv deployt.",
        },
      },
    ];
    let offset = 0;
    for (const b of beispiele) {
      const id = `kpl-demo-${now}-${offset}`;
      const vorgang = {
        id,
        title: b.titel,
        status: b.status,
        kunde_id: "",
        kunde_name: b.kunde,
        quelle_json: {
          kanal: "mail",
          absender: b.absender,
          betreff: b.titel,
          body_clean: stripMailBody(b.body),
          eingegangen_ms: now - offset * 3600000,
        },
        triage_json: b.triage || null,
        run_json: b.run || null,
        mails_json: [],
        audit_json: [
          {
            zeit_ms: now - offset * 3600000,
            aktion: "demo-seed",
            akteur: "system",
            kanal: "system",
          },
        ],
        notes: "",
        is_deleted: false,
        created_at_ms: now - offset * 3600000,
        updated_at_ms: now - offset * 3600000,
      };
      await writeVorgang(vorgang);
      let spec;
      if (b.typ === "triage") spec = triageDecision(vorgang);
      else if (b.typ === "ergebnisfreigabe") {
        spec = {
          typ: "ergebnisfreigabe",
          titel: kurz(b.kunde || b.titel, 40),
          zeilen: [
            `▸ ${copy.section_mail}`,
            ...layoutText(vorgang.quelle_json.body_clean),
            "",
            `▸ ${copy.result_mail.toUpperCase()}`,
            ...layoutText(b.run.zusammenfassung),
          ],
        };
      } else {
        spec = {
          typ: "zuordnung",
          titel: kurz(b.absender, 40),
          zeilen: [
            `▸ ${copy.section_mail}`,
            ...layoutText(vorgang.quelle_json.body_clean),
            "",
            ...(b.zuordnungHinweis ? layoutText(b.zuordnungHinweis) : []),
          ],
        };
      }
      await writeDecision(makeDecision(spec, vorgang));
      offset += 1;
    }
    await refresh();
  }
}

// ---------- Helfer ----------

// Mail-Ballast entfernen: Signaturen, Grußformeln, Footer, Zitat-Threads.
export function stripMailBody(text) {
  let body = String(text || "").replace(/\r\n/g, "\n");
  body = body.split(/\n-{2,}\s*Original\s?(nachricht|message)/i)[0];
  body = body.split(/\nAm .{10,80} schrieb .*:/)[0];
  const cut = body.search(
    /\n(Mit freundlichen Grüßen|Viele Grüße|Beste Grüße|Freundliche Grüße|Best regards|Kind regards|Liebe Grüße)/i,
  );
  if (cut > 0) body = body.slice(0, cut);
  body = body.replace(/^(Hi|Hallo|Guten Tag|Sehr geehrte[r]?|Dear)[^,\n]{0,60}[,!]?\s*\n+/i, "");
  return body.trim();
}

function kurz(text, max) {
  const value = String(text || "").trim();
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function getCollection(ctx, name) {
  try {
    return ctx.db.collection(name);
  } catch {
    return null;
  }
}

function mustCollection(collection, name) {
  if (!collection?.upsert) throw new Error(`Collection ${name} ist nicht verfügbar`);
  return collection;
}

function applyCopy(root, copy) {
  for (const node of root.querySelectorAll("[data-copy]")) {
    const value = copy[node.dataset.copy];
    if (value) node.textContent = value;
  }
}

// Standalone-Fallback (nur ohne Shell-Wiring aktiv): minimale pg-Verdrahtung,
// damit Preview/Tests außerhalb der Business-OS-Shell funktionieren.
function wireStandaloneGrammar(pane, emit) {
  const fire = () =>
    emit({
      detail: {
        search: pane.querySelector("[data-pg-search]")?.value || "",
        band: pane.querySelector('[data-pg-band][aria-selected="true"]')?.dataset.pgBand || "offen",
        view: pane.querySelector('[data-pg-view][aria-pressed="true"]')?.dataset.pgView || "cards",
        filters: { typ: pane.querySelector('[data-pg-name="typ"]')?.value || "all" },
      },
    });
  const clickHandler = (event) => {
    const band = event.target.closest("[data-pg-band]");
    if (band) {
      for (const tab of pane.querySelectorAll("[data-pg-band]")) {
        tab.setAttribute("aria-selected", String(tab === band));
        tab.classList.toggle("is-active", tab === band);
      }
      fire();
    }
    const tray = event.target.closest("[data-pg-tray-toggle]");
    if (tray) {
      const panel = pane.querySelector("[data-pg-tray]");
      panel.hidden = !panel.hidden;
      tray.setAttribute("aria-expanded", String(!panel.hidden));
    }
    if (event.target.closest("[data-pg-reset]")) {
      const search = pane.querySelector("[data-pg-search]");
      if (search) search.value = "";
      const typ = pane.querySelector('[data-pg-name="typ"]');
      if (typ) typ.value = "all";
      fire();
    }
  };
  const inputHandler = () => fire();
  pane.addEventListener("click", clickHandler);
  pane.querySelector("[data-pg-search]")?.addEventListener("input", inputHandler);
  pane.querySelector('[data-pg-name="typ"]')?.addEventListener("change", inputHandler);
  return () => {
    pane.removeEventListener("click", clickHandler);
    pane.querySelector("[data-pg-search]")?.removeEventListener("input", inputHandler);
    pane.querySelector('[data-pg-name="typ"]')?.removeEventListener("change", inputHandler);
  };
}

async function loadMarkup() {
  const response = await fetch(
    new URL("./index.html", import.meta.url) + (VERSION ? `?v=${VERSION}` : ""),
  );
  if (!response.ok) throw new Error(`HTTP ${response.status} für index.html`);
  return response.text();
}

async function loadJson(path) {
  const response = await fetch(new URL(path, import.meta.url));
  if (!response.ok) throw new Error(`HTTP ${response.status} für ${path}`);
  return response.json();
}

async function ensureStyles() {
  const key = `kpl-${MODULE_ID}`;
  if (document.querySelector(`link[data-kpl-style="${key}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL(withV("./index.css"), import.meta.url).href;
  link.dataset.kplStyle = key;
  document.head.append(link);
}
