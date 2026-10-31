const backgroundTasks = require('./backgroundTasks');

function shutdownTimeout(env = process.env) {
  const raw = env.SHUTDOWN_TIMEOUT_MS;
  if (raw === undefined || raw === '') return 25_000;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new Error('SHUTDOWN_TIMEOUT_MS must be a positive integer within the Node timer range.');
  }
  return value;
}

function shutdownAdmission(tasks = backgroundTasks) {
  return (_req, res, next) => {
    if (!tasks.closing) return next();
    res.set('Connection', 'close');
    res.set('Cache-Control', 'no-store');
    res.set('Retry-After', '1');
    return res.status(503).json({
      ok: false, success: false, status: 503,
      code: 'SERVER_SHUTTING_DOWN', message: 'The server is shutting down. Please retry shortly.',
    });
  };
}

function installGracefulShutdown({
  server, closeDatabase, closeRedis, tasks = backgroundTasks, logger = console,
  timeoutMs = shutdownTimeout(), processRef = process, exit = code => processRef.exit(code),
}) {
  const sockets = new Set();
  let completion;
  const onConnection = socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };
  server.on('connection', onConnection);

  function shutdown(signal = 'shutdown') {
    if (completion) return completion;
    logger.info?.('[shutdown] draining', { signal, timeoutMs });
    const stops = tasks.beginShutdown();
    const closed = new Promise((resolve, reject) => {
      server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
      server.closeIdleConnections?.();
    });
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        tasks.abort();
        for (const socket of sockets) socket.destroy();
        reject(Object.assign(new Error('Shutdown drain deadline exceeded.'), { code: 'SHUTDOWN_TIMEOUT' }));
      }, timeoutMs);
    });
    const drain = async () => {
      const results = await Promise.allSettled([stops, closed]);
      await tasks.waitForIdle();
      tasks.signal.throwIfAborted();
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      try { await closeDatabase(); } catch (error) { errors.push(error); }
      try { await closeRedis(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'Shutdown did not finish cleanly.');
    };
    completion = Promise.race([drain(), deadline]).then(
      () => {
        logger.info?.('[shutdown] drained');
        return 0;
      },
      error => {
        tasks.abort();
        for (const socket of sockets) socket.destroy();
        logger.error?.('[shutdown] incomplete', { code: error.code || 'SHUTDOWN_FAILED', pending: tasks.pending });
        return 1;
      },
    ).then(code => {
      clearTimeout(timer);
      processRef.removeListener('SIGTERM', onTerm);
      processRef.removeListener('SIGINT', onInt);
      server.removeListener('connection', onConnection);
      exit(code);
      return code;
    });
    return completion;
  }

  const onTerm = () => { shutdown('SIGTERM'); };
  const onInt = () => { shutdown('SIGINT'); };
  processRef.on('SIGTERM', onTerm);
  processRef.on('SIGINT', onInt);
  return shutdown;
}

module.exports = { shutdownTimeout, shutdownAdmission, installGracefulShutdown };
