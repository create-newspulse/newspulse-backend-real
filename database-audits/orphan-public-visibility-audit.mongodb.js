use('test');

const orphanIds = [
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

db.articles.aggregate([
  {
    $match: {
      _id: { $in: orphanIds }
    }
  },
  {
    $project: {
      _id: 1,
      title: 1,
      slug: 1,
      language: 1,
      status: 1,
      publishedAt: 1,
      scheduledAt: 1,
      deletedAt: 1,
      isBreaking: 1,
      category: 1,
      categories: 1,
      sourceNewsId: 1,
      translationGroupId: 1,
      translationKey: 1,

      hasTitle: {
        $and: [
          { $ne: [{ $type: '$title' }, 'missing'] },
          { $ne: ['$title', null] },
          { $ne: ['$title', ''] }
        ]
      },

      hasPublishedAt: {
        $and: [
          { $ne: [{ $type: '$publishedAt' }, 'missing'] },
          { $ne: ['$publishedAt', null] }
        ]
      },

      hasDeletedAt: {
        $and: [
          { $ne: [{ $type: '$deletedAt' }, 'missing'] },
          { $ne: ['$deletedAt', null] }
        ]
      },

      basicPublicCandidate: {
        $and: [
          { $eq: ['$status', 'published'] },
          {
            $or: [
              { $eq: [{ $type: '$deletedAt' }, 'missing'] },
              { $eq: ['$deletedAt', null] }
            ]
          }
        ]
      }
    }
  },
  {
    $sort: {
      status: 1,
      language: 1,
      slug: 1
    }
  }
]);
