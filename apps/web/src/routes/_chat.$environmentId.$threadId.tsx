import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Button } from "~/components/ui/button";
import { workjetUiLanguage } from "../workjetProjectControl";
import { useEffect } from "react";

import ChatView from "../components/ChatView";
import { threadHasStarted } from "../components/ChatView.logic";
import { finalizePromotedDraftThreadByRef, useComposerDraftStore } from "../composerDraftStore";
import { resolveThreadRouteRef, resolveThreadRouteRenderState } from "../threadRoutes";
import { resolveThreadSyncPhase } from "../threadSync";
import { SidebarInset } from "~/components/ui/sidebar";
import {
  useEnvironmentThreadRefs,
  useThreadDetail,
  useThreadShell,
  useThreadStatus,
} from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { environmentShell } from "../state/shell";
import {
  businessOsCodeScopeContainsEnvironment,
  useBusinessOsCodeScope,
} from "../businessOsCodeScope";

function ChatThreadRouteView() {
  const navigate = useNavigate();
  const threadRef = Route.useParams({
    select: (params) => resolveThreadRouteRef(params),
  });
  const businessOsCodeScope = useBusinessOsCodeScope();
  const authorizedThreadRef =
    threadRef !== null &&
    businessOsCodeScopeContainsEnvironment(businessOsCodeScope, threadRef.environmentId)
      ? threadRef
      : null;
  const shell = useEnvironmentQuery(
    authorizedThreadRef === null
      ? null
      : environmentShell.stateAtom(authorizedThreadRef.environmentId),
  );
  const serverThreadShell = useThreadShell(authorizedThreadRef);
  const serverThreadDetail = useThreadDetail(authorizedThreadRef);
  const serverThreadStatus = useThreadStatus(authorizedThreadRef);
  const environmentThreadRefs = useEnvironmentThreadRefs(
    authorizedThreadRef?.environmentId ?? null,
  );
  const bootstrapComplete = shell.data?.snapshot._tag === "Some";
  const environmentHasServerThreads = environmentThreadRefs.length > 0;
  const draftThreadExists = useComposerDraftStore((store) =>
    authorizedThreadRef ? store.getDraftThreadByRef(authorizedThreadRef) !== null : false,
  );
  const draftThread = useComposerDraftStore((store) =>
    authorizedThreadRef ? store.getDraftThreadByRef(authorizedThreadRef) : null,
  );
  const environmentHasDraftThreads = useComposerDraftStore((store) => {
    if (!authorizedThreadRef) {
      return false;
    }
    return store.hasDraftThreadsInEnvironment(authorizedThreadRef.environmentId);
  });
  const renderState = resolveThreadRouteRenderState({
    bootstrapComplete,
    serverThreadShellExists: serverThreadShell !== null,
    serverThreadDetailExists: serverThreadDetail !== null,
    serverThreadDetailDeleted: serverThreadStatus === "deleted",
    draftThreadExists,
  });
  const threadSyncPhase = resolveThreadSyncPhase({
    detailExists: serverThreadDetail !== null,
    shellExists: serverThreadShell !== null,
    status: serverThreadStatus,
  });
  const serverThreadStarted = threadHasStarted(serverThreadDetail);
  const environmentHasAnyThreads = environmentHasServerThreads || environmentHasDraftThreads;

  useEffect(() => {
    if (!authorizedThreadRef || !bootstrapComplete) {
      return;
    }

    if (renderState === "missing" && environmentHasAnyThreads) {
      void navigate({ to: "/", replace: true });
    }
  }, [authorizedThreadRef, bootstrapComplete, environmentHasAnyThreads, navigate, renderState]);

  // Ein Chat auf einem Rechner, der für die aktive Instanz nicht freigegeben ist, sprang
  // früher stumm zur Übersicht zurück (#798: „Supervisor lässt sich nicht öffnen“). Jetzt
  // bleibt die Route stehen und sagt, warum der Chat nicht offen ist und was zu tun ist.
  const computerNotAssigned =
    threadRef !== null && authorizedThreadRef === null && businessOsCodeScope.phase === "ready";
  useEffect(() => {
    if (
      threadRef !== null &&
      authorizedThreadRef === null &&
      businessOsCodeScope.phase === "blocked" &&
      businessOsCodeScope.blocker === "no-active-instance"
    ) {
      void navigate({ to: "/", replace: true });
    }
  }, [authorizedThreadRef, businessOsCodeScope, navigate, threadRef]);

  useEffect(() => {
    if (!authorizedThreadRef || !serverThreadStarted || !draftThread) {
      return;
    }
    finalizePromotedDraftThreadByRef(authorizedThreadRef);
  }, [authorizedThreadRef, draftThread, serverThreadStarted]);

  if (!authorizedThreadRef) {
    if (computerNotAssigned || businessOsCodeScope.phase === "blocked") {
      return <ThreadComputerNotAssigned blocked={businessOsCodeScope.phase === "blocked"} />;
    }
    return null;
  }

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      {renderState === "ready" || (renderState === "loading" && serverThreadShell !== null) ? (
        <ChatView
          environmentId={authorizedThreadRef.environmentId}
          threadId={authorizedThreadRef.threadId}
          routeKind="server"
          threadSyncPhase={threadSyncPhase}
        />
      ) : null}
    </SidebarInset>
  );
}

function ThreadComputerNotAssigned({ blocked }: { readonly blocked: boolean }) {
  const en = workjetUiLanguage() === "en";
  const title = blocked
    ? en
      ? "Instance not reachable"
      : "Instanz nicht erreichbar"
    : en
      ? "This chat runs on a computer not assigned to this instance"
      : "Dieser Chat läuft auf einem Rechner, der dieser Instanz nicht zugeordnet ist";
  const description = blocked
    ? en
      ? "Workjet could not confirm the instance. Check the connection in Settings › Instance."
      : "Workjet konnte die Instanz nicht bestätigen. Verbindung unter Einstellungen › Instanz prüfen."
    : en
      ? "Assign this computer to the instance or choose another computer, then open the chat again."
      : "Ordne diesen Rechner der Instanz zu oder wähle einen anderen Rechner und öffne den Chat dann erneut.";
  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden bg-background text-foreground md:h-dvh">
      <div
        className="mx-auto flex max-w-md flex-1 flex-col items-start justify-center gap-3 p-8"
        data-workjet-thread-blocked={blocked ? "instance" : "computer"}
      >
        <h1 className="text-base font-semibold">{title}</h1>
        <p className="text-sm text-muted-foreground">{description}</p>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            render={<Link to={blocked ? "/settings/business-os" : "/settings/computers"} />}
          >
            {blocked
              ? en
                ? "Open instance settings"
                : "Instanz-Einstellungen öffnen"
              : en
                ? "Choose computer"
                : "Rechner wählen"}
          </Button>
          <Button size="sm" variant="outline" render={<Link to="/" />}>
            {en ? "Back to overview" : "Zur Übersicht"}
          </Button>
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  component: ChatThreadRouteView,
});
