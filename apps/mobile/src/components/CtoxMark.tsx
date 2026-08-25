import { Image } from "expo-image";

/**
 * The approved Workjet mark. The underlying asset path stays unchanged during
 * the soft migration so store updates retain the released visual identity.
 */
export function CtoxMark(props: { readonly size: number }) {
  return (
    <Image
      accessibilityLabel="Workjet"
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
