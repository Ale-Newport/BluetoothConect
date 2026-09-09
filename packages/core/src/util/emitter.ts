/**
 * Typed event emitter. Deliberately tiny and synchronous; listener errors are
 * isolated so one bad subscriber cannot take down the networking stack.
 */
export type Unsubscribe = () => void;

type Listener<T> = (payload: T) => void;

export class TypedEmitter<Events extends { [K in keyof Events]: unknown }> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>();
  private onError: ((event: string, err: unknown) => void) | undefined;

  setErrorHandler(fn: (event: string, err: unknown) => void): void {
    this.onError = fn;
  }

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): Unsubscribe {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<never>);
    return () => {
      set!.delete(listener as Listener<never>);
    };
  }

  once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): Unsubscribe {
    const off = this.on(event, (payload) => {
      off();
      listener(payload);
    });
    return off;
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;
    for (const listener of [...set]) {
      try {
        (listener as Listener<Events[K]>)(payload);
      } catch (err) {
        if (this.onError) this.onError(String(event), err);
        else console.error(`[TypedEmitter] listener for "${String(event)}" threw`, err);
      }
    }
  }

  removeAllListeners(event?: keyof Events): void {
    if (event === undefined) this.listeners.clear();
    else this.listeners.delete(event);
  }

  listenerCount(event: keyof Events): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}
