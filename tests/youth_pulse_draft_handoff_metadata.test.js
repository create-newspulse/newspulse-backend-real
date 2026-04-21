const test = require('node:test');
const assert = require('node:assert/strict');

const servicePath = require.resolve('../services/youthPulseSubmission.service');
const newsPath = require.resolve('../models/News');
const syncServicePath = require.resolve('../services/youthPulseContributor.service');

test('createYouthPulseDraft stores stable Youth Pulse source metadata on shared drafts', async () => {
  const originalService = require.cache[servicePath];
  const originalNews = require.cache[newsPath];
  const originalSyncService = require.cache[syncServicePath];
  const savedArticles = [];

  function FakeNews(payload) {
    Object.assign(this, payload);
    this._id = this._id || '507f1f77bcf86cd799439099';
  }

  FakeNews.findById = async () => null;
  FakeNews.findOne = async () => null;
  FakeNews.prototype.save = async function save() {
    savedArticles.push({
      title: this.title,
      description: this.description,
      content: this.content,
      category: this.category,
      track: this.track,
      tags: this.tags,
      status: this.status,
      source: this.source,
      sourceType: this.sourceType,
      sourceLabel: this.sourceLabel,
      submissionSource: this.submissionSource,
      sourceTrack: this.sourceTrack,
      originType: this.originType,
      youthPulseSubmissionId: this.youthPulseSubmissionId,
      youthPulseContributorId: this.youthPulseContributorId,
      location: this.location,
    });
    return this;
  };

  require.cache[newsPath] = {
    id: newsPath,
    filename: newsPath,
    loaded: true,
    exports: FakeNews,
  };
  require.cache[syncServicePath] = {
    id: syncServicePath,
    filename: syncServicePath,
    loaded: true,
    exports: { syncYouthPulseContributorStats: async () => null },
  };
  delete require.cache[servicePath];

  try {
    const { createYouthPulseDraft } = require('../services/youthPulseSubmission.service');

    const submission = {
      _id: '507f1f77bcf86cd799439011',
      contributorId: '507f1f77bcf86cd799439012',
      headline: 'Campus bus schedule under review',
      storyBody: 'Students say late evening routes were cut without notice.',
      track: 'student-voices',
      originalLanguage: 'en',
      optionalSourceLinks: ['https://example.com/source'],
      city: { label: 'Ahmedabad' },
      state: { name: 'Gujarat' },
      status: 'approved',
      async save() {
        return this;
      },
    };

    const result = await createYouthPulseDraft(submission, { admin: 'editor@newspulse.ai' });
    const saved = savedArticles.at(-1);

    assert.ok(saved);
    assert.equal(saved.sourceType, 'youth_pulse');
    assert.equal(saved.sourceLabel, 'Youth Pulse');
    assert.equal(saved.submissionSource, 'youth_pulse');
    assert.equal(saved.track, 'student-voices');
    assert.equal(saved.sourceTrack, 'student-voices');
    assert.deepEqual(saved.location, {
      city: 'Ahmedabad',
      state: 'Gujarat',
      country: null,
    });
    assert.equal(saved.youthPulseSubmissionId, '507f1f77bcf86cd799439011');
    assert.equal(result.article.source, 'community');
    assert.equal(submission.status, 'draft_created');
    assert.equal(submission.linkedDraftId, '507f1f77bcf86cd799439099');
    assert.equal(submission.approvedBy, 'editor@newspulse.ai');
    assert.equal(submission.reviewedBy, 'editor@newspulse.ai');
  } finally {
    delete require.cache[servicePath];
    if (originalService) require.cache[servicePath] = originalService;

    if (originalNews) {
      require.cache[newsPath] = originalNews;
    } else {
      delete require.cache[newsPath];
    }

    if (originalSyncService) {
      require.cache[syncServicePath] = originalSyncService;
    } else {
      delete require.cache[syncServicePath];
    }
  }
});