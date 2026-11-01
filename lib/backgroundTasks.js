function isBackgroundWorkersEnabled(env = process.env) {
  if (env.BACKGROUND_WORKERS_ENABLED === undefined) return true;
  const value = String(env.BACKGROUND_WORKERS_ENABLED).trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('BACKGROUND_WORKERS_ENABLED must be true or false.');
}

function shutdownError() {
  return Object.assign(new Error('The server is shutting down.'), { code: 'WORKER_SHUTDOWN' });
}

function createBackgroundTasks() {
  const active = new Set();
  const stoppers = new Set();
  const controller = new AbortController();
  let closing = false;
  let stopPromise;

  function track(name, work) {
    const promise = Promise.resolve(work);
    const entry = { name, promise };
    active.add(entry);
    promise.then(() => active.delete(entry), () => active.delete(entry));
    return promise;
  }

  function run(name, work) {
    if (closing) return Promise.reject(shutdownError());
    return track(name, Promise.resolve().then(() => {
      if (closing) throw shutdownError();
      return work(controller.signal);
    }));
  }

  function registerStop(stop) {
    if (typeof stop !== 'function') throw new TypeError('A background stop function is required.');
    if (closing) throw shutdownError();
    stoppers.add(stop);
    return () => stoppers.delete(stop);
  }

  function beginShutdown() {
    if (stopPromise) return stopPromise;
    closing = true;
    const pending = [...stoppers].map(stop => {
      try { return Promise.resolve(stop()); }
      catch (error) { return Promise.reject(error); }
    });
    stoppers.clear();
    stopPromise = Promise.allSettled(pending).then(results => {
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Background shutdown failed.');
    });
    return stopPromise;
  }

  async function waitForIdle() {
    while (active.size) await Promise.allSettled([...active].map(entry => entry.promise));
  }

  return {
    track,
    run,
    registerStop,
    beginShutdown,
    waitForIdle,
    abort: () => { closing = true; controller.abort(shutdownError()); },
    get signal() { return controller.signal; },
    get closing() { return closing; },
    get pending() { return [...active].map(entry => entry.name); },
  };
}

module.exports = createBackgroundTasks();
module.exports.createBackgroundTasks = createBackgroundTasks;
module.exports.shutdownError = shutdownError;
module.exports.isBackgroundWorkersEnabled = isBackgroundWorkersEnabled;
