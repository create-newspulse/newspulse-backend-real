const TranslationJob = require('../models/TranslationJob');
const mongoose = require('mongoose');
const { shutdownError } = require('../lib/backgroundTasks');

const TRANSLATION_LEASE_MS = 20 * 60 * 1000;

function leaseLost() {
  return Object.assign(new Error('Translation job ownership was lost or expired.'), {
    code: 'TRANSLATION_JOB_LEASE_LOST',
  });
}

function createTranslationJobLease(job, {
  owner, signal, logger = console, now = () => new Date(), Job = TranslationJob,
}) {
  if (!mongoose.isObjectIdOrHexString(job?._id) || !mongoose.isObjectIdOrHexString(job.newsId)
    || job.status !== 'running' || !job.type || typeof owner !== 'string' || !owner || job.lockedBy !== owner
    || !job.lockedAt || !Number.isFinite(new Date(job.lockedAt).getTime())
    || !Number.isSafeInteger(job.attempts) || job.attempts < 1) {
    throw Object.assign(new Error('The translation claim was not acknowledged.'), {
      code: 'TRANSLATION_JOB_CLAIM_INVALID',
    });
  }
  const controller = new AbortController();
  let timer;
  let heartbeat;
  const abort = () => controller.abort(shutdownError());
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });

  function assertActive() {
    controller.signal.throwIfAborted();
  }

  async function update(patch, session) {
    assertActive();
    const at = now();
    const result = await Job.updateOne({
      _id: job._id, newsId: job.newsId, type: job.type,
      status: 'running', lockedBy: owner, attempts: job.attempts,
      lockedAt: { $gt: new Date(at.getTime() - TRANSLATION_LEASE_MS) },
    }, { $set: patch }, session ? { session } : {});
    if (!result?.acknowledged || result.matchedCount !== 1) {
      const error = leaseLost();
      controller.abort(error);
      throw error;
    }
    return result;
  }

  function fence(session) {
    if (!session) throw new TypeError('A transaction is required for a translation write fence.');
    return update({ lockedAt: now() }, session);
  }

  function startHeartbeat() {
    if (timer || controller.signal.aborted) return;
    timer = setInterval(() => {
      if (heartbeat || controller.signal.aborted) return;
      heartbeat = update({ lockedAt: now() }).catch(error => {
        controller.abort(leaseLost());
        logger.warn?.('[i18n][queue] heartbeat failed', {
          jobId: String(job._id), code: error.code || 'TRANSLATION_JOB_HEARTBEAT_FAILED',
        });
      }).finally(() => { heartbeat = null; });
    }, Math.floor(TRANSLATION_LEASE_MS / 3));
    timer.unref?.();
  }

  function stopHeartbeat() {
    clearInterval(timer);
    timer = null;
    return heartbeat || Promise.resolve();
  }

  const onAbort = () => { clearInterval(timer); timer = null; };
  controller.signal.addEventListener('abort', onAbort, { once: true });

  return {
    assertActive, update, fence, startHeartbeat, stopHeartbeat,
    signal: controller.signal,
    dispose() {
      clearInterval(timer);
      signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', onAbort);
    },
  };
}

module.exports = { createTranslationJobLease, TRANSLATION_LEASE_MS };
