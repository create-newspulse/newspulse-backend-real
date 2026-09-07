use('test');

const visibleOrphanArticleIds = [
  ObjectId('69c0c4707c7cb68a34add518'),
  ObjectId('69bf02457c7cb68a34adccd7'),
  ObjectId('69c424217c7cb68a34ae01b7'),
  ObjectId('69aba84e4c3cb9a18ef5b1e3')
];

const knownOrphanArticleIds = [
  ObjectId('69aba84e4c3cb9a18ef5b1e3'),
  ObjectId('69bf02457c7cb68a34adccd7'),
  ObjectId('69bfb0b67c7cb68a34adcf0a'),
  ObjectId('69c0c4707c7cb68a34add518'),
  ObjectId('69c424217c7cb68a34ae01b7'),
  ObjectId('69c814697c7cb68a34ae2a25'),
  ObjectId('69c814957c7cb68a34ae2a26'),
  ObjectId('69c814eb7c7cb68a34ae2a29'),
  ObjectId('69c815727c7cb68a34ae2a2f')
];

function nonEmpty(valueExpression) {
  return {
    $and: [
      { $ne: [valueExpression, null] },
      { $ne: [valueExpression, ''] },
      { $ne: [{ $type: valueExpression }, 'missing'] }
    ]
  };
}

function relationMatchReasons() {
  return {
    $concatArrays: [
      {
        $cond: [
          {
            $and: [
              { $ne: ['$$translationGroupId', null] },
              { $ne: ['$$translationGroupId', ''] },
              { $ne: ['$translationGroupId', null] },
              { $ne: ['$translationGroupId', ''] },
              { $eq: ['$translationGroupId', '$$translationGroupId'] }
            ]
          },
          ['translationGroupId'],
          []
        ]
      },
      {
        $cond: [
          {
            $and: [
              { $ne: ['$$translationKey', null] },
              { $ne: ['$$translationKey', ''] },
              { $ne: ['$translationKey', null] },
              { $ne: ['$translationKey', ''] },
              { $eq: ['$translationKey', '$$translationKey'] }
            ]
          },
          ['translationKey'],
          []
        ]
      },
      {
        $cond: [
          {
            $and: [
              { $ne: ['$$title', null] },
              { $ne: ['$$title', ''] },
              { $ne: ['$title', null] },
              { $ne: ['$title', ''] },
              { $eq: ['$title', '$$title'] }
            ]
          },
          ['title'],
          []
        ]
      },
      {
        $cond: [
          {
            $and: [
              { $ne: ['$$slug', null] },
              { $ne: ['$$slug', ''] },
              { $ne: ['$slug', null] },
              { $ne: ['$slug', ''] },
              { $eq: ['$slug', '$$slug'] }
            ]
          },
          ['slug'],
          []
        ]
      },
      {
        $cond: [
          {
            $or: [
              { $and: [{ $ne: ['$$slug', null] }, { $ne: ['$$slug', ''] }, { $eq: ['$slugs.en', '$$slug'] }] },
              { $and: [{ $ne: ['$$slugsEn', null] }, { $ne: ['$$slugsEn', ''] }, { $eq: ['$slug', '$$slugsEn'] }] },
              { $and: [{ $ne: ['$$slugsEn', null] }, { $ne: ['$$slugsEn', ''] }, { $eq: ['$slugs.en', '$$slugsEn'] }] }
            ]
          },
          ['localized slug: slugs.en'],
          []
        ]
      },
      {
        $cond: [
          {
            $or: [
              { $and: [{ $ne: ['$$slug', null] }, { $ne: ['$$slug', ''] }, { $eq: ['$slugs.hi', '$$slug'] }] },
              { $and: [{ $ne: ['$$slugsHi', null] }, { $ne: ['$$slugsHi', ''] }, { $eq: ['$slug', '$$slugsHi'] }] },
              { $and: [{ $ne: ['$$slugsHi', null] }, { $ne: ['$$slugsHi', ''] }, { $eq: ['$slugs.hi', '$$slugsHi'] }] }
            ]
          },
          ['localized slug: slugs.hi'],
          []
        ]
      },
      {
        $cond: [
          {
            $or: [
              { $and: [{ $ne: ['$$slug', null] }, { $ne: ['$$slug', ''] }, { $eq: ['$slugs.gu', '$$slug'] }] },
              { $and: [{ $ne: ['$$slugsGu', null] }, { $ne: ['$$slugsGu', ''] }, { $eq: ['$slug', '$$slugsGu'] }] },
              { $and: [{ $ne: ['$$slugsGu', null] }, { $ne: ['$$slugsGu', ''] }, { $eq: ['$slugs.gu', '$$slugsGu'] }] }
            ]
          },
          ['localized slug: slugs.gu'],
          []
        ]
      }
    ]
  };
}

