use('newspulse_prod');

const collectionNames = db.getCollectionNames().sort();

const inventory = collectionNames.map((name) => {
  const collection = db.getCollection(name);

  return {
    collection: name,
    documents: collection.countDocuments({}),
    indexCount: collection.getIndexes().length
  };
});

({
  database: db.getName(),
  collectionCount: collectionNames.length,
  totalDocuments: inventory.reduce((sum, item) => sum + item.documents, 0),
  collections: inventory
});
