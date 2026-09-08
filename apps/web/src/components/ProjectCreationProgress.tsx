import { CheckIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Spinner } from "./ui/spinner";

const stages = [
  { id: "connecting", label: "Connect to the selected Business OS" },
  { id: "local", label: "Register the folder" },
  { id: "syncing", label: "Confirm the project in Business OS" },
] as const;

export function ProjectCreationProgress({
  stage,
}: {
  readonly stage: (typeof stages)[number]["id"];
}) {
  const [takingLonger, setTakingLonger] = useState(false);
  useEffect(() => {
    setTakingLonger(false);
    const timer = window.setTimeout(() => setTakingLonger(true), 10000);
    return () => window.clearTimeout(timer);
  }, [stage]);
  const current = stages.findIndex((entry) => entry.id === stage);
  return (
    <div className="space-y-3" aria-busy="true">
      <p className="font-medium text-foreground">Adding your project</p>
      <ol className="space-y-2">
        {stages.map((entry, index) => (
          <li
            key={entry.id}
            className="flex items-center gap-2"
            aria-current={index === current ? "step" : undefined}
          >
            {index < current ? (
              <CheckIcon className="size-4 text-emerald-500" aria-label="Completed" />
            ) : index === current ? (
              <Spinner className="size-4" />
            ) : (
              <span className="size-4 rounded-full border border-border" aria-hidden />
            )}
            <span className={index === current ? "text-foreground" : undefined}>{entry.label}</span>
          </li>
        ))}
      </ol>
      {takingLonger ? (
        <p className="text-xs">
          Still waiting for a response. Workjet will show the project here once it is confirmed, or
          report a connection error.
        </p>
      ) : null}
    </div>
  );
}
