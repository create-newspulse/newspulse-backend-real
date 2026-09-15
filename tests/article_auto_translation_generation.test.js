const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.GOOGLE_TRANSLATE_API_KEY = process.env.GOOGLE_TRANSLATE_API_KEY || 'test-key';

const News = require('../models/News');
const app = require('../server');
const googleTranslation = require('../services/googleTranslationService');
const {
  generateArticleTranslations,
} = require('../services/articleTranslationGeneration.service');

function restore(originals) {
  for (const [key, value] of Object.entries(originals)) News[key] = value;
}

function makeSource(overrides = {}) {
  return {
    _id: '507f1f77bcf86cd799439501',
    title: 'News Pulse launches AIRA',
    description: 'AIRA summary with https://newspulse.ai and #NewsPulse',
    content: '<p>News Pulse story with <a href="https://newspulse.ai">link</a>.</p>',
    slug: 'news-pulse-launches-aira',
    slugs: { en: 'news-pulse-launches-aira' },
    category: 'national',
    tags: ['tech'],
    status: 'draft',
    lang: 'en',
    language: 'en',
    originalLang: 'en',
    translationGroupId: 'grp-auto-1',
    translationKey: 'grp-auto-1',
    coverImage: { url: '/uploads/a.jpg', alt: 'AIRA logo' },
    seo: { metaTitle: 'SEO title', metaDescription: 'SEO description' },
    ...overrides,
  };
}

function makeOpaqueAdminToken(email = 'admin@newspulse.ai') {
  const b64 = Buffer.from(`${email}:0`, 'utf8').toString('base64');
  return `np.${b64}`;
}

function makeOpaqueFounderToken() {
  return makeOpaqueAdminToken('founder@example.com');
}

function makeInlineImageBlock(overrides = {}) {
  const mediaId = overrides.mediaId || '507f1f77bcf86cd799439811';
  const src = overrides.src || 'https://res.cloudinary.com/demo/image/upload/v1/newspulse/media-library/inline.jpg';
  const caption = overrides.caption || 'Caption to preserve';
  const credit = overrides.credit || 'News Pulse Photo Desk';
  const width = overrides.width || 1200;
  const height = overrides.height || 675;
  return `<figure data-np-block="inline-image" data-np-media-id="${mediaId}" data-np-width="${width}" data-np-height="${height}"><img src="${src}" alt="Inline newsroom image" width="${width}" height="${height}"><figcaption data-np-caption="true">${caption}</figcaption><div data-np-credit="true">Credit: ${credit}</div></figure>`;
}

function makeLegacyInlineImageBlock() {
  return '<figure data-np-inline-image="true" data-media-id="legacy-media-1"><img src="https://res.cloudinary.com/demo/image/upload/v1/legacy.jpg" alt="Legacy inline image"><figcaption>Legacy caption</figcaption></figure>';
}

function makeYouTubeBlock(overrides = {}) {
  const videoId = overrides.videoId || 'SLDHOwReM-Q';
  const url = overrides.url || `https://www.youtube.com/watch?v=${videoId}`;
  return `<div data-np-block="youtube" data-np-video-id="${videoId}" data-np-url="${url}"></div>`;
}

function makeXBlock(overrides = {}) {
  const postId = overrides.postId || '1766401130046488732';
  const username = overrides.username || 'NewsPulseAI';
  const url = overrides.url || `https://x.com/${username}/status/${postId}`;
  return `<div data-np-block="x" data-np-post-id="${postId}" data-np-url="${url}"></div>`;
}

function makeInstagramBlock(overrides = {}) {
  const shortcode = overrides.shortcode || 'Cabc_123-def';
  const url = overrides.url || `https://www.instagram.com/p/${shortcode}/`;
  return `<div data-np-block="instagram" data-np-shortcode="${shortcode}" data-np-url="${url}"></div>`;
}

function countOccurrences(text, needle) {
  return String(text || '').split(needle).length - 1;
}

test('googleTranslationService preserves protected terms, URLs, hashtags, and retries temporary errors', async () => {
  let calls = 0;
  const fetchImpl = async (_url, opts) => {
    calls += 1;
    if (calls === 1) {
      return { ok: false, status: 429, json: async () => ({ error: { message: 'rate limit' } }) };
    }
    const body = JSON.parse(String(opts.body || '{}'));
    const q = Array.isArray(body.q) ? body.q : [];
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { translations: q.map((item) => ({ translatedText: `હેલો ${item}` })) } }),
    };
  };

  const res = await googleTranslation.translateText(
    '<p>News Pulse and AIRA visit https://newspulse.ai #NewsPulse</p>',
    'en',
    'gu',
    { format: 'html', fetchImpl, maxRetries: 1 }
  );

  assert.equal(res.ok, true);
  assert.equal(calls, 2);
  assert.match(res.text, /<p>/);
  assert.match(res.text, /News Pulse/);
  assert.match(res.text, /AIRA/);
  assert.match(res.text, /https:\/\/newspulse\.ai/);
  assert.match(res.text, /#NewsPulse/);
});

test('googleTranslationService chunks long HTML and reassembles in order', async () => {
  const chunks = [];
  const fetchImpl = async (_url, opts) => {
    const body = JSON.parse(String(opts.body || '{}'));
    const q = Array.isArray(body.q) ? body.q : [];
    chunks.push(...q);
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { translations: q.map((item) => ({ translatedText: `[${item.slice(0, 4)}]` })) } }),
    };
  };
  const html = Array.from({ length: 30 }, (_, index) => `<p>Paragraph ${index} with News Pulse content.</p>`).join('');
  const res = await googleTranslation.translateText(html, 'en', 'hi', { format: 'html', maxChars: 180, fetchImpl });
  assert.equal(res.ok, true);
  assert.ok(chunks.length > 1);
  assert.equal(res.text, chunks.map((item) => `[${item.slice(0, 4)}]`).join(''));
});

