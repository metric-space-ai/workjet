/** Minimal DOM for real React root/subscription tests without a browser process. */
export class DomNode {
  nodeType: number;
  nodeName: string;
  tagName: string;
  childNodes: DomNode[] = [];
  parentNode: DomNode | null = null;
  attributes: Record<string, string> = {};
  style: Record<string, string> = {};
  ownerDocument: DomDocument | null = null;
  data = "";
  namespaceURI = "http://www.w3.org/1999/xhtml";
  className = "";
  lang = "";
  constructor(tag: string) {
    this.nodeType = tag === "#text" ? 3 : 1;
    this.nodeName = tag === "#text" ? "#text" : tag.toUpperCase();
    this.tagName = this.nodeName;
  }
  get nextSibling(): DomNode | null {
    const parent = this.parentNode;
    if (!parent) return null;
    const index = parent.childNodes.indexOf(this);
    return parent.childNodes[index + 1] ?? null;
  }
  get firstChild(): DomNode | null {
    return this.childNodes[0] ?? null;
  }
  get textContent(): string {
    return this.nodeType === 3
      ? this.data
      : this.childNodes.map((child) => child.textContent).join("");
  }
  set textContent(value: string) {
    this.childNodes = [];
    if (value) {
      const text = new DomNode("#text");
      text.data = String(value);
      this.appendChild(text);
    }
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = String(value);
    if (name === "class") this.className = String(value);
  }
  getAttribute(name: string) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name)
      ? this.attributes[name]!
      : null;
  }
  hasAttribute(name: string) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name);
  }
  removeAttribute(name: string) {
    delete this.attributes[name];
  }
  appendChild(child: DomNode) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  insertBefore(child: DomNode, ref: DomNode | null) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    const index = ref ? this.childNodes.indexOf(ref) : -1;
    if (index < 0) this.childNodes.push(child);
    else this.childNodes.splice(index, 0, child);
    return child;
  }
  removeChild(child: DomNode) {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  contains(child: DomNode): boolean {
    if (child === this) return true;
    return this.childNodes.some((node) => node.contains(child));
  }
  addEventListener() {}
  removeEventListener() {}
  focus() {}
  blur() {}
  getBoundingClientRect() {
    return {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      toJSON() {
        return {};
      },
    };
  }
  get classList() {
    const node = this;
    return {
      add(...tokens: string[]) {
        const current = new Set(node.className.split(/\s+/u).filter(Boolean));
        for (const token of tokens) current.add(token);
        node.className = [...current].join(" ");
        node.attributes.class = node.className;
      },
      remove(...tokens: string[]) {
        const drop = new Set(tokens);
        node.className = node.className
          .split(/\s+/u)
          .filter((token) => token && !drop.has(token))
          .join(" ");
        node.attributes.class = node.className;
      },
      contains(token: string) {
        return node.className.split(/\s+/u).includes(token);
      },
      toggle(token: string) {
        if (this.contains(token)) this.remove(token);
        else this.add(token);
      },
    };
  }
}

interface DomDocument {
  visibilityState: DocumentVisibilityState;
  activeElement: DomNode | null;
  documentElement: DomNode;
  body: DomNode;
  defaultView: typeof globalThis;
  createElement(tag: string): DomNode;
  createElementNS(_ns: string, tag: string): DomNode;
  createTextNode(text: string): DomNode;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

export function installDom() {
  const listeners = new Map<string, Set<EventListener>>();
  const document: DomDocument = {
    visibilityState: "visible",
    activeElement: null,
    documentElement: null as unknown as DomNode,
    body: null as unknown as DomNode,
    defaultView: globalThis,
    createElement(tag: string) {
      const node = new DomNode(tag);
      node.ownerDocument = document;
      return node;
    },
    createElementNS(_ns: string, tag: string): DomNode {
      return document.createElement(tag);
    },
    createTextNode(text: string) {
      const node = new DomNode("#text");
      node.data = String(text);
      node.ownerDocument = document;
      return node;
    },
    addEventListener(type: string, listener: EventListener) {
      let set = listeners.get(type);
      if (!set) listeners.set(type, (set = new Set()));
      set.add(listener);
    },
    removeEventListener(type: string, listener: EventListener) {
      listeners.get(type)?.delete(listener);
    },
  };
  document.documentElement = document.createElement("html");
  document.documentElement.lang = "de";
  document.body = document.createElement("body");
  globalThis.document = document as unknown as Document;
  globalThis.window = globalThis as unknown as Window & typeof globalThis;
  globalThis.addEventListener = document.addEventListener as typeof globalThis.addEventListener;
  globalThis.removeEventListener =
    document.removeEventListener as typeof globalThis.removeEventListener;
  globalThis.HTMLElement = DomNode as unknown as typeof HTMLElement;
  globalThis.Element = DomNode as unknown as typeof Element;
  globalThis.Node = DomNode as unknown as typeof Node;
  globalThis.HTMLIFrameElement = class {} as unknown as typeof HTMLIFrameElement;
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  return document;
}
