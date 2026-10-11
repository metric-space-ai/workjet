import { useEffect, useState } from "react";
import { supervisorTickDueAt, type SupervisorTickConfiguration, type SupervisorTickState } from "@workjet/contracts";

export function SupervisorTickStatus(props: {
  readonly createdAt: string | null;
  readonly configuration?: SupervisorTickConfiguration | undefined;
  readonly state?: SupervisorTickState | undefined;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, []);
  const next = props.createdAt ? supervisorTickDueAt(props.createdAt, props.configuration, props.state) : null;
  return (
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" data-workjet-supervisor-tick="">
      <span>Letzte Kontrolle: {props.state?.lastControlAt ? `vor ${Math.max(0, Math.floor((now - Date.parse(props.state.lastControlAt)) / 60000))} min` : "noch keine"}</span>
      <span>Nächste: {props.configuration?.enabled === false ? "aus" : next === null ? "Supervisor fehlt" : next <= now ? "fällig" : `in ${Math.ceil((next - now) / 60000)} min`}</span>
      {props.state?.outcome === "skipped-busy" && <span>Letzter Takt übersprungen · Supervisor beschäftigt</span>}
    </div>
  );
}
