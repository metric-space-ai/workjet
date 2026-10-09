import { createFileRoute } from "@tanstack/react-router";
import { SpeechSettingsPanel } from "../components/settings/SpeechSettingsPanel";
export const Route = createFileRoute("/settings/speech")({ component: SpeechSettingsPanel });
