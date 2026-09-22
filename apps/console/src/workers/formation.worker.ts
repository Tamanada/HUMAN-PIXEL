/// <reference lib="webworker" />
/**
 * Runs the formation engine off the main thread: 50,000 points with Lloyd relaxation takes a few
 * seconds; the UI stays responsive and shows progress.
 */
import { FormationError, generateFormation, type EngineRequest, type EngineResponse } from '@human-pixel/core';

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (e: MessageEvent<EngineRequest>) => {
  const { id, input } = e.data;
  let last = 0;
  try {
    const result = generateFormation({
      ...input,
      onProgress: (stage, fraction) => {
        const now = performance.now();
        if (now - last < 80 && fraction < 1) return;
        last = now;
        self.postMessage({ id, type: 'progress', stage, fraction } satisfies EngineResponse);
      },
    });
    self.postMessage({ id, type: 'done', result } satisfies EngineResponse);
  } catch (err) {
    const fe = err instanceof FormationError ? err : null;
    self.postMessage({
      id,
      type: 'error',
      code: fe?.code ?? 'ENGINE_ERROR',
      message: (err as Error).message,
      details: fe?.details,
    } satisfies EngineResponse);
  }
};