test('googleTranslationService preserves News Pulse controlled inline image blocks through HTML translation', async () => {
  const imageBlock = makeInlineImageBlock();
  const html = `<p>Before image text.</p>${imageBlock}<p>After image text.</p>`;
  const fetchImpl = async (_url, opts) => {
    const body = JSON.parse(String(opts.body || '{}'));
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { translations: body.q.map((q) => ({ translatedText: q.replace('Before image text.', 'Translated before.').replace('After image text.', 'Translated after.') })) } }),
    };
  };

  for (const targetLang of ['hi', 'gu']) {
    const res = await googleTranslation.translateText(html, 'en', targetLang, { format: 'html', fetchImpl });

    assert.equal(res.ok, true);
    assert.equal(countOccurrences(res.text, 'data-np-block="inline-image"'), 1);
    assert.equal(countOccurrences(res.text, 'data-np-media-id="507f1f77bcf86cd799439811"'), 1);
    assert.equal(countOccurrences(res.text, 'https://res.cloudinary.com/demo/image/upload/v1/newspulse/media-library/inline.jpg'), 1);
    assert.equal(countOccurrences(res.text, 'data-np-width="1200"'), 1);
    assert.equal(countOccurrences(res.text, 'data-np-height="675"'), 1);
    assert.match(res.text, /<img[^>]+width="1200"[^>]+height="675"/);
    assert.ok(res.text.indexOf('<p>Translated before.</p>') < res.text.indexOf(imageBlock));
    assert.ok(res.text.indexOf(imageBlock) < res.text.indexOf('<p>Translated after.</p>'));
    assert.match(res.text, /<figcaption data-np-caption="true">Caption to preserve<\/figcaption>/);
    assert.match(res.text, /<div data-np-credit="true">Credit: News Pulse Photo Desk<\/div>/);
  }
});

test('googleTranslationService detects canonical inline image blocks before provider translation', () => {
  const imageBlock = makeInlineImageBlock();
  const protectedResult = googleTranslation.protectNewsPulseInlineImageBlocks(`<p>A</p>${imageBlock}<p>B</p>`);

  assert.equal(protectedResult.map.size, 1);
  assert.match(protectedResult.text, /__NP_INLINE_IMAGE_BLOCK_0__/);
  assert.equal(protectedResult.map.get('__NP_INLINE_IMAGE_BLOCK_0__'), imageBlock);
});

test('googleTranslationService detects canonical YouTube blocks before provider translation', () => {
  const youtubeBlock = makeYouTubeBlock();
  const protectedResult = googleTranslation.protectNewsPulseYouTubeBlocks(`<p>A</p>${youtubeBlock}<p>B</p>`);

  assert.equal(protectedResult.map.size, 1);
  assert.match(protectedResult.text, /__NP_YOUTUBE_BLOCK_0__/);
  assert.equal(protectedResult.map.get('__NP_YOUTUBE_BLOCK_0__'), youtubeBlock);
});

test('googleTranslationService recognizes supported YouTube URL forms for controlled blocks', () => {
  const blocks = [
    makeYouTubeBlock({ url: 'https://youtube.com/watch?v=SLDHOwReM-Q' }),
    makeYouTubeBlock({ url: 'https://www.youtube.com/watch?v=SLDHOwReM-Q' }),
    makeYouTubeBlock({ url: 'https://youtu.be/SLDHOwReM-Q' }),
    makeYouTubeBlock({ url: 'https://youtube.com/shorts/SLDHOwReM-Q' }),
    makeYouTubeBlock({ url: 'https://www.youtube-nocookie.com/embed/SLDHOwReM-Q' }),
  ];

  for (const block of blocks) {
    const protectedResult = googleTranslation.protectNewsPulseYouTubeBlocks(block);
    assert.equal(protectedResult.map.size, 1);
    assert.equal(protectedResult.map.get('__NP_YOUTUBE_BLOCK_0__'), block);
  }
});

test('googleTranslationService preserves News Pulse controlled YouTube blocks through Hindi and Gujarati HTML translation', async () => {
  const youtubeBlock = makeYouTubeBlock({ videoId: 'SLDHOwReM-Q', url: 'https://youtu.be/SLDHOwReM-Q' });
  const html = `<p>Before video text.</p>${youtubeBlock}<p>After video text.</p>`;
  const fetchImpl = async (_url, opts) => {
    const body = JSON.parse(String(opts.body || '{}'));
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { translations: body.q.map((q) => ({ translatedText: q.replace('Before video text.', 'Translated before video.').replace('After video text.', 'Translated after video.') })) } }),
    };
  };

  for (const targetLang of ['hi', 'gu']) {
    const res = await googleTranslation.translateText(html, 'en', targetLang, { format: 'html', fetchImpl });

    assert.equal(res.ok, true);
    assert.equal(countOccurrences(res.text, 'data-np-block="youtube"'), 1);
    assert.equal(countOccurrences(res.text, 'data-np-video-id="SLDHOwReM-Q"'), 1);
    assert.equal(countOccurrences(res.text, 'data-np-url="https://youtu.be/SLDHOwReM-Q"'), 1);
    assert.ok(res.text.indexOf('<p>Translated before video.</p>') < res.text.indexOf(youtubeBlock));
    assert.ok(res.text.indexOf(youtubeBlock) < res.text.indexOf('<p>Translated after video.</p>'));
  }
});

test('googleTranslationService detects canonical X blocks before provider translation', () => {
  const xBlock = makeXBlock();
  const protectedResult = googleTranslation.protectNewsPulseXBlocks(`<p>A</p>${xBlock}<p>B</p>`);

  assert.equal(protectedResult.map.size, 1);
  assert.match(protectedResult.text, /__NP_X_BLOCK_0__/);
  assert.equal(protectedResult.map.get('__NP_X_BLOCK_0__'), xBlock);
});

test('googleTranslationService recognizes supported X URL forms for controlled blocks', () => {
  const postId = '1766401130046488732';
  const blocks = [
    makeXBlock({ postId, url: `https://x.com/NewsPulseAI/status/${postId}` }),
    makeXBlock({ postId, url: `https://www.x.com/NewsPulseAI/status/${postId}` }),
    makeXBlock({ postId, url: `https://twitter.com/NewsPulseAI/status/${postId}` }),
    makeXBlock({ postId, url: `https://www.twitter.com/NewsPulseAI/status/${postId}` }),
    makeXBlock({ postId, url: `https://x.com/NewsPulseAI/status/${postId}?s=20` }),
  ];

  for (const block of blocks) {
    const protectedResult = googleTranslation.protectNewsPulseXBlocks(block);
    assert.equal(protectedResult.map.size, 1);
    assert.equal(protectedResult.map.get('__NP_X_BLOCK_0__'), block);
  }
});

