// Phase 2 AI & Policy Layer Stub
// This helper will evolve to call real AI services, risk classifiers,
// and policy engines. For now it simply mirrors original content and
// transitions status.

async function runCommunityAiChecks(submission) {
  if (!submission) return submission;
  try {
    // Stub logic: copy originals
    submission.aiHeadline = submission.headline;
    submission.aiBody = submission.body; // body is underlying story field
    submission.riskScore = 0;
    submission.flags = [];
    // Advance status directly to PENDING_FOUNDER per Phase 2 spec
    submission.status = 'PENDING_FOUNDER';
    await submission.save();
  } catch (e) {
    // Log but do not fail the request; allow founder queue even without AI.
    console.warn('[COMMUNITY_AI][stub-error]', e?.message || e);
  }
  return submission;
}

module.exports = { runCommunityAiChecks };