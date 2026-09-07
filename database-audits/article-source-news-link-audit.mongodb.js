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
    $facet: {
      summary: [
        {
          $group: {
            _id: null,
            totalArticles: { $sum: 1 },

            withSourceNewsId: {
              $sum: {
                $cond: [
                  { $ne: ['$sourceNewsId', null] },
                  1,
                  0
                ]
              }
            },

            withoutSourceNewsId: {
              $sum: {
                $cond: [
                  { $eq: ['$sourceNewsId', null] },
                  1,
                  0
                ]
              }
            },

            linkedToExistingNews: {
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
                      { $ne: ['$sourceNewsId', null] },
                      { $eq: [{ $size: '$linkedNews' }, 0] }
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

      byLanguage: [
        {
          $group: {
            _id: '$language',
            total: { $sum: 1 },

            linked: {
              $sum: {
                $cond: [
                  { $gt: [{ $size: '$linkedNews' }, 0] },
                  1,
                  0
                ]
              }
            },

            unlinked: {
              $sum: {
                $cond: [
                  { $eq: [{ $size: '$linkedNews' }, 0] },
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
