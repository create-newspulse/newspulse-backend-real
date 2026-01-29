const express = require('express');

const BUILD_TIME = String(process.env.BUILD_TIME || new Date().toISOString());

function pickGitSha() {
  const candidates = [
    process.env.RENDER_GIT_COMMIT,
    process.env.GITHUB_SHA,
    process.env.VERCEL_GIT_COMMIT_SHA,
    process.env.COMMIT_SHA,
    process.env.SOURCE_VERSION,
  ].filter(Boolean);

  const sha = candidates.length ? String(candidates[0]) : 'unknown';
  return sha.length > 64 ? sha.slice(0, 64) : sha;
}

const router = express.Router();

// GET /_debug/version
router.get('/version', (_req, res) => {
  return res.status(200).json({
    service: 'newspulse-backend',
    gitSha: pickGitSha(),
    buildTime: BUILD_TIME,
  });
});

module.exports = router;