test('googleTranslationService preserves News Pulse controlled X blocks through English, Hindi, and Gujarati HTML translation', async () => {
  const xBlock = makeXBlock({ url: 'https://twitter.com/NewsPulseAI/status/1766401130046488732?s=20' });
  const html = `<p>Before X post.</p>${xBlock}<p>After X post.</p>`;
  const fetchImpl = async (_url, opts) => {
    const body = JSON.parse(String(opts.body || '{}'));
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { translations: body.q.map((q) => ({ translatedText: q.replace('Before X post.', `${body.target}:Before X post.`).replace('After X post.', `${body.target}:After X post.`) })) } }),
    };
  };

  for (const targetLang of ['en', 'hi', 'gu']) {
    const res = await googleTranslation.translateText(html, 'en', targetLang, { format: 'html', fetchImpl });

    assert.equal(res.ok, true);
    assert.equal(countOccurrences(res.text, 'data-np-block="x"'), 1);
    assert.equal(countOccurrences(res.text, 'data-np-post-id="1766401130046488732"'), 1);
    assert.equal(countOccurrences(res.text, 'data-np-url="https://twitter.com/NewsPulseAI/status/1766401130046488732?s=20"'), 1);
    assert.ok(res.text.indexOf(`<p>${targetLang}:Before X post.</p>`) < res.text.indexOf(xBlock));
    assert.ok(res.text.indexOf(xBlock) < res.text.indexOf(`<p>${targetLang}:After X post.</p>`));
  }
});

test('googleTranslationService preserves multiple X blocks in their individual positions without duplication', async () => {
  const firstBlock = makeXBlock({ postId: '1766401130046488732', url: 'https://x.com/NewsPulseAI/status/1766401130046488732' });
  const secondBlock = makeXBlock({ postId: '1766401130046488733', url: 'https://twitter.com/NewsPulseAI/status/1766401130046488733?s=20' });
  const html = `<p>Before first X.</p>${firstBlock}<p>Between X posts.</p>${secondBlock}<p>After second X.</p>`;
  const fetchImpl = async (_url, opts) => {
    const body = JSON.parse(String(opts.body || '{}'));
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { translations: body.q.map((q) => ({ translatedText: q.replace('Before first X.', 'Translated before first X.').replace('Between X posts.', 'Translated between X posts.').replace('After second X.', 'Translated after second X.') })) } }),
    };
  };

  const res = await googleTranslation.translateText(html, 'en', 'hi', { format: 'html', fetchImpl });

  assert.equal(res.ok, true);
  assert.equal(countOccurrences(res.text, 'data-np-block="x"'), 2);
  assert.equal(countOccurrences(res.text, 'data-np-post-id="1766401130046488732"'), 1);
  assert.equal(countOccurrences(res.text, 'data-np-post-id="1766401130046488733"'), 1);
  assert.ok(res.text.indexOf('<p>Translated before first X.</p>') < res.text.indexOf(firstBlock));
  assert.ok(res.text.indexOf(firstBlock) < res.text.indexOf('<p>Translated between X posts.</p>'));
  assert.ok(res.text.indexOf('<p>Translated between X posts.</p>') < res.text.indexOf(secondBlock));
  assert.ok(res.text.indexOf(secondBlock) < res.text.indexOf('<p>Translated after second X.</p>'));
});

test('googleTranslationService detects canonical Instagram blocks before provider translation', () => {
  const instagramBlock = makeInstagramBlock();
  const protectedResult = googleTranslation.protectNewsPulseInstagramBlocks(`<p>A</p>${instagramBlock}<p>B</p>`);

  assert.equal(protectedResult.map.size, 1);
  assert.match(protectedResult.text, /__NP_INSTAGRAM_BLOCK_0__/);
  assert.equal(protectedResult.map.get('__NP_INSTAGRAM_BLOCK_0__'), instagramBlock);
});

test('googleTranslationService recognizes supported Instagram URL forms for controlled blocks', () => {
  const shortcode = 'Cabc_123-def';
  const blocks = [
    makeInstagramBlock({ shortcode, url: `https://instagram.com/p/${shortcode}/` }),
    makeInstagramBlock({ shortcode, url: `https://www.instagram.com/p/${shortcode}/` }),
    makeInstagramBlock({ shortcode, url: `https://instagram.com/reel/${shortcode}/` }),
    makeInstagramBlock({ shortcode, url: `https://www.instagram.com/reel/${shortcode}/` }),
    makeInstagramBlock({ shortcode, url: `https://instagram.com/tv/${shortcode}/` }),
    makeInstagramBlock({ shortcode, url: `https://www.instagram.com/tv/${shortcode}/` }),
    makeInstagramBlock({ shortcode, url: `https://www.instagram.com/reel/${shortcode}/?igsh=abc123&utm_source=ig_web_copy_link` }),
  ];

  for (const block of blocks) {
    const protectedResult = googleTranslation.protectNewsPulseInstagramBlocks(block);
    assert.equal(protectedResult.map.size, 1);
    assert.equal(protectedResult.map.get('__NP_INSTAGRAM_BLOCK_0__'), block);
  }
});

test('googleTranslationService preserves News Pulse controlled Instagram blocks through English, Hindi, and Gujarati HTML translation', async () => {
  const instagramBlock = makeInstagramBlock({ shortcode: 'Cabc_123-def', url: 'https://www.instagram.com/reel/Cabc_123-def/?igsh=abc123' });
  const html = `<p>Before Instagram post.</p>${instagramBlock}<p>After Instagram post.</p>`;
  const fetchImpl = async (_url, opts) => {
    const body = JSON.parse(String(opts.body || '{}'));
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { translations: body.q.map((q) => ({ translatedText: q.replace('Before Instagram post.', `${body.target}:Before Instagram post.`).replace('After Instagram post.', `${body.target}:After Instagram post.`) })) } }),
    };
  };

  for (const targetLang of ['en', 'hi', 'gu']) {
    const res = await googleTranslation.translateText(html, 'en', targetLang, { format: 'html', fetchImpl });

    assert.equal(res.ok, true);
    assert.equal(countOccurrences(res.text, 'data-np-block="instagram"'), 1);
    assert.equal(countOccurrences(res.text, 'data-np-shortcode="Cabc_123-def"'), 1);
    assert.equal(countOccurrences(res.text, 'data-np-url="https://www.instagram.com/reel/Cabc_123-def/?igsh=abc123"'), 1);
    assert.equal(countOccurrences(res.text, instagramBlock), 1);
    assert.ok(res.text.indexOf(`<p>${targetLang}:Before Instagram post.</p>`) < res.text.indexOf(instagramBlock));
    assert.ok(res.text.indexOf(instagramBlock) < res.text.indexOf(`<p>${targetLang}:After Instagram post.</p>`));
  }
});

