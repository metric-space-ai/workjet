/** Router-Attrappe nur für Fixtures (kein Routing, keine Navigation). */
import type { ReactNode } from "react";

// @ts-expect-error -- Vite-Alias nur in der Fixture; Typen kommen vom echten Paket.
export * from "fixture-real-router";

export function useNavigate() {
  return async (_options: unknown) => {};
}
export function Link(props: { readonly children?: ReactNode }) {
  return <a href="#">{props.children}</a>;
}
export function createFileRoute(_path: string) {
  return (options: unknown) => options;
}
