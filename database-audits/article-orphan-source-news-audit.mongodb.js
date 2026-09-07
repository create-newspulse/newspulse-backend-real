use('test');

db.articles.aggregate([
  {
    $lookup: {
      from: 'news',
      localField: 'sourceNewsId',
      foreignField: '_id',
      as: 'linkedNews'
    }
  },
  {
    $lookup: {
      from: 'articles',
      localField: 'sourceArticleId',
      foreignField: '_id',
      as: 'linkedSourceArticle'
    }
  },
  {
    $facet: {
      summary: [
        {
          $group: {
            _id: null,

            totalArticles: { $sum: 1 },

            validSourceNewsLink: {
              $sum: {
                $cond: [
                  { $gt: [{ $size: '$linkedNews' }, 0] },
                  1,
                  0
                ]
              }
            },

            orphanedSourceNewsId: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      {
                        $ne: [
                          { $ifNull: ['$sourceNewsId', null] },
                          null
                        ]
                      },
                      { $eq: [{ $size: '$linkedNews' }, 0] }
                    ]
                  },
                  1,
                  0
                ]
              }
            },

            noSourceNewsId: {
              $sum: {
                $cond: [
                  {
                    $eq: [
                      { $ifNull: ['$sourceNewsId', null] },
                      null
                    ]
                  },
                  1,
                  0
                ]
              }
            },

            validSourceArticleLink: {
              $sum: {
                $cond: [
                  { $gt: [{ $size: '$linkedSourceArticle' }, 0] },
                  1,
                  0
                ]
              }
            }
          }
        }
      ],

      orphanSourceGroups: [
        {
          $match: {
            $expr: {
              $and: [
                {
                  $ne: [
                    { $ifNull: ['$sourceNewsId', null] },
                    null
                  ]
                },
                { $eq: [{ $size: '$linkedNews' }, 0] }
              ]
            }
          }
        },
        {
          $group: {
            _id: '$sourceNewsId',
            articleCount: { $sum: 1 },
            languages: { $addToSet: '$language' },
            statuses: { $addToSet: '$status' },
            earliestCreatedAt: { $min: '$createdAt' },
            latestCreatedAt: { $max: '$createdAt' },
            slugs: { $addToSet: '$slug' }
          }
        },
        {
          $sort: {
            articleCount: -1,
            earliestCreatedAt: 1
          }
        }
      ],

      noSourceNewsIdArticles: [
        {
          $match: {
            $expr: {
              $eq: [
                { $ifNull: ['$sourceNewsId', null] },
                null
              ]
            }
          }
        },
        {
          $project: {
            _id: 1,
            slug: 1,
            language: 1,
            status: 1,
            sourceArticleId: 1,
            translationGroupId: 1,
            translationKey: 1,
            createdAt: 1,
            publishedAt: 1
          }
        }
      ],

      orphanByLanguage: [
        {
          $match: {
            $expr: {
              $and: [
                {
                  $ne: [
                    { $ifNull: ['$sourceNewsId', null] },
                    null
                  ]
                },
                { $eq: [{ $size: '$linkedNews' }, 0] }
              ]
            }
          }
        },
        {
          $group: {
            _id: '$language',
            count: { $sum: 1 },
            validSourceArticleLinks: {
              $sum: {
                $cond: [
                  { $gt: [{ $size: '$linkedSourceArticle' }, 0] },
                  1,
                  0
                ]
              }
            }
          }
        },
        {
          $sort: { _id: 1 }
        }
      ]
    }
  }
]);