test('googleTranslationService preserves multiple Instagram blocks in their individual positions without duplication', async () => {
  const firstBlock = makeInstagramBlock({ shortcode: 'Cfirst_123', url: 'https://www.instagram.com/p/Cfirst_123/' });
  const secondBlock = makeInstagramBlock({ shortcode: 'Creel-456', url: 'https://instagram.com/reel/Creel-456/?utm_source=ig_web_copy_link' });
  const html = `<p>Before first Instagram.</p>${firstBlock}<p>Between Instagram posts.</p>${secondBlock}<p>After second Instagram.</p>`;
  const fetchImpl = async (_url, opts) => {
    const body = JSON.parse(String(opts.body || '{}'));
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { translations: body.q.map((q) => ({ translatedText: q.replace('Before first Instagram.', 'Translated before first Instagram.').replace('Between Instagram posts.', 'Translated between Instagram posts.').replace('After second Instagram.', 'Translated after second Instagram.') })) } }),
    };
  };

  const res = await googleTranslation.translateText(html, 'en', 'hi', { format: 'html', fetchImpl });

  assert.equal(res.ok, true);
  assert.equal(countOccurrences(res.text, 'data-np-block="instagram"'), 2);
  assert.equal(countOccurrences(res.text, 'data-np-shortcode="Cfirst_123"'), 1);
  assert.equal(countOccurrences(res.text, 'data-np-shortcode="Creel-456"'), 1);
  assert.equal(countOccurrences(res.text, firstBlock), 1);
  assert.equal(countOccurrences(res.text, secondBlock), 1);
  assert.ok(res.text.indexOf('<p>Translated before first Instagram.</p>') < res.text.indexOf(firstBlock));
  assert.ok(res.text.indexOf(firstBlock) < res.text.indexOf('<p>Translated between Instagram posts.</p>'));
  assert.ok(res.text.indexOf('<p>Translated between Instagram posts.</p>') < res.text.indexOf(secondBlock));
  assert.ok(res.text.indexOf(secondBlock) < res.text.indexOf('<p>Translated after second Instagram.</p>'));
});

test('googleTranslationService does not preserve invalid or raw Instagram embeds as controlled Instagram blocks', () => {
  const malformedShortcode = '<div data-np-block="instagram" data-np-shortcode="bad.shortcode" data-np-url="https://www.instagram.com/p/bad.shortcode/"></div>';
  const mismatchedUrl = '<div data-np-block="instagram" data-np-shortcode="Cabc_123-def" data-np-url="https://www.instagram.com/p/Cother_123/"></div>';
  const lookalikeDomain = '<div data-np-block="instagram" data-np-shortcode="Cabc_123-def" data-np-url="https://instagram.com.example.com/p/Cabc_123-def/"></div>';
  const arbitraryDomain = '<div data-np-block="instagram" data-np-shortcode="Cabc_123-def" data-np-url="https://example.com/p/Cabc_123-def/"></div>';
  const javascriptUrl = '<div data-np-block="instagram" data-np-shortcode="Cabc_123-def" data-np-url="javascript:alert(1)"></div>';
  const dataUrl = '<div data-np-block="instagram" data-np-shortcode="Cabc_123-def" data-np-url="data:text/html;base64,PHNjcmlwdD48L3NjcmlwdD4="></div>';
  const profileUrl = '<div data-np-block="instagram" data-np-shortcode="Cabc_123-def" data-np-url="https://www.instagram.com/newspulseai/"></div>';
  const storyUrl = '<div data-np-block="instagram" data-np-shortcode="Cabc_123-def" data-np-url="https://www.instagram.com/stories/newspulseai/Cabc_123-def/"></div>';
  const exploreUrl = '<div data-np-block="instagram" data-np-shortcode="Cabc_123-def" data-np-url="https://www.instagram.com/explore/tags/news/"></div>';
  const extraPathSegment = '<div data-np-block="instagram" data-np-shortcode="Cabc_123-def" data-np-url="https://www.instagram.com/p/Cabc_123-def/extra/"></div>';
  const uppercasePath = '<div data-np-block="instagram" data-np-shortcode="Cabc_123-def" data-np-url="https://www.instagram.com/P/Cabc_123-def/"></div>';
  const missingTrailingSlash = '<div data-np-block="instagram" data-np-shortcode="Cabc_123-def" data-np-url="https://www.instagram.com/p/Cabc_123-def"></div>';
  const fragmentUrl = '<div data-np-block="instagram" data-np-shortcode="Cabc_123-def" data-np-url="https://www.instagram.com/p/Cabc_123-def/#comments"></div>';
  const arbitraryBlock = '<div data-np-block="instagram-post" data-np-shortcode="Cabc_123-def" data-np-url="https://www.instagram.com/p/Cabc_123-def/"></div>';
  const rawBlockquote = '<blockquote class="instagram-media" data-instgrm-permalink="https://www.instagram.com/p/Cabc_123-def/"></blockquote>';
  const rawScript = '<script async src="https://www.instagram.com/embed.js"></script>';

  for (const block of [malformedShortcode, mismatchedUrl, lookalikeDomain, arbitraryDomain, javascriptUrl, dataUrl, profileUrl, storyUrl, exploreUrl, extraPathSegment, uppercasePath, missingTrailingSlash, fragmentUrl, arbitraryBlock, rawBlockquote, rawScript]) {
    const protectedResult = googleTranslation.protectNewsPulseInstagramBlocks(`<p>A</p>${block}<p>B</p>`);
    assert.equal(protectedResult.map.size, 0);
    assert.equal(protectedResult.text, `<p>A</p>${block}<p>B</p>`);
  }
});

