const Reporter = require('../newspulse-backend-real-main/models/Reporter');

async function addStrikeForReporter(reporterId, reason) {
  try {
    if (!reporterId) return;
    const reporter = await Reporter.findById(reporterId);
    if (!reporter) return;

    reporter.ethicsStrikes = (reporter.ethicsStrikes || 0) + 1;
    // Optional auto-blacklist threshold
    if (reporter.ethicsStrikes >= 3 && reporter.status !== 'blacklisted') {
      reporter.status = 'blacklisted';
    }
    // Minimal note append if supported
    if (reason && typeof reporter.journalistNotes === 'string') {
      reporter.journalistNotes = (reporter.journalistNotes || '').trim();
      reporter.journalistNotes += (reporter.journalistNotes ? '\n' : '') + `[strike] ${new Date().toISOString()} - ${String(reason)}`;
    }

    await reporter.save();
  } catch (e) {
    console.warn('[safety:addStrikeForReporter] failed', e?.message || e);
  }
}

module.exports = { addStrikeForReporter };
