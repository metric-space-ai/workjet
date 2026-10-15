/** Router-Attrappe nur für Fixtures (kein Routing, keine Navigation). */
import type { ReactNode } from "react";

export function useNavigate() {
  return async (_options: unknown) => {};
}
export function Link(props: { readonly children?: ReactNode }) {
  return <a href="#">{props.children}</a>;
}
export function createFileRoute(_path: string) {
  return (options: unknown) => options;
}