test('googleTranslationService does not preserve invalid or raw X embeds as controlled X blocks', () => {
  const invalidId = '<div data-np-block="x" data-np-post-id="not-valid" data-np-url="https://x.com/NewsPulseAI/status/not-valid"></div>';
  const zeroId = '<div data-np-block="x" data-np-post-id="0" data-np-url="https://x.com/NewsPulseAI/status/0"></div>';
  const mismatchedUrl = '<div data-np-block="x" data-np-post-id="1766401130046488732" data-np-url="https://x.com/NewsPulseAI/status/1766401130046488733"></div>';
  const missingStatus = '<div data-np-block="x" data-np-post-id="1766401130046488732" data-np-url="https://x.com/NewsPulseAI/1766401130046488732"></div>';
  const lookalikeXDomain = '<div data-np-block="x" data-np-post-id="1766401130046488732" data-np-url="https://x.com.example.com/NewsPulseAI/status/1766401130046488732"></div>';
  const lookalikeTwitterDomain = '<div data-np-block="x" data-np-post-id="1766401130046488732" data-np-url="https://twitter.com.example.com/NewsPulseAI/status/1766401130046488732"></div>';
  const arbitraryDomain = '<div data-np-block="x" data-np-post-id="1766401130046488732" data-np-url="https://example.com/NewsPulseAI/status/1766401130046488732"></div>';
  const javascriptUrl = '<div data-np-block="x" data-np-post-id="1766401130046488732" data-np-url="javascript:alert(1)"></div>';
  const dataUrl = '<div data-np-block="x" data-np-post-id="1766401130046488732" data-np-url="data:text/html;base64,PHNjcmlwdD48L3NjcmlwdD4="></div>';
  const arbitraryBlock = '<div data-np-block="twitter" data-np-post-id="1766401130046488732" data-np-url="https://x.com/NewsPulseAI/status/1766401130046488732"></div>';
  const rawBlockquote = '<blockquote class="twitter-tweet"><a href="https://x.com/NewsPulseAI/status/1766401130046488732"></a></blockquote>';
  const rawScript = '<script async src="https://platform.twitter.com/widgets.js"></script>';

  for (const block of [invalidId, zeroId, mismatchedUrl, missingStatus, lookalikeXDomain, lookalikeTwitterDomain, arbitraryDomain, javascriptUrl, dataUrl, arbitraryBlock, rawBlockquote, rawScript]) {
    const protectedResult = googleTranslation.protectNewsPulseXBlocks(`<p>A</p>${block}<p>B</p>`);
    assert.equal(protectedResult.map.size, 0);
    assert.equal(protectedResult.text, `<p>A</p>${block}<p>B</p>`);
  }
});

test('googleTranslationService does not preserve invalid or non-YouTube data-np blocks as controlled YouTube', () => {
  const invalidId = '<div data-np-block="youtube" data-np-video-id="not-valid" data-np-url="https://www.youtube.com/watch?v=not-valid"></div>';
  const missingUrl = '<div data-np-block="youtube" data-np-video-id="SLDHOwReM-Q"></div>';
  const wrongCaseBlock = '<div data-np-block="YouTube" data-np-video-id="SLDHOwReM-Q" data-np-url="https://www.youtube.com/watch?v=SLDHOwReM-Q"></div>';
  const unsupportedUrl = '<div data-np-block="youtube" data-np-video-id="SLDHOwReM-Q" data-np-url="https://example.com/watch?v=SLDHOwReM-Q"></div>';
  const lookalikeDomain = '<div data-np-block="youtube" data-np-video-id="SLDHOwReM-Q" data-np-url="https://youtube.com.example.test/watch?v=SLDHOwReM-Q"></div>';
  const javascriptUrl = '<div data-np-block="youtube" data-np-video-id="SLDHOwReM-Q" data-np-url="javascript:alert(1)"></div>';
  const dataUrl = '<div data-np-block="youtube" data-np-video-id="SLDHOwReM-Q" data-np-url="data:text/html;base64,PHNjcmlwdD48L3NjcmlwdD4="></div>';
  const mismatchedUrl = '<div data-np-block="youtube" data-np-video-id="SLDHOwReM-Q" data-np-url="https://www.youtube.com/watch?v=dQw4w9WgXcQ"></div>';
  const arbitraryBlock = '<div data-np-block="iframe" data-np-video-id="SLDHOwReM-Q" data-np-url="https://www.youtube.com/watch?v=SLDHOwReM-Q"></div>';
  const rawIframe = '<iframe src="https://www.youtube.com/embed/SLDHOwReM-Q"></iframe>';
  const rawScript = '<script src="https://www.youtube.com/iframe_api"></script>';

  for (const block of [invalidId, missingUrl, wrongCaseBlock, unsupportedUrl, lookalikeDomain, javascriptUrl, dataUrl, mismatchedUrl, arbitraryBlock, rawIframe, rawScript]) {
    const protectedResult = googleTranslation.protectNewsPulseYouTubeBlocks(`<p>A</p>${block}<p>B</p>`);
    assert.equal(protectedResult.map.size, 0);
    assert.equal(protectedResult.text, `<p>A</p>${block}<p>B</p>`);
  }
});

test('googleTranslationService preserves multiple YouTube blocks in their individual positions', async () => {
  const firstBlock = makeYouTubeBlock({ videoId: 'SLDHOwReM-Q', url: 'https://www.youtube.com/watch?v=SLDHOwReM-Q' });
  const secondBlock = makeYouTubeBlock({ videoId: 'dQw4w9WgXcQ', url: 'https://youtu.be/dQw4w9WgXcQ' });
  const html = `<p>Before first.</p>${firstBlock}<p>Between videos.</p>${secondBlock}<p>After second.</p>`;
  const fetchImpl = async (_url, opts) => {
    const body = JSON.parse(String(opts.body || '{}'));
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { translations: body.q.map((q) => ({ translatedText: q.replace('Before first.', 'Translated before first.').replace('Between videos.', 'Translated between videos.').replace('After second.', 'Translated after second.') })) } }),
    };
  };

  const res = await googleTranslation.translateText(html, 'en', 'gu', { format: 'html', fetchImpl });

  assert.equal(res.ok, true);
  assert.equal(countOccurrences(res.text, 'data-np-block="youtube"'), 2);
  assert.equal(countOccurrences(res.text, 'data-np-video-id="SLDHOwReM-Q"'), 1);
  assert.equal(countOccurrences(res.text, 'data-np-video-id="dQw4w9WgXcQ"'), 1);
  assert.ok(res.text.indexOf('<p>Translated before first.</p>') < res.text.indexOf(firstBlock));
  assert.ok(res.text.indexOf(firstBlock) < res.text.indexOf('<p>Translated between videos.</p>'));
  assert.ok(res.text.indexOf('<p>Translated between videos.</p>') < res.text.indexOf(secondBlock));
  assert.ok(res.text.indexOf(secondBlock) < res.text.indexOf('<p>Translated after second.</p>'));
});

