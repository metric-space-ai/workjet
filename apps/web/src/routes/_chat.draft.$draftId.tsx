import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import ChatView from "../components/ChatView";
import { threadHasStarted } from "../components/ChatView.logic";
import {
  DraftId,
  markPromotedDraftThreadByRef,
  useComposerDraftStore,
} from "../composerDraftStore";
import { SidebarInset } from "../components/ui/sidebar";
import { waitForDraftHeroTransition } from "../components/chat/draftHeroTransition";
import { buildThreadRouteParams } from "../threadRoutes";
import { useThread, useThreadRefs } from "../state/entities";
import { useBusinessOsCodeScope } from "../businessOsCodeScope";
import { usePrimarySettings } from "../hooks/useSettings";
import { useWorkjetProjectRegistry } from "../workjetProjectRegistry";
import {
  resolveDraftActiveInstanceStatus,
  shouldRedirectDraftToIndex,
} from "./-_chat.draft.$draftId.logic";

function DraftChatThreadRouteView() {
  const navigate = useNavigate();
  const { draftId: rawDraftId } = Route.useParams();
  const draftId = DraftId.make(rawDraftId);
  const draftSession = useComposerDraftStore((store) => store.getDraftSession(draftId));
  const businessOsCodeScope = useBusinessOsCodeScope();
  const workjetProjectRegistry = useWorkjetProjectRegistry(
    businessOsCodeScope.presentationInstanceId,
  );
  const workjetComputers = usePrimarySettings((settings) => settings.workjet.computers);
  const draftActiveInstanceStatus = resolveDraftActiveInstanceStatus({
    draftSession,
    businessOsCodeScope,
    workjetProjectRegistry,
    computers: workjetComputers,
  });
  const draftInActiveInstance = draftSession !== null && draftActiveInstanceStatus === "active";
  const threadRefs = useThreadRefs();
  const inferredThreadRef = draftInActiveInstance
    ? (threadRefs.find(
        (ref) =>
          ref.environmentId === draftSession.environmentId &&
          ref.threadId === draftSession.threadId,
      ) ?? null)
    : null;
  const serverThreadRef = draftSession?.promotedTo ?? inferredThreadRef;
  const serverThread = useThread(serverThreadRef);
  const serverThreadStarted = threadHasStarted(serverThread);
  const canonicalThreadRef = serverThreadStarted ? serverThreadRef : null;

  useEffect(() => {
    if (!inferredThreadRef || draftSession?.promotedTo) {
      return;
    }
    markPromotedDraftThreadByRef(inferredThreadRef);
  }, [draftSession?.promotedTo, inferredThreadRef]);

  useEffect(() => {
    if (!canonicalThreadRef) {
      return;
    }

    let cancelled = false;
    void waitForDraftHeroTransition().then(() => {
      if (cancelled) {
        return;
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(canonicalThreadRef),
        replace: true,
      });
    });

    return () => {
      cancelled = true;
    };
  }, [canonicalThreadRef, navigate]);

  useEffect(() => {
    if (
      !shouldRedirectDraftToIndex({
        draftSessionPresent: draftSession !== null,
        activeInstanceStatus: draftActiveInstanceStatus,
        canonicalThreadPresent: canonicalThreadRef !== null,
      })
    ) {
      return;
    }
    void navigate({ to: "/", replace: true });
  }, [canonicalThreadRef, draftActiveInstanceStatus, draftSession, navigate]);

  if (!draftSession || !draftInActiveInstance) {
    return null;
  }

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      <ChatView
        draftId={draftId}
        environmentId={draftSession.environmentId}
        threadId={draftSession.threadId}
        routeKind="draft"
        forceExpandedMobileComposer
      />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/draft/$draftId")({
  component: DraftChatThreadRouteView,
});