const candidatePipeline = [
  { $addFields: { matchingReasons: relationMatchReasons() } },
  { $match: { $expr: { $gt: [{ $size: '$matchingReasons' }, 0] } } },
  {
    $project: {
      _id: 1,
      title: 1,
      slug: 1,
      slugs: 1,
      language: 1,
      lang: 1,
      originalLang: 1,
      sourceLanguage: 1,
      status: 1,
      category: 1,
      sourceNewsId: 1,
      sourceArticleId: 1,
      translationGroupId: 1,
      translationKey: 1,
      createdAt: 1,
      updatedAt: 1,
      publishedAt: 1,
      deletedAt: 1,
      matchingReasons: 1
    }
  }
];

print('DATABASE OVERVIEW');
printjson(
  db.getCollectionNames()
    .filter((name) => !name.startsWith('system.'))
    .sort()
    .map((name) => ({
      collection: name,
      count: db.getCollection(name).countDocuments({}),
      indexCount: db.getCollection(name).getIndexes().length
    }))
);

print('NEWS HEALTH');
printjson(db.news.aggregate([
  {
    $facet: {
      totals: [{ $count: 'count' }],
      byLanguage: [{ $group: { _id: '$language', count: { $sum: 1 } } }, { $sort: { _id: 1 } }],
      byLang: [{ $group: { _id: '$lang', count: { $sum: 1 } } }, { $sort: { _id: 1 } }],
      byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }, { $sort: { count: -1, _id: 1 } }],
      missingLanguage: [{ $match: { $or: [{ language: null }, { language: { $exists: false } }, { language: '' }] } }, { $count: 'count' }],
      missingSlug: [{ $match: { $or: [{ slug: null }, { slug: { $exists: false } }, { slug: '' }] } }, { $count: 'count' }],
      translationGroups: [
        { $group: { _id: '$translationGroupId', count: { $sum: 1 }, languages: { $addToSet: '$language' } } },
        { $sort: { count: -1, _id: 1 } },
        { $limit: 25 }
      ]
    }
  }
]).toArray());

print('ARTICLE HEALTH');
printjson(db.articles.aggregate([
  { $lookup: { from: 'news', localField: 'sourceNewsId', foreignField: '_id', as: 'linkedNews' } },
  {
    $facet: {
      totals: [{ $count: 'count' }],
      byLanguage: [{ $group: { _id: '$language', count: { $sum: 1 } } }, { $sort: { _id: 1 } }],
      byLang: [{ $group: { _id: '$lang', count: { $sum: 1 } } }, { $sort: { _id: 1 } }],
      byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }, { $sort: { count: -1, _id: 1 } }],
      sourceNewsIdTypes: [{ $group: { _id: { $type: '$sourceNewsId' }, count: { $sum: 1 } } }, { $sort: { _id: 1 } }],
      sourceNewsLinks: [
        {
          $group: {
            _id: null,
            validNewsLinks: { $sum: { $cond: [{ $gt: [{ $size: '$linkedNews' }, 0] }, 1, 0] } },
            orphanNewsLinks: {
              $sum: {
                $cond: [
                  { $and: [{ $ne: [{ $ifNull: ['$sourceNewsId', null] }, null] }, { $eq: [{ $size: '$linkedNews' }, 0] }] },
                  1,
                  0
                ]
              }
            },
            noSourceNewsId: { $sum: { $cond: [{ $eq: [{ $ifNull: ['$sourceNewsId', null] }, null] }, 1, 0] } }
          }
        }
      ],
      duplicateExactSlugs: [
        { $match: { slug: { $exists: true, $nin: [null, ''] } } },
        { $group: { _id: '$slug', count: { $sum: 1 }, ids: { $addToSet: '$_id' } } },
        { $match: { count: { $gt: 1 } } },
        { $sort: { count: -1, _id: 1 } }
      ],
      suspiciousSlugs: [
        { $match: { $or: [{ slug: 'object-object' }, { title: '[object Object]' }, { slug: /\[object Object\]/i }] } },
        { $project: { _id: 1, title: 1, slug: 1, language: 1, status: 1, sourceNewsId: 1 } }
      ]
    }
  }
]).toArray());