test('googleTranslationService preserves legacy development inline image marker', async () => {
  const imageBlock = makeLegacyInlineImageBlock();
  const html = `<p>Before legacy.</p>${imageBlock}<p>After legacy.</p>`;
  const fetchImpl = async (_url, opts) => {
    const body = JSON.parse(String(opts.body || '{}'));
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { translations: body.q.map((q) => ({ translatedText: q.replace('Before legacy.', 'Translated before legacy.').replace('After legacy.', 'Translated after legacy.') })) } }),
    };
  };

  const res = await googleTranslation.translateText(html, 'en', 'hi', { format: 'html', fetchImpl });

  assert.equal(res.ok, true);
  assert.equal(countOccurrences(res.text, 'data-np-inline-image="true"'), 1);
  assert.equal(countOccurrences(res.text, 'data-media-id="legacy-media-1"'), 1);
  assert.equal(countOccurrences(res.text, 'https://res.cloudinary.com/demo/image/upload/v1/legacy.jpg'), 1);
  assert.ok(res.text.indexOf('<p>Translated before legacy.</p>') < res.text.indexOf(imageBlock));
  assert.ok(res.text.indexOf(imageBlock) < res.text.indexOf('<p>Translated after legacy.</p>'));
});

test('googleTranslationService still translates normal article HTML around uncontrolled markup', async () => {
  const html = '<p>Normal intro.</p><figure><img src="https://example.com/plain.jpg" alt="Plain"><figcaption>Normal caption.</figcaption></figure><p>Normal outro.</p>';
  const fetchImpl = async (_url, opts) => {
    const body = JSON.parse(String(opts.body || '{}'));
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { translations: body.q.map((q) => ({ translatedText: q.replace('Normal intro.', 'Translated intro.').replace('Normal caption.', 'Translated caption.').replace('Normal outro.', 'Translated outro.') })) } }),
    };
  };

  const res = await googleTranslation.translateText(html, 'en', 'hi', { format: 'html', fetchImpl });

  assert.equal(res.ok, true);
  assert.match(res.text, /Translated intro/);
  assert.match(res.text, /Translated caption/);
  assert.match(res.text, /Translated outro/);
});

test('English article generates Hindi and Gujarati sibling drafts only', async () => {
  const originals = { findOne: News.findOne, create: News.create, updateOne: News.updateOne };
  const prevFetch = global.fetch;
  const created = [];

  try {
    News.findOne = async () => null;
    News.updateOne = async () => ({ acknowledged: true, modifiedCount: 1 });
    News.create = async (payload) => { created.push(payload); return { _id: `507f1f77bcf86cd7994395${created.length}1`, ...payload }; };
    global.fetch = async (_url, opts) => {
      const body = JSON.parse(String(opts.body || '{}'));
      return { ok: true, status: 200, json: async () => ({ data: { translations: body.q.map((q) => ({ translatedText: `T:${body.target}:${q}` })) } }) };
    };

    const res = await generateArticleTranslations(makeSource({ language: 'en', lang: 'en' }), { targetLanguages: ['en', 'hi', 'gu'] });
    assert.equal(res.ok, true);
    assert.deepEqual(Object.keys(res.created).sort(), ['gu', 'hi']);
    assert.deepEqual(created.map((item) => item.language).sort(), ['gu', 'hi']);
    assert.ok(created.every((item) => item.translationGroupId === 'grp-auto-1'));
    assert.ok(created.every((item) => item.status === 'draft'));
    assert.ok(created.every((item) => item.translationReviewStatus === 'review_required'));
  } finally {
    restore(originals);
    global.fetch = prevFetch;
  }
});

test('generated Hindi and Gujarati article translations preserve inline image media identity', async () => {
  const originals = { findOne: News.findOne, create: News.create, updateOne: News.updateOne };
  const prevFetch = global.fetch;
  const created = [];
  const imageBlock = makeInlineImageBlock();
  const sourceContent = `<p>Lead paragraph.</p>${imageBlock}<p>Closing paragraph.</p>`;

  try {
    News.findOne = async () => null;
    News.updateOne = async () => ({ acknowledged: true, modifiedCount: 1 });
    News.create = async (payload) => { created.push(payload); return { _id: `507f1f77bcf86cd7994398${created.length}1`, ...payload }; };
    global.fetch = async (_url, opts) => {
      const body = JSON.parse(String(opts.body || '{}'));
      return { ok: true, status: 200, json: async () => ({ data: { translations: body.q.map((q) => ({ translatedText: `${body.target}:${q}` })) } }) };
    };

    const res = await generateArticleTranslations(makeSource({ content: sourceContent, language: 'en', lang: 'en' }), { targetLanguages: ['hi', 'gu'] });
    assert.equal(res.ok, true);
    assert.deepEqual(created.map((item) => item.language).sort(), ['gu', 'hi']);

    for (const payload of created) {
      assert.equal(countOccurrences(payload.content, 'data-np-block="inline-image"'), 1);
      assert.equal(countOccurrences(payload.content, 'data-np-media-id="507f1f77bcf86cd799439811"'), 1);
      assert.equal(countOccurrences(payload.content, 'https://res.cloudinary.com/demo/image/upload/v1/newspulse/media-library/inline.jpg'), 1);
      assert.equal(countOccurrences(payload.content, 'data-np-width="1200"'), 1);
      assert.equal(countOccurrences(payload.content, 'data-np-height="675"'), 1);
      assert.match(payload.content, /<img[^>]+width="1200"[^>]+height="675"/);
      assert.ok(payload.content.indexOf(`${payload.language}:<p>Lead paragraph.</p>`) < payload.content.indexOf(imageBlock));
      assert.ok(payload.content.indexOf(imageBlock) < payload.content.indexOf('<p>Closing paragraph.</p>'));
      assert.match(payload.content, /<figcaption data-np-caption="true">Caption to preserve<\/figcaption>/);
      assert.match(payload.content, /<div data-np-credit="true">Credit: News Pulse Photo Desk<\/div>/);
    }
  } finally {
    restore(originals);
    global.fetch = prevFetch;
  }
});

