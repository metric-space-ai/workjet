import type { EnvironmentId, ThreadId } from "@workjet/contracts";
import {
  EnvironmentId as EnvironmentIdSchema,
  ThreadId as ThreadIdSchema,
} from "@workjet/contracts";
import type { StaticScreenProps } from "@react-navigation/native";
import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";

const HISTORY_PAGE_TURNS = 50;

function ArchivedWorkerHistoryPage(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly beforeCursor?: string;
}) {
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const detail = useEnvironmentQuery(
    orchestrationEnvironment.archivedTeamWorkerDetail({
      environmentId: props.environmentId,
      input: {
        threadId: props.threadId,
        turnLimit: HISTORY_PAGE_TURNS,
        ...(props.beforeCursor !== undefined ? { beforeCursor: props.beforeCursor } : {}),
      },
    }),
  );

  if (detail.error !== null) {
    return (
      <View className="gap-3 rounded-2xl bg-danger p-4">
        <Text className="text-sm text-danger-foreground">Could not load worker history.</Text>
        <Pressable accessibilityRole="button" onPress={detail.refresh}>
          <Text className="font-workjet-bold text-danger-foreground">Try again</Text>
        </Pressable>
      </View>
    );
  }
  if (detail.data === null) {
    return <ActivityIndicator />;
  }

  const { thread, page } = detail.data;
  const entries = [
    ...thread.messages.map((message) => ({
      key: `message:${message.id}`,
      createdAt: message.createdAt,
      label: message.role === "assistant" ? "Worker" : message.role,
      text: message.text,
      attachments: message.attachments?.map((attachment) => attachment.name) ?? [],
    })),
    ...thread.activities.map((activity) => ({
      key: `activity:${activity.id}`,
      createdAt: activity.createdAt,
      label: "Activity",
      text: activity.summary,
      attachments: [],
    })),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key));

  return (
    <View className="gap-3">
      {props.beforeCursor === undefined ? (
        <Text className="text-xl font-workjet-bold text-foreground">{thread.title}</Text>
      ) : null}
      {olderCursor !== null ? (
        <ArchivedWorkerHistoryPage
          environmentId={props.environmentId}
          threadId={props.threadId}
          beforeCursor={olderCursor}
        />
      ) : page?.hasMore && page.beforeCursor !== null ? (
        <Pressable
          accessibilityLabel="Load earlier worker history"
          accessibilityRole="button"
          className="self-center rounded-full bg-subtle px-4 py-2 active:opacity-60"
          onPress={() => setOlderCursor(page.beforeCursor)}
        >
          <Text className="text-sm font-workjet-bold">Load earlier history</Text>
        </Pressable>
      ) : null}
      {entries.map((entry) => (
        <View key={entry.key} className="gap-1 rounded-2xl bg-card p-4">
          <Text className="text-xs font-workjet-bold uppercase text-foreground-muted">
            {entry.label}
          </Text>
          <Text className="text-sm leading-6 text-foreground" selectable>
            {entry.text}
          </Text>
          {entry.attachments.map((name) => (
            <Text key={name} className="text-xs text-foreground-muted">
              Image: {name}
            </Text>
          ))}
        </View>
      ))}
      {entries.length === 0 && olderCursor === null ? (
        <Text className="text-center text-sm text-foreground-muted">No retained messages.</Text>
      ) : null}
    </View>
  );
}

export function ArchivedWorkerDetailRouteScreen(
  props: StaticScreenProps<{ readonly environmentId: string; readonly threadId: string }>,
) {
  const environmentId = EnvironmentIdSchema.make(props.route.params.environmentId);
  const threadId = ThreadIdSchema.make(props.route.params.threadId);
  return (
    <ScrollView
      className="flex-1 bg-screen"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 20 }}
    >
      <View className="gap-4">
        <Text className="text-xs font-workjet-bold uppercase text-foreground-muted">
          Completed worker · Read only
        </Text>
        <ArchivedWorkerHistoryPage environmentId={environmentId} threadId={threadId} />
      </View>
    </ScrollView>
  );
}
