const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

process.env.NODE_ENV = 'test';

const Contributor = require('../models/Contributor');
const PublicArticle = require('../models/Article');
const adminContributorRouter = require('../routes/adminPulseDialogueContributors.routes');
const {
  buildChildNewsSyncPatch,
} = require('../services/translationGroupSync.service');
const {
  buildPublicContributor,
  getPulseDialogueStandardText,
  normalizePulseDialoguePayload,
  preparePulseDialogueForPublication,
} = require('../services/pulseDialogue.service');
const { syncPublicArticleFromNews } = require('../services/syncPublicArticleFromNews.service');

const APPROVED_PULSE_DIALOGUE_TEXT = {
  en: {
    contributorDisclosure: 'This article is a contributor submission published after editorial review by News Pulse.',
    contributorDisclaimer: 'The views expressed in this contribution are those of the author and do not necessarily reflect the views of News Pulse.',
  },
  hi: {
    contributorDisclosure: "यह लेख 'न्यूज़ पल्स' द्वारा संपादकीय समीक्षा के बाद प्रकाशित एक प्रस्तुति है।",
    contributorDisclaimer: "इसमें व्यक्त किए गए विचार लेखक के हैं और ज़रूरी नहीं कि वे 'न्यूज़ पल्स' के विचारों को दर्शाते हों।",
  },
  gu: {
    contributorDisclosure: 'આ લેખ ન્યૂઝ પલ્સની સંપાદકીય સમીક્ષા બાદ વાચકો સમક્ષ પ્રસ્તુત કરવામાં આવ્યો છે',
    contributorDisclaimer: 'આ લેખમાં વ્યક્ત કરાયેલા વિચારો લેખકના વ્યક્તિગત અભિપ્રાયો છે અને ન્યૂઝ પલ્સ તેની સાથે સહમત હોય તે જરૂરી નથી.',
  },
};

function makeOpaqueAdminToken(email = 'admin@newspulse.ai') {
  const b64 = Buffer.from(`${email}:0`, 'utf8').toString('base64');
  return `np.${b64}`;
}

function makeAdminContributorApp() {
  const app = express();
  app.use(express.json());
  app.use('/contributors', adminContributorRouter);
  app.use((err, _req, res, _next) => res.status(500).json({ ok: false, message: err?.message || String(err) }));
  return app;
}

function restoreModel(target, values) {
  for (const [key, value] of Object.entries(values)) target[key] = value;
}

test('Contributor model applies safe defaults and validates approved enums', async () => {
  const contributor = new Contributor({
    canonicalName: 'Dr. Anil Mehta',
    publicDesignation: 'Professor of Political Science',
  });

  await contributor.validate();

  assert.equal(contributor.slug, 'dr-anil-mehta');
  assert.equal(contributor.status, 'draft');
  assert.equal(contributor.contributorType, 'guest_contributor');

  contributor.contributorType = 'invalid_type';
  await assert.rejects(() => contributor.validate(), /invalid_type/);
});

test('admin Contributor API requires admin auth and creates contributors', async () => {
  const originals = { create: Contributor.create };
  const id = '507f1f77bcf86cd799439a01';

  try {
    Contributor.create = async (payload) => ({
      _id: id,
      ...payload,
      toObject() { return { _id: id, ...payload }; },
    });

    const app = makeAdminContributorApp();
    const denied = await request(app).post('/contributors').send({ canonicalName: 'Denied' });
    assert.equal(denied.statusCode, 401);

    const res = await request(app)
      .post('/contributors')
      .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
      .send({
        canonicalName: 'Guest Writer',
        contributorType: 'writer',
        publicDesignation: 'Essayist',
        internalEmail: 'writer@example.test',
      });

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.contributor.canonicalName, 'Guest Writer');
    assert.equal(res.body.contributor.contributorType, 'writer');
    assert.equal(res.body.contributor.internalEmail, 'writer@example.test');
    assert.equal(res.body.contributor.publicContributor.internalEmail, undefined);
  } finally {
    restoreModel(Contributor, originals);
  }
});

