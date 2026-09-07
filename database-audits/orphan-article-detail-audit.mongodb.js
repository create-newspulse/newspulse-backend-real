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
    $match: {
      $expr: {
        $and: [
          {
            $eq: [
              { $type: '$sourceNewsId' },
              'objectId'
            ]
          },
          {
            $eq: [
              { $size: '$linkedNews' },
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
      title: 1,
      slug: 1,
      language: 1,
      status: 1,
      sourceNewsId: 1,
      translationGroupId: 1,
      translationKey: 1,
      sourceArticleId: 1,
      originalLang: 1,
      sourceLanguage: 1,
      createdAt: 1,
      updatedAt: 1,
      publishedAt: 1,
      deletedAt: 1
    }
  },

  {
    $sort: {
      createdAt: 1
    }
  }
]);
