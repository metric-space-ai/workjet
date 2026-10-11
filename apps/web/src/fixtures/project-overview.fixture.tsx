import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ProjectOverviewView } from "../components/ProjectOverviewView";
import { ProjectOverviewQuestion } from "../components/ProjectOverviewDecisions";
import { ApprovalRequestId } from "@workjet/contracts";
import { buildProjectOwnerOverview } from "../projectOverviewModel";
import { overviewFixture } from "./project-overview.fixture-data";
import "../index.css";

function OverviewFixture() {
  const query = new URLSearchParams(window.location.search);
  const variant =
    query.get("variant") === "full"
      ? "full"
      : query.get("variant") === "empty"
        ? "empty"
        : "molecularity";
  const language = query.get("language") === "en" ? "en" : "de";
  const input = overviewFixture(variant);
  const [action, setAction] = useState("");
  const data = buildProjectOwnerOverview({ ...input, language });
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
      <output hidden data-fixture-action={action} />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<OverviewFixture />);
