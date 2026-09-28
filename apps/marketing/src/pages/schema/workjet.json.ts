import type { APIRoute } from "astro";

import { buildWorkjetProjectFileJsonSchema } from "@workjet/shared/workjetProjectFile";

// Rendered at build time; published at https://workjet.codes/schema/workjet.json so
// workjet.json files can reference it via "$schema" for editor/LSP support.
export const GET: APIRoute = () =>
  new Response(`${JSON.stringify(buildWorkjetProjectFileJsonSchema(), null, 2)}\n`, {
    headers: { "Content-Type": "application/json" },
  });
