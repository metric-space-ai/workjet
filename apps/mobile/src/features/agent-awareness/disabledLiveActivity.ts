export type AgentActivityPhase =
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "stale";

export interface AgentActivityRowProps {
  readonly environmentId: string;
  readonly threadId: string;
  readonly projectTitle: string;
  readonly threadTitle: string;
  readonly modelTitle: string;
  readonly phase: AgentActivityPhase;
  readonly status: string;
  readonly updatedAt: string;
  readonly deepLink: string;
}

export interface AgentActivityProps {
  readonly title: string;
  readonly subtitle: string;
  readonly activeCount: number;
  readonly updatedAt: string;
  readonly activities: ReadonlyArray<AgentActivityRowProps>;
}

export interface LiveActivity<Props> {
  readonly addPushTokenListener: (
    listener: (event: { readonly pushToken?: string }) => void,
  ) => void;
  readonly end: (dismissalPolicy: "immediate") => Promise<void>;
  readonly getPushToken: () => Promise<string | null>;
  readonly __props?: Props;
}

const removedWidgetTarget = {
  getInstances(): ReadonlyArray<LiveActivity<AgentActivityProps>> {
    return [];
  },
  start(_props: AgentActivityProps): LiveActivity<AgentActivityProps> {
    throw new Error("The Workjet iOS widget target is not part of this signed binary.");
  },
};

export default removedWidgetTarget;
