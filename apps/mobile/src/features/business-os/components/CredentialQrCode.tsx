import { QrCode } from "@t3tools/shared/qrCode";
import { useMemo } from "react";
import { View } from "react-native";
import Svg, { Rect } from "react-native-svg";

const QUIET_ZONE = 4;

export function CredentialQrCode(props: { readonly value: string; readonly size?: number }) {
  const renderedSize = props.size ?? 264;
  const qr = useMemo(() => QrCode.encodeText(props.value, QrCode.Ecc.MEDIUM), [props.value]);
  const moduleCount = qr.size + QUIET_ZONE * 2;
  const modules = useMemo(() => {
    const result: Array<{ readonly x: number; readonly y: number }> = [];
    for (let y = 0; y < qr.size; y += 1) {
      for (let x = 0; x < qr.size; x += 1) {
        if (qr.getModule(x, y)) result.push({ x: x + QUIET_ZONE, y: y + QUIET_ZONE });
      }
    }
    return result;
  }, [qr]);

  return (
    <View
      accessibilityLabel="Temporärer Workjet Pairing QR-Code"
      accessibilityRole="image"
      className="self-center overflow-hidden rounded-[20px] bg-white p-2"
    >
      <Svg height={renderedSize} width={renderedSize} viewBox={`0 0 ${moduleCount} ${moduleCount}`}>
        <Rect width={moduleCount} height={moduleCount} fill="#ffffff" />
        {modules.map((module) => (
          <Rect
            key={`${module.x}:${module.y}`}
            x={module.x}
            y={module.y}
            width={1}
            height={1}
            fill="#111111"
          />
        ))}
      </Svg>
    </View>
  );
}
