import type { ModellSceneKey, ModellSceneState } from "./modell-types";
import { modellTheme } from "./modell-theme";
import { GRAVITY, INITIAL_DISPLACEMENT, hangingSpringEnergy } from "./oscillator-physics";

// Didaktische Zustandslogik aus Modellbegriff_ThreeJS_clean.html, getrennt von der Darstellung.

export const modellSceneAccents: Record<ModellSceneKey, string> = {
  morph: "#e5c48c",
  miniature: "#e5c48c",
  law: "#8fcfc2",
  limits: "#8fcfc2",
  runtime: "#8eb9e9",
  learning: "#d5adf2",
  language: "#d5adf2",
  transfer: "#e5c48c"
};

export const modellConcepts = ["Abbild", "Beziehung", "Ausführung", "Lernen", "Sprache"] as const;
export const modellTransferSteps = ["Aufgabe", "Daten", "Lernen", "Prüfen", "Einsetzen"] as const;
export const modellTransferText = [
  "Welche Funktion soll entstehen? Aufgabe und gewünschte Leistung präzisieren.",
  "Welche Beispiele sind relevant? Daten auswählen und ihre Eignung prüfen.",
  "Welche Struktur und welches Lernverfahren führen zu einer geeigneten Funktion?",
  "Was leistet das Modell? An unabhängigen Fällen und Anforderungen prüfen.",
  "Wo wird die Funktion wirksam? Schnittstellen und Laufzeitumgebung gestalten."
] as const;

export const modellLanguageContexts = [
  { label: "Halterung", words: ["Die", "Halterung", "muss"], candidates: [["steif", 47], ["leicht", 31], ["montierbar", 22]] },
  { label: "Akku", words: ["Der", "Akku", "muss"], candidates: [["sicher", 51], ["entnehmbar", 29], ["langlebig", 20]] }
] as const;

const initialCoefficients: [number, number, number] = [0.3, 0.32, 0.05];

export function createModellSceneState(playing: boolean): ModellSceneState {
  const data: Array<[number, number]> = [];
  for (let i = 0; i < 21; i++) {
    const x = -1 + i / 10;
    const y = 0.45 - 0.35 * x + 0.85 * x * x + 0.04 * Math.sin(i * 2.9) + 0.025 * Math.cos(i * 1.8);
    data.push([x, y]);
  }
  return {
    playing,
    morph: 0,
    abstraction: 0,
    stiffness: 4,
    sceneTime: 0,
    oscillator: { x: GRAVITY / 4 + INITIAL_DISPLACEMENT, v: 0, time: 0 },
    oscillatorTrace: [{ x: GRAVITY / 4 + INITIAL_DISPLACEMENT, time: 0 }],
    description: "force",
    executing: playing,
    inputX: 0.4,
    outputAngle: 24,
    servoAngle: 0,
    a: [...initialCoefficients],
    steps: 0,
    trainingRunning: false,
    trainingLimit: 600,
    accumulator: 0,
    inferX: 0.2,
    context: 0,
    langStep: 0,
    tokenAdded: false,
    transferStep: 0,
    data
  };
}

export function resetModellLearning(state: ModellSceneState) {
  state.a = [...initialCoefficients];
  state.steps = 0;
  state.trainingRunning = false;
  state.trainingLimit = 600;
  state.accumulator = 0;
}

export function modellLoss(state: ModellSceneState) {
  return state.data.reduce((sum, [x, y]) => {
    const error = state.a[0] + state.a[1] * x + state.a[2] * x * x - y;
    return sum + error * error;
  }, 0) / state.data.length;
}

export function modellPredict(state: ModellSceneState, x: number) {
  return state.a[0] + state.a[1] * x + state.a[2] * x * x;
}

// Echte Parameteranpassung per Gradientenabstieg, wie in der Vorlage.
export function trainModellStep(state: ModellSceneState, dt: number) {
  if (!state.trainingRunning || !Number.isFinite(dt) || dt <= 0) return;
  state.accumulator += dt * 95;
  const count = Math.min(20, Math.floor(state.accumulator));
  state.accumulator -= count;
  for (let step = 0; step < count; step++) {
    const grad = [0, 0, 0];
    for (const [x, y] of state.data) {
      const error = state.a[0] + state.a[1] * x + state.a[2] * x * x - y;
      grad[0] += error;
      grad[1] += error * x;
      grad[2] += error * x * x;
    }
    for (let j = 0; j < 3; j++) state.a[j] -= (0.045 * 2 * grad[j]) / state.data.length;
    state.steps++;
    if (state.steps >= state.trainingLimit) {
      state.trainingRunning = false;
      break;
    }
  }
}

export function formatModellNumber(value: number, digits = 2) {
  return Number(value).toFixed(digits).replace(".", ",");
}

export function modellFitEquation(state: ModellSceneState) {
  const [a, b, c] = state.a;
  return `ŷ = ${formatModellNumber(a)}${b < 0 ? " − " : " + "}${formatModellNumber(Math.abs(b))}x${c < 0 ? " − " : " + "}${formatModellNumber(Math.abs(c))}x²`;
}

function svgText(x: number, y: number, text: string, size = 14, color = "currentColor") {
  return `<text x="${x}" y="${y}" fill="${color}" font-family="Virgil,Comic Sans MS,cursive" font-size="${size}" text-anchor="middle">${text}</text>`;
}