test('generated Hindi and Gujarati article translations preserve controlled YouTube media identity', async () => {
  const originals = { findOne: News.findOne, create: News.create, updateOne: News.updateOne };
  const prevFetch = global.fetch;
  const created = [];
  const youtubeBlock = makeYouTubeBlock({ videoId: 'SLDHOwReM-Q', url: 'https://www.youtube.com/embed/SLDHOwReM-Q' });
  const sourceContent = `<p>Lead paragraph.</p>${youtubeBlock}<p>Closing paragraph.</p>`;

  try {
    News.findOne = async () => null;
    News.updateOne = async () => ({ acknowledged: true, modifiedCount: 1 });
    News.create = async (payload) => { created.push(payload); return { _id: `507f1f77bcf86cd7994399${created.length}1`, ...payload }; };
    global.fetch = async (_url, opts) => {
      const body = JSON.parse(String(opts.body || '{}'));
      return { ok: true, status: 200, json: async () => ({ data: { translations: body.q.map((q) => ({ translatedText: `${body.target}:${q}` })) } }) };
    };

    const res = await generateArticleTranslations(makeSource({ content: sourceContent, language: 'en', lang: 'en' }), { targetLanguages: ['hi', 'gu'] });
    assert.equal(res.ok, true);
    assert.deepEqual(created.map((item) => item.language).sort(), ['gu', 'hi']);

    for (const payload of created) {
      assert.equal(countOccurrences(payload.content, 'data-np-block="youtube"'), 1);
      assert.equal(countOccurrences(payload.content, 'data-np-video-id="SLDHOwReM-Q"'), 1);
      assert.equal(countOccurrences(payload.content, 'data-np-url="https://www.youtube.com/embed/SLDHOwReM-Q"'), 1);
      assert.ok(payload.content.indexOf(`${payload.language}:<p>Lead paragraph.</p>`) < payload.content.indexOf(youtubeBlock));
      assert.ok(payload.content.indexOf(youtubeBlock) < payload.content.indexOf('<p>Closing paragraph.</p>'));
    }
  } finally {
    restore(originals);
    global.fetch = prevFetch;
  }
});

test('generated Hindi and Gujarati article translations preserve controlled X post identity without creating media records', async () => {
  const originals = { findOne: News.findOne, create: News.create, updateOne: News.updateOne };
  const prevFetch = global.fetch;
  const created = [];
  const xBlock = makeXBlock({ postId: '1766401130046488732', url: 'https://www.x.com/NewsPulseAI/status/1766401130046488732?s=20' });
  const sourceContent = `<p>Lead paragraph.</p>${xBlock}<p>Closing paragraph.</p>`;

  try {
    News.findOne = async () => null;
    News.updateOne = async () => ({ acknowledged: true, modifiedCount: 1 });
    News.create = async (payload) => { created.push(payload); return { _id: `507f1f77bcf86cd7994300${created.length}1`, ...payload }; };
    global.fetch = async (_url, opts) => {
      const body = JSON.parse(String(opts.body || '{}'));
      return { ok: true, status: 200, json: async () => ({ data: { translations: body.q.map((q) => ({ translatedText: `${body.target}:${q}` })) } }) };
    };

    const res = await generateArticleTranslations(makeSource({ content: sourceContent, language: 'en', lang: 'en' }), { targetLanguages: ['hi', 'gu'] });
    assert.equal(res.ok, true);
    assert.deepEqual(created.map((item) => item.language).sort(), ['gu', 'hi']);
    assert.equal(created.length, 2);

    for (const payload of created) {
      assert.equal(countOccurrences(payload.content, 'data-np-block="x"'), 1);
      assert.equal(countOccurrences(payload.content, 'data-np-post-id="1766401130046488732"'), 1);
      assert.equal(countOccurrences(payload.content, 'data-np-url="https://www.x.com/NewsPulseAI/status/1766401130046488732?s=20"'), 1);
      assert.ok(payload.content.indexOf(`${payload.language}:<p>Lead paragraph.</p>`) < payload.content.indexOf(xBlock));
      assert.ok(payload.content.indexOf(xBlock) < payload.content.indexOf('<p>Closing paragraph.</p>'));
      assert.equal(payload.inlineMedia, undefined);
      assert.equal(payload.media, undefined);
    }
  } finally {
    restore(originals);
    global.fetch = prevFetch;
  }
});

test('generated Hindi and Gujarati article translations preserve controlled Instagram identity without creating media records', async () => {
  const originals = { findOne: News.findOne, create: News.create, updateOne: News.updateOne };
  const prevFetch = global.fetch;
  const created = [];
  const instagramBlock = makeInstagramBlock({ shortcode: 'Cabc_123-def', url: 'https://www.instagram.com/p/Cabc_123-def/?utm_source=ig_web_copy_link' });
  const sourceContent = `<p>Lead paragraph.</p>${instagramBlock}<p>Closing paragraph.</p>`;

  try {
    News.findOne = async () => null;
    News.updateOne = async () => ({ acknowledged: true, modifiedCount: 1 });
    News.create = async (payload) => { created.push(payload); return { _id: `507f1f77bcf86cd7994301${created.length}1`, ...payload }; };
    global.fetch = async (_url, opts) => {
      const body = JSON.parse(String(opts.body || '{}'));
      return { ok: true, status: 200, json: async () => ({ data: { translations: body.q.map((q) => ({ translatedText: `${body.target}:${q}` })) } }) };
    };

    const res = await generateArticleTranslations(makeSource({ content: sourceContent, language: 'en', lang: 'en' }), { targetLanguages: ['hi', 'gu'] });
    assert.equal(res.ok, true);
    assert.deepEqual(created.map((item) => item.language).sort(), ['gu', 'hi']);
    assert.equal(created.length, 2);

    for (const payload of created) {
      assert.equal(countOccurrences(payload.content, 'data-np-block="instagram"'), 1);
      assert.equal(countOccurrences(payload.content, 'data-np-shortcode="Cabc_123-def"'), 1);
      assert.equal(countOccurrences(payload.content, 'data-np-url="https://www.instagram.com/p/Cabc_123-def/?utm_source=ig_web_copy_link"'), 1);
      assert.equal(countOccurrences(payload.content, instagramBlock), 1);
      assert.ok(payload.content.indexOf(`${payload.language}:<p>Lead paragraph.</p>`) < payload.content.indexOf(instagramBlock));
      assert.ok(payload.content.indexOf(instagramBlock) < payload.content.indexOf('<p>Closing paragraph.</p>'));
      assert.equal(payload.inlineMedia, undefined);
      assert.equal(payload.media, undefined);
    }
  } finally {
    restore(originals);
    global.fetch = prevFetch;
  }
});

