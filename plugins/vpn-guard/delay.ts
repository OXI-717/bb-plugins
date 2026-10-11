/** Sleep until the deadline or abort, releasing both resources on either path. */
export function abortableDelay(signal: AbortSignal, ms: number): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort',finish);
      resolve();
    };
    timer=setTimeout(finish,ms);
    signal.addEventListener('abort',finish,{once:true});
    if (signal.aborted) finish();
  });
}
