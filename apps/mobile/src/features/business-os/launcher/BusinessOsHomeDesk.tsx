import * as Haptics from "expo-haptics";
import { useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, useWindowDimensions, View } from "react-native";

import { BrandMark } from "../../../components/BrandMark";
import { ControlPill } from "../../../components/ControlPill";
import { SymbolView } from "../../../components/AppSymbol";
import { AppText as Text } from "../../../components/AppText";
import { useThemeColor } from "../../../lib/useThemeColor";
import type { BusinessOsInstance } from "../registry/business-os-registry";
import type { BusinessOsMobileAppDescriptor } from "./business-os-app-catalog";
import {
  businessOsHomeGrid,
  moveBusinessOsHomeItem,
  type BusinessOsHomeItem,
  type BusinessOsHomeLayout,
} from "./business-os-home-layout";
import { BusinessOsAppIcon } from "./BusinessOsAppIcon";
import { BusinessOsPlatformDock, BusinessOsPlatformHeader } from "./BusinessOsPlatformChrome";
import { resolveNativeBusinessOsLauncher } from "./native-business-os-launcher";

const NativeBusinessOsLauncher = resolveNativeBusinessOsLauncher();

function nativeCatalogJson(apps: readonly BusinessOsMobileAppDescriptor[]): string {
  return JSON.stringify({
    apps: apps.map(
      ({
        id,
        title,
        category,
        iconAssetId,
        iconFamilyVersion,
        iconRequired,
        accent,
        mobilePresentation,
        phoneReady,
        tabletReady,
        desktopOnly,
      }) => ({
        id,
        title,
        category,
        iconAssetId,
        iconFamilyVersion,
        iconRequired,
        accent,
        mobilePresentation,
        phoneReady,
        tabletReady,
        ...(desktopOnly ? { desktopOnly: true } : {}),
      }),
    ),
  });
}

function FolderIcon(props: {
  readonly item: Extract<BusinessOsHomeItem, { readonly kind: "folder" }>;
  readonly appsById: ReadonlyMap<string, BusinessOsMobileAppDescriptor>;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={`${props.item.title}, ${props.item.appIds.length} Apps`}
      accessibilityRole="button"
      className="w-[78px] items-center active:opacity-75"
      onPress={props.onPress}
    >
      <View className="size-[58px] flex-row flex-wrap items-center justify-center gap-1 rounded-[16px] bg-subtle-strong p-2 shadow-lg">
        {props.item.appIds.slice(0, 4).map((appId) => {
          const app = props.appsById.get(appId);
          return app ? (
            <View
              key={appId}
              className="size-[17px] items-center justify-center rounded-[5px]"
              style={{ backgroundColor: app.accent }}
            >
              <SymbolView name={app.icon} size={10} tintColor="#ffffff" type="monochrome" />
            </View>
          ) : null;
        })}
      </View>
      <Text className="mt-1.5 text-center text-xs font-t3-medium" numberOfLines={1}>
        {props.item.title}
      </Text>
    </Pressable>
  );
}

type BusinessOsHomeDeskProps = {
  readonly instance: BusinessOsInstance;
  readonly apps: readonly BusinessOsMobileAppDescriptor[];
  readonly layout: BusinessOsHomeLayout;
  readonly badges: ReadonlyMap<string, number>;
  readonly onLayoutChange: (layout: BusinessOsHomeLayout) => void;
  readonly onOpenApp: (app: BusinessOsMobileAppDescriptor) => void;
  readonly onOpenSearch: () => void;
  readonly onOpenRecents: () => void;
  readonly onOpenSettings: () => void;
  readonly onReturnToCode: () => void;
};

