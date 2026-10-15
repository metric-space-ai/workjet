import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ProjectOverviewView } from "../components/ProjectOverviewView";
import { ProjectOverviewQuestion } from "../components/ProjectOverviewDecisions";
import { ProjectExitModelCardPanel, ProjectExitModelReport } from "../components/ProjectExitModel";
import { ApprovalRequestId, type CtoxWorkjetProjectControlRequest } from "@workjet/contracts";
import { commitActiveWorkjetSelection } from "../activeWorkjetScope";
import { buildProjectOwnerOverview } from "../projectOverviewModel";
import {
  exitAssessmentFixture,
  overviewFixture,
  type ExitFixtureState,
} from "./project-overview.fixture-data";
import { useGithubMergedPullRequests } from "../hooks/useGithubMergedPullRequests";
import "../index.css";

type ExitCardShot = "proposal" | "hang" | "value" | "resources" | "researching";

function exitCardShot(value: string | null): ExitCardShot | null {
  return value === "proposal" ||
    value === "hang" ||
    value === "value" ||
    value === "resources" ||
    value === "researching"
    ? value
    : null;
}

function installExitCardBridge(shot: ExitCardShot) {
  const assessment = exitAssessmentFixture(shot === "hang" ? "proposal" : shot);
  commitActiveWorkjetSelection("fixture-instance");
  (window as unknown as { desktopBridge: unknown }).desktopBridge = {
    ctox: {
      requestProjectControl: (_instanceId: string, request: CtoxWorkjetProjectControlRequest) => {
        if (request.action === "project.exit_model.submit" && shot === "hang")
          return new Promise(() => undefined);
        if (
          request.action === "project.exit_model.read" ||
          request.action === "project.exit_model.refresh" ||
          request.action === "project.exit_model.submit"
        ) {
          return Promise.resolve({
            _tag: "completed" as const,
            response: {
              action: request.action,
              commandId: request.commandId,
              projectId: request.projectId,
              assessment,
            },
          });
        }
        return Promise.resolve({ _tag: "failed" as const, code: "unsupported" as const });
      },
    },
  };
}

function ExitCardShotView({ shot }: { readonly shot: ExitCardShot }) {
  const state: ExitFixtureState = shot === "hang" ? "proposal" : shot;
  useEffect(() => {
    if (shot !== "hang") return;
    const timer = window.setInterval(() => {
      const button = document.querySelector<HTMLButtonElement>(
        "[data-workjet-action^='project.exit_model.confirm:']",
      );
      if (button === null || button.disabled) return;
      button.click();
      window.clearInterval(timer);
    }, 40);
    return () => window.clearInterval(timer);
  }, [shot]);
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-8 text-foreground">
      <div className="w-[720px] rounded-lg border border-border bg-popover text-foreground">
        <ProjectExitModelCardPanel
          projectId="overview-fixture"
          instanceId="fixture-instance"
          assessment={exitAssessmentFixture(state)}
        />
      </div>
    </div>
  );
}

function OverviewFixture() {
  const query = new URLSearchParams(window.location.search);
  const shot = exitCardShot(query.get("shot"));
  if (shot !== null) return <ExitCardShotView shot={shot} />;
  const variant =
    query.get("variant") === "full"
      ? "full"
      : query.get("variant") === "empty"
        ? "empty"
        : "molecularity";
  const language = query.get("language") === "en" ? "en" : "de";
  const exitParam = query.get("exit");
  const exitState: ExitFixtureState | null =
    exitParam === "empty" || exitParam === "missing" || exitParam === "provisional"
      ? exitParam
      : null;
  const live = query.get("repo");
  if (query.get("theme") === "dark") document.documentElement.classList.add("dark");
  const baseInput = overviewFixture(variant);
  const input = live
    ? {
        ...overviewFixture("empty"),
        project: {
          ...baseInput.project,
          title: live.split("/")[1] ?? live,
          configuration: {
            ...baseInput.project.configuration!,
            title: live,
            repoUrl: `https://github.com/${live}`,
          },
        },
        now: Date.now(),
      }
    : baseInput;
  const livePrs = useGithubMergedPullRequests(live ? `https://github.com/${live}` : null);
  const [action, setAction] = useState("");
  const data = buildProjectOwnerOverview({
    ...input,
    language,
    ...(live ? { pullRequests: livePrs } : {}),
  });
  const text = data.text;
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="flex h-14 items-center gap-3 border-b border-border px-4 text-sm sm:px-6">
        <span className="font-semibold">Workjet</span>
        <span className="text-muted-foreground">/</span>
        {data.title}
        <span className="text-muted-foreground">/ {text.overview}</span>
      </div>
      <ProjectOverviewView
        data={data}
        actions={
          <button
            type="button"
            className="rounded-full border border-border px-2.5 py-1 text-xs hover:bg-muted"
            onClick={() => setAction("add-parent")}
          >
            + {text.addParent}
          </button>
        }
        onOpenChat={(ref) => setAction("chat:" + ref.threadId)}
        onOpenJourFixe={() => setAction("meeting")}
        connectionError={query.get("disconnected") === "1"}
        decisions={
          variant === "full" ? (
            <ProjectOverviewQuestion
              language={language}
              onAnswer={async () => {
                setAction("answer");
                return true;
              }}
              pending={{
                requestId: ApprovalRequestId.make("fixture-question"),
                createdAt: "2026-10-11T16:55:00Z",
                questions: [
                  {
                    id: "scope",
                    header: "Review",
                    question:
                      language === "de"
                        ? "Referenzlöser zuerst ausliefern?"
                        : "Ship the reference solver first?",
                    options: [
                      { label: language === "de" ? "Ausliefern" : "Ship", description: "" },
                      { label: language === "de" ? "Zurückstellen" : "Defer", description: "" },
                    ],
                    multiSelect: false,
                  },
                ],
              }}
            />
          ) : undefined
        }
      />
      {exitState !== null && (
        <div className="px-4 pb-10 sm:px-6">
          <ProjectExitModelReport
            projectId="overview-fixture"
            assessment={exitAssessmentFixture(exitState)}
            onRefresh={async () => true}
            onCheck={async () => true}
          />
        </div>
      )}
      <output hidden data-fixture-action={action} />
    </div>
  );
}
const openingShot = exitCardShot(new URLSearchParams(window.location.search).get("shot"));
if (openingShot !== null) installExitCardBridge(openingShot);
createRoot(document.getElementById("root")!).render(<OverviewFixture />);
