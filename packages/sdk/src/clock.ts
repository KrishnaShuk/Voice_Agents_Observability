export type MonotonicClock = () => number;
export type WallClock = () => number;

export const monotonicNow: MonotonicClock = () => performance.now();
export const wallNow: WallClock = () => Date.now();
