import { evaluateMaiaPosition, initializeMaia, subscribeMaiaProgress, type MaiaEvaluateParams } from './maiaInference';

type MaiaWorkerRequest = { id: number; params: MaiaEvaluateParams };
type MaiaWorkerResponse = { id: number; result?: Awaited<ReturnType<typeof evaluateMaiaPosition>>; error?: string };

// ONNX Runtime sessions are kept inside this worker and evaluated one at a time.
let queue = Promise.resolve();
subscribeMaiaProgress((loading) => self.postMessage({ loading }));

self.addEventListener('message', (event: MessageEvent<MaiaWorkerRequest>) => {
  const { id, params } = event.data;
  queue = queue.then(async () => {
    try {
      await initializeMaia();
      self.postMessage({ id, phase: 'evaluating' });
      const result = await evaluateMaiaPosition(params);
      const response: MaiaWorkerResponse = { id, result };
      self.postMessage(response);
    } catch (error) {
      const response: MaiaWorkerResponse = {
        id,
        error: error instanceof Error ? error.message : String(error),
      };
      self.postMessage(response);
    }
  }).catch((error) => {
    // Keep the queue usable if posting a response itself fails.
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) } satisfies MaiaWorkerResponse);
  });
});
