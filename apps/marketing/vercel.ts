import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  installCommand: "npm install -g vite-plus && vp install --filter '@workjet/marketing...'",
  buildCommand: "vp run --filter @workjet/marketing build",
  outputDirectory: "dist",
};
