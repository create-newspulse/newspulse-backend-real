function isContentDatabaseUnavailable(error) {
  return error?.code === 50 || [
    'MongoNetworkError', 'MongoNetworkTimeoutError', 'MongoServerSelectionError',
    'MongooseServerSelectionError', 'MongoNotConnectedError',
  ].includes(error?.name) || (error?.name === 'MongooseError' && /buffering timed out/i.test(error.message || ''));
}

module.exports = { isContentDatabaseUnavailable };