// 2D-Ersatzansicht der Vorlage (ohne WebGL, Druck, Standalone-Export, Miniaturen).
export function modellFallbackSvg(key: ModellSceneKey, state: ModellSceneState, accent: string, label: string, dark = false, transparent = false) {
  const theme = modellTheme(dark);
  accent = theme.accent;
  let inner = "";
  if (key === "learning") {
    const px = (x: number) => 70 + (x + 1) * 220;
    const py = (y: number) => 265 - y * 105;
    inner = `<path d="M65 45V265H520" fill="none" stroke="${theme.line}"/>`;
    for (const [x, y] of state.data) inner += `<circle cx="${px(x)}" cy="${py(y)}" r="4" fill="${theme.ink}"/>`;
    let path = "";
    for (let j = 0; j <= 100; j++) {
      const x = -1 + j / 50;
      path += `${j ? " L" : "M"}${px(x)} ${py(modellPredict(state, x))}`;
    }
    inner += `<path d="${path}" fill="none" stroke="${accent}" stroke-width="3"/>${svgText(300, 304, "Polynommodell · echte Parameteranpassung", 13)}`;
  } else if (key === "language") {
    ["Kontext", "Repräsentation", "Attention / FFN", "Fortsetzung"].forEach((text, i) => {
      const x = 20 + i * 145;
      inner += `<rect x="${x}" y="105" width="125" height="95" rx="8" fill="${theme.fill}" stroke="${theme.ink}"/>${svgText(x + 62, 158, text, 12)}`;
      if (i < 3) inner += `<path d="M${x + 128} 152h13" stroke="${accent}" stroke-width="2"/>`;
    });
    inner += svgText(300, 248, "Schematisch. Kein LLM im Browser.", 13);
  } else if (key === "runtime") {
    const angle = (state.servoAngle * Math.PI) / 180;
    inner = `<circle cx="85" cy="150" r="35" fill="${theme.fill}" stroke="${theme.ink}"/><rect x="230" y="100" width="115" height="100" rx="8" fill="${theme.fill}" stroke="${theme.ink}"/><circle cx="485" cy="150" r="63" fill="${theme.fill}" stroke="${theme.ink}"/><path d="M125 150H228M350 150H418" stroke="${accent}" stroke-width="2"/>`;
    inner += `<path d="M485 150L${485 + 47 * Math.sin(angle)} ${150 - 47 * Math.cos(angle)}" stroke="${accent}" stroke-width="4"/>${svgText(85, 157, "x", 23)}${svgText(287, 157, "f", 28)}${svgText(485, 255, `y = ${formatModellNumber(state.servoAngle, 1)}°`, 17)}`;
  } else if (key === "limits") {
    const q = hangingSpringEnergy(state.sceneTime), massTop = 160 + q.displacement * 45;
    const coil = Array.from({length: 17}, (_, i) => `${i ? "L" : "M"}${140 + (i % 2 ? 15 : -15)} ${60 + i / 16 * (massTop - 60)}`).join(" ");
    inner = `<path d="M95 50H185 ${coil}" stroke="${accent}" fill="none" stroke-width="3"/><rect x="112" y="${massTop}" width="56" height="42" fill="${theme.fill}" stroke="${theme.ink}"/>`;
    if (state.description === "energy") {
      ([['Eₖ',q.kinetic],['E_f',q.elastic],['E_g',q.gravitational]] as const).forEach(([name,energy], i) => {
        const x = 300 + 90*i, height = 190*energy/q.totalAtStart;
        inner += `<rect x="${x}" y="${250-height}" width="48" height="${Math.max(0,height)}" fill="${i===0?theme.secondary:i===1?accent:theme.ink}"/>${svgText(x+24,278,name,20)}`;
      });
      inner += svgText(414,40,`E = ${formatModellNumber(q.total)} J`,20);
    } else {
      inner += `<path d="M310 250L510 50M300 150H520M410 40V260" fill="none" stroke="${theme.ink}"/><circle cx="${410+q.displacement/q.amplitude*100}" cy="${150+q.displacement/q.amplitude*100}" r="6" fill="${accent}"/>${svgText(535,155,"x − x₀",16)}${svgText(410,28,"F",20)}`;
    }
  } else if (key === "morph" || key === "transfer") {
    const words = key === "morph" ? modellConcepts : modellTransferSteps;
    words.forEach((word, i) => {
      const x = 57 + i * 120;
      inner += `<circle cx="${x}" cy="145" r="32" fill="${theme.fill}" stroke="${theme.ink}" stroke-width="2"/>${svgText(x, 151, String(i + 1), 18, accent)}${svgText(x, 211, word, 12)}`;
      if (i < 4) inner += `<path d="M${x + 36} 145h46" stroke="${theme.line}"/>`;
    });
  } else {
    inner = `<path d="M125 65H260M193 65V83l-15 12 30 12-30 12 30 12-30 12 30 12-15 12v24" stroke="${accent}" fill="none" stroke-width="3"/><rect x="163" y="202" width="60" height="48" rx="5" fill="${theme.fill}" stroke="${theme.ink}"/><path d="M100 276H285" stroke="${theme.ink}" stroke-width="3"/>`;
    const formula = key === "law" ? "m·ẍ = mg − kx" : "Masse ↔ Feder";
    inner += svgText(430, 155, formula, 22, accent);
  }
  const safeLabel = label.replace(/[<>&"]/g, "");
  return `<svg viewBox="0 0 600 340" xmlns="http://www.w3.org/2000/svg" style="color:${theme.ink}" role="img" aria-label="2D-Ersatzansicht: ${safeLabel}">${transparent ? "" : `<rect width="600" height="340" fill="${theme.paper}"/>`}${inner}</svg>`;
}

export function modellFallbackDataUri(key: ModellSceneKey, state: ModellSceneState, accent: string, label: string, dark = false, transparent = false) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(modellFallbackSvg(key, state, accent, label, dark, transparent))}`;
}
