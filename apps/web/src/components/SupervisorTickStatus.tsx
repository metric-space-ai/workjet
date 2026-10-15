import { useEffect, useState } from "react";
import {
  supervisorTickDueAt,
  type SupervisorTickConfiguration,
  type SupervisorTickState,
} from "@workjet/contracts";
import {
  projectOverviewFormat,
  type ProjectOverviewLanguage,
  type ProjectOverviewText,
} from "../projectOverviewText";
import { WORKJET_STATUS_TEXT_CLASS } from "../workjetStatus";

export function SupervisorTickStatus(props: {
  readonly createdAt: string | null;
  readonly configuration?: SupervisorTickConfiguration | undefined;
  readonly state?: SupervisorTickState | undefined;
  readonly language?: ProjectOverviewLanguage | undefined;
  readonly text?: ProjectOverviewText | undefined;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, []);
  const de = props.language !== "en";
  const text = props.text;
  const minutesAgo = (at: string) =>
    text
      ? projectOverviewFormat(text.minutesAgo, {
          minutes: Math.max(0, Math.floor((now - Date.parse(at)) / 60000)),
        })
      : de
        ? `vor ${Math.max(0, Math.floor((now - Date.parse(at)) / 60000))} min`
        : `${Math.max(0, Math.floor((now - Date.parse(at)) / 60000))} min ago`;
  const next = props.createdAt
    ? supervisorTickDueAt(props.createdAt, props.configuration, props.state)
    : null;
  const nextLabel =
    props.configuration?.enabled === false
      ? (text?.controlOff ?? (de ? "aus" : "off"))
      : next === null
        ? (text?.controlMissing ?? (de ? "Supervisor fehlt" : "no supervisor"))
        : next <= now
          ? (text?.controlDue ?? (de ? "fällig" : "due"))
          : text
            ? projectOverviewFormat(text.minutesUntil, {
                minutes: Math.ceil((next - now) / 60000),
              })
            : de
              ? `in ${Math.ceil((next - now) / 60000)} min`
              : `in ${Math.ceil((next - now) / 60000)} min`;
  const lastLabel = props.state?.lastControlAt
    ? minutesAgo(props.state.lastControlAt)
    : "";
  return (
    <div
      className="mt-2 flex flex-wrap items-center gap-1.5"
      data-workjet-supervisor-tick=""
      role="status"
    >
      <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
        {lastLabel
          ? (text
              ? projectOverviewFormat(text.controlLast, { time: lastLabel })
              : de
                ? `Letzte Kontrolle ${lastLabel}`
                : `Last check ${lastLabel}`) + " · "
          : null}
        {text
          ? projectOverviewFormat(text.controlNext, { time: nextLabel })
          : de
            ? `Nächste ${nextLabel}`
            : `Next ${nextLabel}`}
      </span>
      {props.state?.outcome === "skipped-busy" && (
        <span
          className={`inline-flex items-center gap-1.5 text-[12px] ${WORKJET_STATUS_TEXT_CLASS.waiting}`}
        >
          <span aria-hidden="true" className="size-2 rounded-full bg-warning" />
          {text?.controlSkipped ??
            (de ? "Takt übersprungen · Supervisor beschäftigt" : "Tick skipped · supervisor busy")}
        </span>
      )}
    </div>
  );
}
