import type { ColorValue } from "react-native";
import Svg, { Text } from "react-native-svg";

/** Workjet's readable product name, using the same label as the desktop UI. */
export function WorkjetWordmark(props: { readonly height: number; readonly color: ColorValue }) {
  return (
    <Svg
      accessibilityLabel="Workjet"
      height={props.height}
      width={props.height * 4}
      viewBox="0 0 128 32"
    >
      <Text
        x={0}
        y={25}
        fill={props.color}
        fontFamily="sans-serif"
        fontSize={28}
        fontWeight="700"
        letterSpacing={-0.7}
      >
        Workjet
      </Text>
    </Svg>
  );
}