test('Pulse Dialogue payload accepts only approved dialogue formats for Pulse articles', () => {
  const valid = normalizePulseDialoguePayload({
    pulseDialogue: {
      contributorId: '507f1f77bcf86cd799439a02',
      dialogueFormat: 'essay',
      series: 'Ideas & Society',
    },
  }, { category: 'pulse-dialogue' });

  assert.equal(valid.ok, true);
  assert.equal(valid.value.dialogueFormat, 'essay');

  const invalid = normalizePulseDialoguePayload({
    pulseDialogue: {
      contributorId: '507f1f77bcf86cd799439a02',
      dialogueFormat: 'news_report',
    },
  }, { category: 'pulse-dialogue' });

  assert.equal(invalid.ok, false);
  assert.match(invalid.message, /dialogueFormat/);
});

test('Pulse Dialogue standard text helper returns exact approved EN HI GU copy', () => {
  for (const lang of ['en', 'hi', 'gu']) {
    const standard = getPulseDialogueStandardText(lang);
    assert.equal(standard.contributorDisclosure, APPROVED_PULSE_DIALOGUE_TEXT[lang].contributorDisclosure);
    assert.equal(standard.contributorDisclaimer, APPROVED_PULSE_DIALOGUE_TEXT[lang].contributorDisclaimer);
  }
});

test('publish preparation builds language-aware byline snapshots and requires active contributors', async () => {
  const originals = { findById: Contributor.findById };
  const contributorId = '507f1f77bcf86cd799439a03';

  try {
    Contributor.findById = () => ({
      lean: async () => ({
        _id: contributorId,
        canonicalName: 'Dr. Anil Mehta',
        displayNameHi: 'डॉ. अनिल मेहता',
        publicDesignation: 'Professor',
        affiliation: 'Gujarat University',
        status: 'active',
        internalEmail: 'private@example.test',
      }),
    });

    const doc = {
      category: 'pulse-dialogue',
      language: 'hi',
      pulseDialogue: {
        contributorId,
        dialogueFormat: 'essay',
        bylineDesignationOverride: 'Visiting Professor',
        contributorDisclosure: 'Custom disclosure must not publish',
        editorNote: 'Article-specific editor note',
        contributorDisclaimer: 'Custom disclaimer must not publish',
      },
    };

    await preparePulseDialogueForPublication(doc);
    const standard = getPulseDialogueStandardText('hi');
    assert.equal(doc.pulseDialogue.bylineSnapshot.name, 'डॉ. अनिल मेहता');
    assert.equal(doc.pulseDialogue.bylineSnapshot.designation, 'Visiting Professor');
    assert.equal(doc.pulseDialogue.bylineSnapshot.affiliation, 'Gujarat University');
    assert.equal(doc.pulseDialogue.contributorDisclosure, standard.contributorDisclosure);
    assert.equal(doc.pulseDialogue.contributorDisclaimer, standard.contributorDisclaimer);
    assert.equal(doc.pulseDialogue.editorNote, 'Article-specific editor note');

    Contributor.findById = () => ({
      lean: async () => ({ _id: contributorId, canonicalName: 'Inactive Writer', status: 'inactive' }),
    });

    await assert.rejects(
      () => preparePulseDialogueForPublication({
        category: 'pulse-dialogue',
        language: 'en',
        pulseDialogue: { contributorId, dialogueFormat: 'essay' },
      }),
      /activeContributor/
    );
  } finally {
    restoreModel(Contributor, originals);
  }
});

