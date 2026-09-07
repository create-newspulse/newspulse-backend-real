use('test');

db.news.aggregate([
  {
    $group: {
      _id: {
        language: '$language',
        lang: '$lang'
      },
      count: { $sum: 1 }
    }
  },
  {
    $sort: {
      '_id.language': 1,
      '_id.lang': 1
    }
  }
]);
