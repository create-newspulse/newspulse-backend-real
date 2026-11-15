const assert = require('node:assert/strict');

function publicListingCursor(load, stats = {}) {
  let rows;
  let index = 0;
  stats.readCount = 0;
  stats.closed = false;
  return {
    async next() {
      assert.equal(stats.closed, false, 'A closed listing cursor must not be read');
      if (!rows) {
        rows = await load();
        assert.ok(Array.isArray(rows), 'Listing cursor fixtures must return an array');
      }
      if (index >= rows.length) return null;
      stats.readCount += 1;
      return rows[index++];
    },
    async close() { stats.closed = true; },
  };
}

module.exports = { publicListingCursor };