test('News to public Article sync copies only public-safe Pulse Dialogue data', async () => {
  const contributorId = '507f1f77bcf86cd799439a04';
  const originals = {
    contributorFindById: Contributor.findById,
    publicFindOneAndUpdate: PublicArticle.findOneAndUpdate,
  };
  let capturedUpdate = null;

  try {
    Contributor.findById = () => ({
      lean: async () => ({
        _id: contributorId,
        canonicalName: 'Public Writer',
        publicDesignation: 'Columnist',
        affiliation: 'News Pulse Forum',
        shortBio: 'Writes on public policy.',
        status: 'active',
        photo: { url: 'https://cdn.example.test/public-writer.jpg', publicId: 'public-writer-photo', alt: 'Public Writer portrait' },
        internalEmail: 'private@example.test',
        internalNotes: 'Do not publish',
        rightsConsent: { notes: 'private consent' },
      }),
    });
    PublicArticle.findOneAndUpdate = (_query, update) => {
      capturedUpdate = update;
      return { lean: async () => ({ _id: 'public-copy' }) };
    };

    const saved = await syncPublicArticleFromNews({
      _id: '507f1f77bcf86cd799439b01',
      title: 'Pulse essay',
      description: 'Summary',
      content: '<p>Body</p>',
      slug: 'pulse-essay',
      category: 'pulse-dialogue',
      status: 'published',
      language: 'en',
      lang: 'en',
      originalLang: 'en',
      pulseDialogue: {
        contributorId,
        dialogueFormat: 'essay',
        bylineSnapshot: { name: 'Public Writer', designation: 'Columnist', affiliation: 'News Pulse Forum' },
        contributorDisclosure: 'Custom disclosure must not sync',
        editorNote: 'Public article-specific editor note',
        contributorDisclaimer: 'Custom disclaimer must not sync',
        showAboutContributor: true,
      },
    });

    assert.equal(saved._id, 'public-copy');
    const standard = getPulseDialogueStandardText('en');
    const pulse = capturedUpdate.$set.pulseDialogue;
    assert.equal(pulse.contributorId, contributorId);
    assert.equal(pulse.dialogueFormat, 'essay');
    assert.equal(pulse.contributorDisclosure, standard.contributorDisclosure);
    assert.equal(pulse.contributorDisclaimer, standard.contributorDisclaimer);
    assert.equal(pulse.editorNote, 'Public article-specific editor note');
    assert.equal(pulse.contributor.name, 'Public Writer');
    assert.equal(pulse.contributor.shortBio, 'Writes on public policy.');
    assert.deepEqual(pulse.contributor.photo, { url: 'https://cdn.example.test/public-writer.jpg', publicId: 'public-writer-photo', alt: 'Public Writer portrait' });
    assert.deepEqual(pulse.bylineSnapshot.photo, { url: 'https://cdn.example.test/public-writer.jpg', publicId: 'public-writer-photo', alt: 'Public Writer portrait' });
    assert.equal(pulse.contributor.internalEmail, undefined);
    assert.equal(pulse.contributor.internalNotes, undefined);
    assert.equal(pulse.contributor.rightsConsent, undefined);
  } finally {
    Contributor.findById = originals.contributorFindById;
    PublicArticle.findOneAndUpdate = originals.publicFindOneAndUpdate;
  }
});

test('translation group child sync preserves Pulse Dialogue contributor identity', () => {
  const contributorId = '507f1f77bcf86cd799439a05';
  const patch = buildChildNewsSyncPatch(
    {
      _id: '507f1f77bcf86cd799439c01',
      title: 'Master',
      description: 'Summary',
      content: '<p>Body</p>',
      slug: 'master',
      category: 'pulse-dialogue',
      status: 'draft',
      language: 'en',
      lang: 'en',
      originalLang: 'en',
      translationGroupId: 'pulse-group-1',
      pulseDialogue: {
        contributorId,
        dialogueFormat: 'essay',
        series: 'Ideas',
        contributorDisclosure: 'Source custom disclosure',
        editorNote: 'Child-specific editor note source copy',
        contributorDisclaimer: 'Source custom disclaimer',
        bylineSnapshot: { name: 'Source Writer', designation: 'Essayist', affiliation: 'Forum' },
      },
    },
    {
      _id: '507f1f77bcf86cd799439c02',
      sourceArticleId: '507f1f77bcf86cd799439c01',
      language: 'hi',
      lang: 'hi',
      slug: 'master-hi',
    }
  );

  const standard = getPulseDialogueStandardText('hi');
  assert.equal(String(patch.pulseDialogue.contributorId), contributorId);
  assert.equal(patch.pulseDialogue.dialogueFormat, 'essay');
  assert.equal(patch.pulseDialogue.series, 'Ideas');
  assert.equal(patch.pulseDialogue.contributorDisclosure, standard.contributorDisclosure);
  assert.equal(patch.pulseDialogue.contributorDisclaimer, standard.contributorDisclaimer);
  assert.equal(patch.pulseDialogue.editorNote, 'Child-specific editor note source copy');
  assert.equal(patch.pulseDialogue.bylineSnapshot.name, 'Source Writer');
});

test('public contributor DTO excludes private Contributor fields', () => {
  const dto = buildPublicContributor({
    _id: '507f1f77bcf86cd799439a06',
    canonicalName: 'Safe Writer',
    publicDesignation: 'Researcher',
    internalEmail: 'private@example.test',
    internalNotes: 'private',
    rightsConsent: { notes: 'private' },
  }, 'en');

  assert.equal(dto.name, 'Safe Writer');
  assert.equal(dto.publicDesignation, 'Researcher');
  assert.equal(dto.internalEmail, undefined);
  assert.equal(dto.internalNotes, undefined);
  assert.equal(dto.rightsConsent, undefined);
});