import { createRouter, RouterHistory } from "@tanstack/react-router";

import { RouteNotFoundPage } from "./components/RouteFallbackPage";
import { routeTree } from "./routeTree.gen";

export function getRouter(history: RouterHistory) {
  return createRouter({
    routeTree,
    history,
    context: {},
    // D45: nie TanStacks englisches „Not Found“.
    defaultNotFoundComponent: RouteNotFoundPage,
  });
}

export type AppRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
