/** One renderer budget shared by every Business OS host window. */
export interface CtoxGuestLease {
  readonly bind: (destroy: () => void) => void;
  readonly ready: () => void;
  readonly touch: (attached?: boolean) => void;
  /** Returns false when this exact guest has already been released. */
  readonly release: () => boolean;
}

export class CtoxGuestBudget {
  private readonly entries = new Set<{
    attached: boolean;
    preparing: boolean;
    lastUsed: number;
    destroy: (() => void) | undefined;
  }>();
  private sequence = 0;
  readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  reserve(attached: boolean): CtoxGuestLease | undefined {
    if (this.entries.size >= this.limit) {
      const victim = [...this.entries]
        .filter((entry) => !entry.attached && !entry.preparing && entry.destroy !== undefined)
        .sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (victim === undefined) return undefined;
      victim.destroy?.();
      if (this.entries.size >= this.limit) return undefined;
    }
    const entry = {
      attached,
      preparing: true,
      lastUsed: ++this.sequence,
      destroy: undefined as (() => void) | undefined,
    };
    this.entries.add(entry);
    return {
      bind: (destroy) => {
        entry.destroy = destroy;
      },
      ready: () => {
        entry.preparing = false;
      },
      touch: (nextAttached) => {
        if (nextAttached !== undefined) entry.attached = nextAttached;
        entry.lastUsed = ++this.sequence;
      },
      release: () => this.entries.delete(entry),
    };
  }
}