print('PUBLISHED AND DRAFT ORPHAN ARTICLES');
printjson(db.articles.aggregate([
  { $match: { _id: { $in: knownOrphanArticleIds } } },
  { $lookup: { from: 'news', localField: 'sourceNewsId', foreignField: '_id', as: 'linkedNews' } },
  { $match: { $expr: { $eq: [{ $size: '$linkedNews' }, 0] } } },
  {
    $project: {
      _id: 1,
      title: 1,
      slug: 1,
      language: 1,
      status: 1,
      category: 1,
      sourceNewsId: 1,
      publishedAt: 1,
      deletedAt: 1,
      publiclyVisibleBySharedFilter: {
        $and: [
          { $eq: ['$status', 'published'] },
          { $or: [{ $eq: ['$publishedAt', null] }, { $lte: ['$publishedAt', new Date()] }] }
        ]
      }
    }
  },
  { $sort: { status: 1, language: 1, slug: 1 } }
]).toArray());

print('VISIBLE ORPHAN CANONICAL RELATIONSHIP CANDIDATES');
printjson(db.articles.aggregate([
  { $match: { _id: { $in: visibleOrphanArticleIds } } },
  {
    $lookup: {
      from: 'news',
      let: {
        translationGroupId: '$translationGroupId',
        translationKey: '$translationKey',
        title: '$title',
        slug: '$slug',
        slugsEn: '$slugs.en',
        slugsHi: '$slugs.hi',
        slugsGu: '$slugs.gu'
      },
      pipeline: candidatePipeline,
      as: 'existingNewsMatches'
    }
  },
  {
    $lookup: {
      from: 'articles',
      let: {
        currentId: '$_id',
        translationGroupId: '$translationGroupId',
        translationKey: '$translationKey',
        title: '$title',
        slug: '$slug',
        slugsEn: '$slugs.en',
        slugsHi: '$slugs.hi',
        slugsGu: '$slugs.gu'
      },
      pipeline: [
        { $match: { $expr: { $ne: ['$_id', '$$currentId'] } } },
        ...candidatePipeline
      ],
      as: 'articleSiblingDuplicateMatches'
    }
  },
  {
    $project: {
      ARTICLE: {
        id: '$_id',
        title: '$title',
        language: '$language',
        slug: '$slug',
        missingSourceNewsIdTarget: '$sourceNewsId'
      },
      EXISTING_NEWS_MATCHES: {
        count: { $size: '$existingNewsMatches' },
        matchingIds: '$existingNewsMatches._id',
        matches: '$existingNewsMatches'
      },
      ARTICLE_SIBLING_DUPLICATE_MATCHES: {
        count: { $size: '$articleSiblingDuplicateMatches' },
        matchingIds: '$articleSiblingDuplicateMatches._id',
        matches: '$articleSiblingDuplicateMatches'
      },
      CLASSIFICATION: {
        $switch: {
          branches: [
            { case: { $eq: [{ $size: '$existingNewsMatches' }, 1] }, then: 'CANONICAL NEWS MATCH FOUND' },
            { case: { $gt: [{ $size: '$existingNewsMatches' }, 1] }, then: 'NEEDS MANUAL REVIEW' },
            { case: { $gt: [{ $size: '$articleSiblingDuplicateMatches' }, 0] }, then: 'ARTICLE SIBLING ONLY' }
          ],
          default: 'NO MATCH FOUND'
        }
      }
    }
  },
  { $sort: { 'ARTICLE.language': 1, 'ARTICLE.slug': 1 } }
]).toArray());

print('INDEX SUMMARY FOR CORE COLLECTIONS');
printjson({
  news: db.news.getIndexes().map((index) => ({ name: index.name, key: index.key, unique: !!index.unique, expireAfterSeconds: index.expireAfterSeconds })),
  articles: db.articles.getIndexes().map((index) => ({ name: index.name, key: index.key, unique: !!index.unique, expireAfterSeconds: index.expireAfterSeconds })),
  users: db.users.getIndexes().map((index) => ({ name: index.name, key: index.key, unique: !!index.unique, expireAfterSeconds: index.expireAfterSeconds }))
});
