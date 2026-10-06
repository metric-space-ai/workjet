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
    ? "This project belongs to another instance. Select its instance to open it."
    : target.status === "conflict"
      ? "The project supervisor could not be identified safely. The project has been kept."
      : target.status === "unavailable"
        ? "The project supervisor is unavailable. The project has been kept."
        : waitExpired
          ? "The project has been created. Its supervisor is still synchronizing."
          : "Waiting for the saved project supervisor.";

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 24, gap: 16 }}
      className="flex-1 bg-screen"
    >
      <Text className="text-xl font-workjet-bold">Project supervisor</Text>
      {waiting ? <ActivityIndicator accessibilityLabel="Opening project supervisor" /> : null}
      <Text className="text-base text-foreground-muted" accessibilityLiveRegion="polite">
        {detail}
      </Text>
      <Pressable onPress={() => navigation.dispatch(StackActions.replace("Home"))} className="py-3">
        <Text className="text-base font-workjet-bold">Back to projects</Text>
      </Pressable>
    </ScrollView>
  );
}