test('Hindi and Gujarati source articles generate the other supported languages', async () => {
  const originals = { findOne: News.findOne, create: News.create, updateOne: News.updateOne };
  const prevFetch = global.fetch;
  try {
    News.findOne = async () => null;
    News.updateOne = async () => ({ acknowledged: true, modifiedCount: 1 });
    News.create = async (payload) => ({ _id: `507f1f77bcf86cd799439${payload.language}1`, ...payload });
    global.fetch = async (_url, opts) => {
      const body = JSON.parse(String(opts.body || '{}'));
      return { ok: true, status: 200, json: async () => ({ data: { translations: body.q.map((q) => ({ translatedText: `${body.target}:${q}` })) } }) };
    };

    const hi = await generateArticleTranslations(makeSource({ language: 'hi', lang: 'hi', originalLang: 'hi' }), { targetLanguages: ['en', 'hi', 'gu'] });
    assert.deepEqual(Object.keys(hi.created).sort(), ['en', 'gu']);

    const gu = await generateArticleTranslations(makeSource({ language: 'gu', lang: 'gu', originalLang: 'gu' }), { targetLanguages: ['en', 'hi', 'gu'] });
    assert.deepEqual(Object.keys(gu.created).sort(), ['en', 'hi']);
  } finally {
    restore(originals);
    global.fetch = prevFetch;
  }
});

test('Existing translation prevents duplicate language record and human-edited translation is not overwritten', async () => {
  const originals = { findOne: News.findOne, create: News.create, findByIdAndUpdate: News.findByIdAndUpdate, updateOne: News.updateOne };
  let createCalls = 0;
  let updateCalls = 0;
  const prevFetch = global.fetch;

  try {
    News.updateOne = async () => ({ acknowledged: true, modifiedCount: 1 });
    News.findOne = async (query) => {
      const raw = JSON.stringify(query);
      if (raw.includes('"language":"hi"')) return { _id: '507f1f77bcf86cd799439601', language: 'hi', humanEdited: false };
      if (raw.includes('"language":"gu"')) return { _id: '507f1f77bcf86cd799439602', language: 'gu', humanEdited: true };
      return null;
    };
    News.create = async () => { createCalls += 1; return null; };
    News.findByIdAndUpdate = async () => { updateCalls += 1; return null; };
    global.fetch = async (_url, opts) => {
      const body = JSON.parse(String(opts.body || '{}'));
      return { ok: true, status: 200, json: async () => ({ data: { translations: body.q.map((q) => ({ translatedText: q })) } }) };
    };

    const res = await generateArticleTranslations(makeSource(), { targetLanguages: ['hi', 'gu'], overwrite: false });
    assert.equal(createCalls, 0);
    assert.equal(updateCalls, 0);
    assert.equal(res.skipped.hi.reason, 'exists');
    assert.equal(res.skipped.gu.reason, 'human_edited');
  } finally {
    restore(originals);
    global.fetch = prevFetch;
  }
});

test('Failed translation returns failed status without losing source article', async () => {
  const originals = { findOne: News.findOne, create: News.create, updateOne: News.updateOne };
  const prevFetch = global.fetch;
  let createCalls = 0;
  try {
    News.findOne = async () => null;
    News.updateOne = async () => ({ acknowledged: true, modifiedCount: 1 });
    News.create = async () => { createCalls += 1; return null; };
    global.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'server error' } }) });

    const res = await generateArticleTranslations(makeSource(), { targetLanguages: ['hi'] });
    assert.equal(res.ok, false);
    assert.equal(res.status, 'failed');
    assert.equal(createCalls, 0);
    assert.ok(res.failed.hi.length >= 1);
  } finally {
    restore(originals);
    global.fetch = prevFetch;
  }
});

test('POST /api/articles/:id/translations/generate creates target sibling drafts', async () => {
  const id = '507f1f77bcf86cd799439701';
  const originals = { findById: News.findById, findOne: News.findOne, create: News.create, updateOne: News.updateOne };
  const prevFetch = global.fetch;
  const created = [];
  try {
    News.findById = async () => makeSource({ _id: id, language: 'en', lang: 'en', originalLang: 'en', translationGroupId: 'grp-route-1', translationKey: 'grp-route-1' });
    News.findOne = async () => null;
    News.updateOne = async () => ({ acknowledged: true, modifiedCount: 1 });
    News.create = async (payload) => { created.push(payload); return { _id: `507f1f77bcf86cd7994397${created.length}2`, ...payload }; };
    global.fetch = async (_url, opts) => {
      const body = JSON.parse(String(opts.body || '{}'));
      return { ok: true, status: 200, json: async () => ({ data: { translations: body.q.map((q) => ({ translatedText: `${body.target}:${q}` })) } }) };
    };

    const res = await request(app)
      .post(`/api/articles/${id}/translations/generate`)
      .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
      .send({ targetLanguages: ['en', 'hi', 'gu'], overwrite: false });

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.deepEqual(Object.keys(res.body.created).sort(), ['gu', 'hi']);
    assert.deepEqual(created.map((item) => item.language).sort(), ['gu', 'hi']);
    assert.ok(created.every((item) => item.translationReviewStatus === 'review_required'));
  } finally {
    restore(originals);
    global.fetch = prevFetch;
  }
});

test('POST /api/articles/translations/backfill requires Founder and double confirmation for execution', async () => {
  const originals = { find: News.find };
  try {
    News.find = () => ({
      select() { return this; },
      limit() { return this; },
      lean: async () => [makeSource()],
    });

    const adminRes = await request(app)
      .post('/api/articles/translations/backfill')
      .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
      .send({ estimateOnly: true });
    assert.equal(adminRes.status, 403);

    const estimateRes = await request(app)
      .post('/api/articles/translations/backfill')
      .set('Authorization', `Bearer ${makeOpaqueFounderToken()}`)
      .send({ estimateOnly: true, onlyPublished: true, maxCount: 5 });
    assert.equal(estimateRes.status, 200);
    assert.equal(estimateRes.body.requiresConfirmation, true);
    assert.equal(estimateRes.body.confirmationText, 'GENERATE_TRANSLATIONS');
    assert.equal(estimateRes.body.estimatedArticleCount, 1);
  } finally {
    restore(originals);
  }
});