/**
 * Coordinates idempotent shutdown for the Hub.
 * A successful stop is memoized. A failed stop is cleared so a later caller can
 * retry; concurrent callers still share the same in-flight attempt.
 */
export function createStopController({ cleanup, onStop } = {}) {
  if (typeof cleanup !== 'function') throw new TypeError('cleanup must be a function');
  let stopping = false;
  let stopPromise = null;
  function stop() {
    if (stopPromise) return stopPromise;
    if (!stopping) {
      stopping = true;
      try { onStop?.(); } catch {}
    }
    let operation;
    operation = (async () => {
      try {
        return await cleanup();
      } catch (error) {
        // Clear before the rejection reaches callers so an immediate retry (for
        // example the top-level finally block) starts a fresh cleanup attempt.
        if (stopPromise === operation) stopPromise = null;
        throw error;
      }
    })();
    stopPromise = operation;
    return operation;
  }
  return {
    stop,
    get stopping() { return stopping; },
  };
}
