use('test');

db.articles.aggregate([
  {
    $group: {
      _id: '$language',
      count: { $sum: 1 }
    }
  },
  {
    $sort: { _id: 1 }
  }
]);
