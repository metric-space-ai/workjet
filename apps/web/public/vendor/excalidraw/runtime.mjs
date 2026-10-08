import {
  createElement,
  createRoot,
  Excalidraw,
  MainMenu,
  WelcomeScreen,
  exportToBlob,
  exportToSvg,
  serializeAsJSON,
  loadFromBlob,
  restore,
  restoreElements,
  convertToExcalidrawElements,
  MIME_TYPES,
  THEME,
} from "./excalidraw.mjs";

// Learnordie native fork; no Business OS shell, authentication, or foreign boot code.
function learnordieChrome() {
  const items = MainMenu.DefaultItems || {};
  const menuChildren = [];
  if (items.SearchMenu) menuChildren.push(createElement(items.SearchMenu, null));
  if (items.ChangeCanvasBackground) {
    if (menuChildren.length && MainMenu.Separator) {
      menuChildren.push(createElement(MainMenu.Separator, null));
    }
    menuChildren.push(createElement(items.ChangeCanvasBackground, null));
  }
  return [
    createElement(MainMenu, { key: "learnordie-menu" }, ...menuChildren),
    createElement(WelcomeScreen, { key: "learnordie-welcome" }, createElement("span", { hidden: true })),
  ];
}

export function mountExcalidraw(host, props, children) {
  const root = createRoot(host);
  const paint = (nextProps, nextChildren) => {
    root.render(createElement(Excalidraw, nextProps, ...(nextChildren ?? learnordieChrome())));
  };
  paint(props, children);
  return {
    update(nextProps, nextChildren) {
      paint(nextProps, nextChildren);
    },
    unmount() {
      root.unmount();
    },
  };
}

export {
  createElement,
  Excalidraw,
  MainMenu,
  exportToBlob,
  exportToSvg,
  serializeAsJSON,
  loadFromBlob,
  restore,
  restoreElements,
  convertToExcalidrawElements,
  MIME_TYPES,
  THEME,
};
