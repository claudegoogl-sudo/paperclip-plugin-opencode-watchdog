import type { PluginContext } from "@paperclipai/plugin-sdk";

/** Tiny key/value view over `ctx.state` (instance scope). Tests use MemoryKv. */
export interface Kv {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

export class MemoryKv implements Kv {
  readonly data = new Map<string, unknown>();
  async get<T>(key: string) {
    const v = this.data.get(key);
    return v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as T);
  }
  async set(key: string, value: unknown) {
    this.data.set(key, JSON.parse(JSON.stringify(value)));
  }
}

export const STATE_NAMESPACE = "opencode-watchdog";

export function stateKv(ctx: PluginContext): Kv {
  const k = (stateKey: string) => ({ scopeKind: "instance" as const, namespace: STATE_NAMESPACE, stateKey });
  return {
    async get<T>(key: string) {
      const v = await ctx.state.get(k(key));
      return (v ?? undefined) as T | undefined;
    },
    async set(key: string, value: unknown) {
      await ctx.state.set(k(key), value);
    },
  };
}
