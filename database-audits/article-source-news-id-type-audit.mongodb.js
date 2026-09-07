use('test');

db.articles.aggregate([
  {
    $lookup: {
      from: 'news',
      localField: 'sourceNewsId',
      foreignField: '_id',
      as: 'strictLinkedNews'
    }
  },

  {
    $lookup: {
      from: 'news',
      let: {
        convertedSourceNewsId: {
          $convert: {
            input: '$sourceNewsId',
            to: 'objectId',
            onError: null,
            onNull: null
          }
        }
      },
      pipeline: [
        {
          $match: {
            $expr: {
              $eq: ['$_id', '$$convertedSourceNewsId']
            }
          }
        }
      ],
      as: 'convertedLinkedNews'
    }
  },

  {
    $facet: {
      sourceNewsIdTypes: [
        {
          $group: {
            _id: { $type: '$sourceNewsId' },
            count: { $sum: 1 }
          }
        },
        {
          $sort: { _id: 1 }
        }
      ],

      summary: [
        {
          $group: {
            _id: null,

            totalArticles: {
              $sum: 1
            },

            sourceNewsIdMissing: {
              $sum: {
                $cond: [
                  {
                    $eq: [
                      { $type: '$sourceNewsId' },
                      'missing'
                    ]
                  },
                  1,
                  0
                ]
              }
            },

            sourceNewsIdExplicitNull: {
              $sum: {
                $cond: [
                  {
                    $eq: [
                      { $type: '$sourceNewsId' },
                      'null'
                    ]
                  },
                  1,
                  0
                ]
              }
            },

            strictValidLink: {
              $sum: {
                $cond: [
                  {
                    $gt: [
                      { $size: '$strictLinkedNews' },
                      0
                    ]
                  },
                  1,
                  0
                ]
              }
            },

            validAfterObjectIdConversion: {
              $sum: {
                $cond: [
                  {
                    $gt: [
                      { $size: '$convertedLinkedNews' },
                      0
                    ]
                  },
                  1,
                  0
                ]
              }
            },

            recoverableTypeMismatch: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      {
                        $eq: [
                          { $size: '$strictLinkedNews' },
                          0
                        ]
                      },
                      {
                        $gt: [
                          { $size: '$convertedLinkedNews' },
                          0
                        ]
                      }
                    ]
                  },
                  1,
                  0
                ]
              }
            }
          }
        }
      ],

      unresolvedSourceNewsIds: [
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
                {
                  $eq: [
                    { $size: '$strictLinkedNews' },
                    0
                  ]
                },
                {
                  $eq: [
                    { $size: '$convertedLinkedNews' },
                    0
                  ]
                }
              ]
            }
          }
        },

        {
          $project: {
            _id: 1,
            language: 1,
            slug: 1,
            status: 1,
            sourceNewsId: 1,
            sourceNewsIdType: {
              $type: '$sourceNewsId'
            },
            translationGroupId: 1,
            translationKey: 1,
            createdAt: 1,
            publishedAt: 1
          }
        }
      ]
    }
  }
]);
