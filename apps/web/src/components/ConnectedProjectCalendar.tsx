import { useActiveWorkjetScope } from "../activeWorkjetScope";
import { useSessionCalendar } from "../calendar/useSessionCalendar";
import { ProjectCalendar } from "./ProjectCalendar";
import type { ComponentProps } from "react";

export function ConnectedProjectCalendar(props: Pick<ComponentProps<typeof ProjectCalendar>, "projects">) {
  const { selectedInstanceId } = useActiveWorkjetScope();
  const { snapshot, refresh } = useSessionCalendar(selectedInstanceId);
  return <ProjectCalendar key={selectedInstanceId ?? "no-instance"} {...props}
    sessions={snapshot.sessions}
    sessionsStatus={selectedInstanceId === null ? "unavailable" : snapshot.status}
    onRefreshSessions={refresh} />;
}
