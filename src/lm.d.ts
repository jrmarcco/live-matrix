import type { LmApi } from '../electron/preload';

declare global {
  interface Window {
    lm: LmApi;
  }
}

export {};
