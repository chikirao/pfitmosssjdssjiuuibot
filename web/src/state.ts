import type { Catch, Me, ScheduleResponse, Watcher } from "../../src/shared/types";

type Listener = () => void;

/** Общее состояние мини-аппа + простейшая подписка на изменения. */
export const state = {
  me: null as Me | null,
  schedule: null as ScheduleResponse | null,
  scheduleError: null as string | null,
  chosenIds: new Set<number>(),
  watchers: null as Watcher[] | null,
  catches: null as Catch[] | null,
};

const listeners = new Map<string, Set<Listener>>();

export function on(ev: "me" | "schedule" | "chosen" | "alerts", fn: Listener) {
  if (!listeners.has(ev)) listeners.set(ev, new Set());
  listeners.get(ev)!.add(fn);
}

export function emit(ev: "me" | "schedule" | "chosen" | "alerts") {
  listeners.get(ev)?.forEach((fn) => fn());
}

export const hasToken = () => state.me?.token.status === "ok";
