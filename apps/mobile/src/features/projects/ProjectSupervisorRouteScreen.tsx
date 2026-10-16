import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView } from "react-native";
import { EnvironmentId, ProjectId } from "@workjet/contracts";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { AppText as Text } from "../../components/AppText";
import { useProjects, useThreadShells } from "../../state/entities";
import { useBusinessOs } from "../business-os/BusinessOsProvider";
import { resolveProjectSupervisorTarget } from "./AddProjectScreen.logic";

type ProjectSupervisorRouteParams = {
  readonly environmentId: string;
  readonly projectId: string;
};

export function ProjectSupervisorRouteScreen({
  route,
}: StaticScreenProps<ProjectSupervisorRouteParams>) {
  const navigation = useNavigation();
  const projects = useProjects();
  const threads = useThreadShells();
  const { hasEnvironmentBindings, selectedEnvironmentIds } = useBusinessOs();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const projectId = ProjectId.make(route.params.projectId);
  const [waitExpired, setWaitExpired] = useState(false);
  const instanceMatches = !hasEnvironmentBindings || selectedEnvironmentIds.includes(environmentId);
  const target = instanceMatches
    ? resolveProjectSupervisorTarget({ environmentId, projectId, projects, threads })
    : { status: "unavailable" as const };
  const threadId = target.status === "ready" ? target.thread.threadId : null;

  useEffect(() => {
    if (threadId !== null) {
      navigation.dispatch(StackActions.replace("Thread", { environmentId, threadId }));
    }
  }, [environmentId, navigation, threadId]);

  useEffect(() => {
    setWaitExpired(false);
    if (target.status !== "pending") return;
    const timer = setTimeout(() => setWaitExpired(true), 15_000);
    return () => clearTimeout(timer);
  }, [environmentId, projectId, target.status]);

  const waiting = target.status === "pending" && !waitExpired;
  const detail = !instanceMatches
    ? "Projekt gehört zu anderer Instanz."
    : target.status === "conflict"
      ? "Supervisor nicht eindeutig. Projekt bleibt erhalten."
      : target.status === "unavailable"
        ? "Supervisor nicht verfügbar. Projekt bleibt erhalten."
        : waitExpired
          ? "Projekt erstellt. Supervisor synchronisiert noch."
          : "Wartet auf Supervisor.";

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 24, gap: 16 }}
      className="flex-1 bg-screen"
    >
      <Text className="text-xl font-workjet-bold">Supervisor</Text>
      {waiting ? <ActivityIndicator accessibilityLabel="Öffnet Supervisor" /> : null}
      <Text className="text-base text-foreground-muted" accessibilityLiveRegion="polite">
        {detail}
      </Text>
      <Pressable onPress={() => navigation.dispatch(StackActions.replace("Home"))} className="py-3">
        <Text className="text-base font-workjet-bold">Zurück zu Projekten</Text>
      </Pressable>
    </ScrollView>
  );
}