export function BusinessOsHomeDesk(props: BusinessOsHomeDeskProps) {
  if (NativeBusinessOsLauncher) {
    return (
      <NativeBusinessOsLauncher
        style={{ flex: 1 }}
        instanceName={props.instance.displayName}
        catalogJson={nativeCatalogJson(props.apps)}
        layoutJson={JSON.stringify(props.layout)}
        badgesJson={JSON.stringify(Object.fromEntries(props.badges))}
        onOpenApp={(event) => {
          const app = props.apps.find((candidate) => candidate.id === event.nativeEvent.appId);
          if (app && app.id !== "desktop") props.onOpenApp(app);
        }}
        onOpenSearch={props.onOpenSearch}
        onOpenRecents={props.onOpenRecents}
        onOpenSettings={props.onOpenSettings}
        onReturnToCode={props.onReturnToCode}
        onLayoutChange={(event) => {
          const { pageIndex, sourceIndex, targetIndex } = event.nativeEvent;
          props.onLayoutChange(
            moveBusinessOsHomeItem({ layout: props.layout, pageIndex, sourceIndex, targetIndex }),
          );
        }}
      />
    );
  }
  return <BusinessOsHomeDeskFallback {...props} />;
}

function BusinessOsHomeDeskFallback(props: BusinessOsHomeDeskProps) {
  const { width, height } = useWindowDimensions();
  const grid = businessOsHomeGrid({ width, height });
  const pageWidth = width;
  const [editing, setEditing] = useState(false);
  const [openFolder, setOpenFolder] = useState<string | null>(null);
  const [activePage, setActivePage] = useState(0);
  const appsById = useMemo(() => new Map(props.apps.map((app) => [app.id, app])), [props.apps]);
  const foreground = useThemeColor("--color-foreground");
  const selectedFolder = props.layout.pages
    .flat()
    .find((item) => item.kind === "folder" && item.id === openFolder);

  const openApp = (app: BusinessOsMobileAppDescriptor) => {
    if (app.desktopOnly || (grid.windowClass === "compact" ? !app.phoneReady : !app.tabletReady)) {
      Alert.alert(
        "Noch nicht mobil verfügbar",
        `${app.title} erfüllt den nativen Mobile-Presentation-Vertrag noch nicht.`,
      );
      return;
    }
    props.onOpenApp(app);
  };

  return (
    <View className="flex-1 bg-screen">
      <View
        pointerEvents="none"
        className="absolute -right-28 -top-20 size-80 rounded-full bg-blue-500/10"
      />
      <View
        pointerEvents="none"
        className="absolute -bottom-24 -left-20 size-72 rounded-full bg-violet-500/10"
      />

      <BusinessOsPlatformHeader>
        <View className="flex-row items-end justify-between gap-4">
          <View className="min-w-0 flex-1">
            <BrandMark compact />
            <Text className="mt-3 text-3xl font-t3-bold" numberOfLines={1}>
              {props.instance.displayName}
            </Text>
            <Text className="mt-1 text-sm text-foreground-muted">
              {editing ? "Apps bewegen oder zu Ordnern zusammenlegen" : "Business OS"}
            </Text>
          </View>
          <View className="flex-row gap-2">
            {editing ? (
              <ControlPill label="Fertig" variant="primary" onPress={() => setEditing(false)} />
            ) : (
              <>
                <ControlPill
                  accessibilityLabel="In Code wechseln"
                  icon="chevron.left.forwardslash.chevron.right"
                  onPress={props.onReturnToCode}
                />
                <ControlPill
                  accessibilityLabel="Business OS Einstellungen"
                  icon="gearshape"
                  onPress={props.onOpenSettings}
                />
              </>
            )}
          </View>
        </View>
      </BusinessOsPlatformHeader>

      <Pressable
        accessibilityLabel="Apps durchsuchen"
        accessibilityRole="button"
        className="mx-5 mt-4 min-h-12 flex-row items-center gap-3 rounded-full bg-subtle-strong px-4 active:opacity-75"
        onPress={props.onOpenSearch}
      >
        <SymbolView name="magnifyingglass" size={18} tintColor={foreground} type="monochrome" />
        <Text className="text-base text-foreground-muted">Apps durchsuchen</Text>
      </Pressable>

      <ScrollView
        accessibilityLabel="Home Desks"
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        className="mt-3 flex-1"
        onMomentumScrollEnd={(event) => {
          setActivePage(Math.round(event.nativeEvent.contentOffset.x / Math.max(1, pageWidth)));
        }}
      >
        {props.layout.pages.map((page, pageIndex) => (
          <View
            key={`page:${page.map((item) => item.id).join("|") || `empty:${props.layout.updatedAtMs}`}`}
            style={{ width: pageWidth }}
            className="flex-row flex-wrap content-start justify-center px-4 pt-4"
          >
            {page.map((item, itemIndex) => {
              if (item.kind === "folder") {
                return (
                  <View
                    key={item.id}
                    style={{ width: pageWidth / grid.columns }}
                    className="mb-5 items-center"
                  >
                    <FolderIcon
                      item={item}
                      appsById={appsById}
                      onPress={() => setOpenFolder(item.id)}
                    />
                  </View>
                );
              }
              const app = appsById.get(item.appId);
              return app ? (
                <View
                  key={item.id}
                  style={{ width: pageWidth / grid.columns }}
                  className="mb-5 items-center"
                >
                  <BusinessOsAppIcon
                    app={app}
                    badge={props.badges.get(app.id)}
                    columns={grid.columns}
                    editing={editing}
                    index={itemIndex}
                    onDrop={(sourceIndex, targetIndex) => {
                      if (targetIndex >= page.length) return;
                      props.onLayoutChange(
                        moveBusinessOsHomeItem({
                          layout: props.layout,
                          pageIndex,
                          sourceIndex,
                          targetIndex,
                        }),
                      );
                    }}
                    onEdit={() => setEditing(true)}
                    onOpen={() => openApp(app)}
                  />
                </View>
              ) : null;
            })}
          </View>
        ))}
      </ScrollView>

      <View className="items-center pb-2">
        <View className="mb-2 flex-row gap-1.5">
          {props.layout.pages.map((page, pageIndex) => (
            <View
              key={`dot:${page.map((item) => item.id).join("|") || `empty:${props.layout.updatedAtMs}`}`}
              className={
                pageIndex === activePage
                  ? "h-1.5 w-4 rounded-full bg-foreground"
                  : "size-1.5 rounded-full bg-foreground-muted/50"
              }
            />
          ))}
        </View>
        <Pressable
          accessibilityLabel="Workjet Recents öffnen"
          className="mb-2 min-h-8 justify-center px-5 active:opacity-70"
          onLongPress={() => {
            void Haptics.selectionAsync();
            props.onOpenRecents();
          }}
          onPress={props.onOpenRecents}
        >
          <Text className="text-xs font-t3-bold text-foreground-muted">RECENTS</Text>
        </Pressable>
        <BusinessOsPlatformDock>
          {props.layout.dock.map((appId) => {
            const app = appsById.get(appId);
            return app ? (
              <BusinessOsAppIcon
                key={app.id}
                app={app}
                badge={props.badges.get(app.id)}
                compact
                editing={editing}
                onEdit={() => setEditing(true)}
                onOpen={() => openApp(app)}
              />
            ) : null;
          })}
        </BusinessOsPlatformDock>
      </View>

      {selectedFolder?.kind === "folder" ? (
        <Pressable
          accessibilityLabel="Ordner schließen"
          className="absolute inset-0 items-center justify-center bg-black/35 px-6"
          onPress={() => setOpenFolder(null)}
        >
          <Pressable
            accessibilityLabel={selectedFolder.title}
            className="w-full max-w-[520px] rounded-[32px] bg-card p-6 shadow-2xl"
            onPress={(event) => event.stopPropagation()}
          >
            <Text className="text-center text-xl font-t3-bold">{selectedFolder.title}</Text>
            <View className="mt-6 flex-row flex-wrap justify-center gap-4">
              {selectedFolder.appIds.map((appId) => {
                const app = appsById.get(appId);
                return app ? (
                  <BusinessOsAppIcon
                    key={appId}
                    app={app}
                    onEdit={() => setEditing(true)}
                    onOpen={() => {
                      setOpenFolder(null);
                      openApp(app);
                    }}
                  />
                ) : null;
              })}
            </View>
          </Pressable>
        </Pressable>
      ) : null}
    </View>
  );
}
