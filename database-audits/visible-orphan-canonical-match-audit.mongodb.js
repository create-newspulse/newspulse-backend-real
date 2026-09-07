use('test');

const orphanIds = [
  ObjectId('69c0c4707c7cb68a34add518'),
  ObjectId('69bf02457c7cb68a34adccd7'),
  ObjectId('69c424217c7cb68a34ae01b7'),
  ObjectId('69aba84e4c3cb9a18ef5b1e3')
];

const sourceArticleFields = {
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
  deletedAt: 1
};

const candidateMatchStages = [
  {
    $addFields: {
      matchingReasons: {
        $concatArrays: [
          {
            $cond: [
              {
                $and: [
                  { $ne: ['$$sourceTranslationGroupId', null] },
                  { $ne: ['$$sourceTranslationGroupId', ''] },
                  { $ne: ['$translationGroupId', null] },
                  { $ne: ['$translationGroupId', ''] },
                  { $eq: ['$translationGroupId', '$$sourceTranslationGroupId'] }
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
                  { $ne: ['$$sourceTranslationKey', null] },
                  { $ne: ['$$sourceTranslationKey', ''] },
                  { $ne: ['$translationKey', null] },
                  { $ne: ['$translationKey', ''] },
                  { $eq: ['$translationKey', '$$sourceTranslationKey'] }
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
                  { $ne: ['$$sourceTitle', null] },
                  { $ne: ['$$sourceTitle', ''] },
                  { $ne: ['$title', null] },
                  { $ne: ['$title', ''] },
                  { $eq: ['$title', '$$sourceTitle'] }
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
                  { $ne: ['$$sourceSlug', null] },
                  { $ne: ['$$sourceSlug', ''] },
                  { $ne: ['$slug', null] },
                  { $ne: ['$slug', ''] },
                  { $eq: ['$slug', '$$sourceSlug'] }
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
                  {
                    $and: [
                      { $ne: ['$$sourceSlug', null] },
                      { $ne: ['$$sourceSlug', ''] },
                      { $ne: ['$slugs.en', null] },
                      { $ne: ['$slugs.en', ''] },
                      { $eq: ['$slugs.en', '$$sourceSlug'] }
                    ]
                  },
                  {
                    $and: [
                      { $ne: ['$$sourceSlugsEn', null] },
                      { $ne: ['$$sourceSlugsEn', ''] },
                      { $ne: ['$slug', null] },
                      { $ne: ['$slug', ''] },
                      { $eq: ['$slug', '$$sourceSlugsEn'] }
                    ]
                  },
                  {
                    $and: [
                      { $ne: ['$$sourceSlugsEn', null] },
                      { $ne: ['$$sourceSlugsEn', ''] },
                      { $ne: ['$slugs.en', null] },
                      { $ne: ['$slugs.en', ''] },
                      { $eq: ['$slugs.en', '$$sourceSlugsEn'] }
                    ]
                  }
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
                  {
                    $and: [
                      { $ne: ['$$sourceSlug', null] },
                      { $ne: ['$$sourceSlug', ''] },
                      { $ne: ['$slugs.hi', null] },
                      { $ne: ['$slugs.hi', ''] },
                      { $eq: ['$slugs.hi', '$$sourceSlug'] }
                    ]
                  },
                  {
                    $and: [
                      { $ne: ['$$sourceSlugsHi', null] },
                      { $ne: ['$$sourceSlugsHi', ''] },
                      { $ne: ['$slug', null] },
                      { $ne: ['$slug', ''] },
                      { $eq: ['$slug', '$$sourceSlugsHi'] }
                    ]
                  },
                  {
                    $and: [
                      { $ne: ['$$sourceSlugsHi', null] },
                      { $ne: ['$$sourceSlugsHi', ''] },
                      { $ne: ['$slugs.hi', null] },
                      { $ne: ['$slugs.hi', ''] },
                      { $eq: ['$slugs.hi', '$$sourceSlugsHi'] }
                    ]
                  }
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
                  {
                    $and: [
                      { $ne: ['$$sourceSlug', null] },
                      { $ne: ['$$sourceSlug', ''] },
                      { $ne: ['$slugs.gu', null] },
                      { $ne: ['$slugs.gu', ''] },
                      { $eq: ['$slugs.gu', '$$sourceSlug'] }
                    ]
                  },
                  {
                    $and: [
                      { $ne: ['$$sourceSlugsGu', null] },
                      { $ne: ['$$sourceSlugsGu', ''] },
                      { $ne: ['$slug', null] },
                      { $ne: ['$slug', ''] },
                      { $eq: ['$slug', '$$sourceSlugsGu'] }
                    ]
                  },
                  {
                    $and: [
                      { $ne: ['$$sourceSlugsGu', null] },
                      { $ne: ['$$sourceSlugsGu', ''] },
                      { $ne: ['$slugs.gu', null] },
                      { $ne: ['$slugs.gu', ''] },
                      { $eq: ['$slugs.gu', '$$sourceSlugsGu'] }
                    ]
                  }
                ]
              },
              ['localized slug: slugs.gu'],
              []
            ]
          }
        ]
      }
    }
  },
  {
    $match: {
      $expr: {
        $gt: [{ $size: '$matchingReasons' }, 0]
      }
    }
  },
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
  },
  {
    $sort: {
      publishedAt: -1,
      createdAt: -1,
      _id: 1
    }
  }
];

