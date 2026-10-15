/** Excalidraw's paper, ink and violet action palette, shared by WebGL and SVG. */
export function modellTheme(dark = false) {
  return dark
    ? { paper: "#121212", panel: "#232329", ink: "#e9ecef", muted: "#b1b1bd", line: "#63636e", fill: "#34334d", accent: "#a8a5ff", secondary: "#d0bfff" }
    : { paper: "#ffffff", panel: "#ffffff", ink: "#343a40", muted: "#60646c", line: "#adb5bd", fill: "#eeedfc", accent: "#6965db", secondary: "#9c36b5" };
}

export type ModellTheme = ReturnType<typeof modellTheme>;
