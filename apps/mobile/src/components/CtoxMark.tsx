import { Image } from "expo-image";

/**
 * The CTOX "X" brand mark, matching the desktop sidebar's CtoxMark
 * (apps/web SidebarChrome.tsx): the app-icon raster, slightly rounded.
 */
export function CtoxMark(props: { readonly size: number }) {
  return (
    <Image
      accessibilityLabel="CTOX"
      accessibilityIgnoresInvertColors
      source={require("../../../../assets/ctox/ctox-app-icon.png")}
      style={{
        width: props.size,
        height: props.size,
        borderRadius: Math.max(2, Math.round(props.size / 8)),
      }}
    />
  );
}