db.articles.aggregate([
  {
    $match: {
      _id: { $in: orphanIds }
    }
  },
  {
    $project: sourceArticleFields
  },
  {
    $lookup: {
      from: 'news',
      let: {
        sourceTranslationGroupId: '$translationGroupId',
        sourceTranslationKey: '$translationKey',
        sourceTitle: '$title',
        sourceSlug: '$slug',
        sourceSlugsEn: '$slugs.en',
        sourceSlugsHi: '$slugs.hi',
        sourceSlugsGu: '$slugs.gu'
      },
      pipeline: candidateMatchStages,
      as: 'existingNewsMatches'
    }
  },
  {
    $lookup: {
      from: 'articles',
      let: {
        currentArticleId: '$_id',
        sourceTranslationGroupId: '$translationGroupId',
        sourceTranslationKey: '$translationKey',
        sourceTitle: '$title',
        sourceSlug: '$slug',
        sourceSlugsEn: '$slugs.en',
        sourceSlugsHi: '$slugs.hi',
        sourceSlugsGu: '$slugs.gu'
      },
      pipeline: [
        {
          $match: {
            $expr: {
              $ne: ['$_id', '$$currentArticleId']
            }
          }
        },
        ...candidateMatchStages
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
        missingSourceNewsIdTarget: '$sourceNewsId',
        fields: {
          _id: '$_id',
          title: '$title',
          slug: '$slug',
          slugs: '$slugs',
          language: '$language',
          lang: '$lang',
          originalLang: '$originalLang',
          sourceLanguage: '$sourceLanguage',
          status: '$status',
          category: '$category',
          sourceNewsId: '$sourceNewsId',
          sourceArticleId: '$sourceArticleId',
          translationGroupId: '$translationGroupId',
          translationKey: '$translationKey',
          createdAt: '$createdAt',
          updatedAt: '$updatedAt',
          publishedAt: '$publishedAt',
          deletedAt: '$deletedAt'
        }
      },
      EXISTING_NEWS_MATCHES: {
        count: { $size: '$existingNewsMatches' },
        matchingIds: '$existingNewsMatches._id',
        matches: {
          $map: {
            input: '$existingNewsMatches',
            as: 'match',
            in: {
              id: '$$match._id',
              language: '$$match.language',
              lang: '$$match.lang',
              status: '$$match.status',
              slug: '$$match.slug',
              title: '$$match.title',
              matchingReasons: '$$match.matchingReasons'
            }
          }
        }
      },
      ARTICLE_SIBLING_DUPLICATE_MATCHES: {
        count: { $size: '$articleSiblingDuplicateMatches' },
        matchingIds: '$articleSiblingDuplicateMatches._id',
        matches: {
          $map: {
            input: '$articleSiblingDuplicateMatches',
            as: 'match',
            in: {
              id: '$$match._id',
              language: '$$match.language',
              lang: '$$match.lang',
              status: '$$match.status',
              slug: '$$match.slug',
              title: '$$match.title',
              matchingReasons: '$$match.matchingReasons'
            }
          }
        }
      },
      CLASSIFICATION: {
        $switch: {
          branches: [
            {
              case: { $eq: [{ $size: '$existingNewsMatches' }, 1] },
              then: 'CANONICAL NEWS MATCH FOUND'
            },
            {
              case: { $gt: [{ $size: '$existingNewsMatches' }, 1] },
              then: 'NEEDS MANUAL REVIEW'
            },
            {
              case: { $gt: [{ $size: '$articleSiblingDuplicateMatches' }, 0] },
              then: 'ARTICLE SIBLING ONLY'
            }
          ],
          default: 'NO MATCH FOUND'
        }
      }
    }
  },
  {
    $sort: {
      'ARTICLE.language': 1,
      'ARTICLE.slug': 1
    }
  }
]);
