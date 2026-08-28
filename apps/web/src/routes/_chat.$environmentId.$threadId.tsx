import { createFileRoute, useNavigate } from "@tanstack/react-router";
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

  useEffect(() => {
    if (
      threadRef !== null &&
      authorizedThreadRef === null &&
      businessOsCodeScope.phase !== "resolving"
    ) {
      void navigate({ to: "/", replace: true });
    }
  }, [authorizedThreadRef, businessOsCodeScope.phase, navigate, threadRef]);

  useEffect(() => {
    if (!authorizedThreadRef || !serverThreadStarted || !draftThread) {
      return;
    }
    finalizePromotedDraftThreadByRef(authorizedThreadRef);
  }, [authorizedThreadRef, draftThread, serverThreadStarted]);

  if (!authorizedThreadRef) {
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

export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  component: ChatThreadRouteView,
});
