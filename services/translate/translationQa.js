function _normalizeForCompare(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[“”"']/g, '')
    .replace(/[\u200c\u200d]/g, '')
    .trim();
}

function _tokenizeWords(s) {
  const t = _normalizeForCompare(s);
  if (!t) return [];
  return t
    .split(/[^a-z0-9]+/g)
    .map(x => x.trim())
    .filter(Boolean);
}

function diceCoefficientWords(a, b) {
  const aw = _tokenizeWords(a);
  const bw = _tokenizeWords(b);
  if (!aw.length && !bw.length) return 1;
  if (!aw.length || !bw.length) return 0;

  const bigrams = (arr) => {
    const out = new Map();
    if (arr.length === 1) {
      out.set(arr[0], (out.get(arr[0]) || 0) + 1);
      return out;
    }
    for (let i = 0; i < arr.length - 1; i++) {
      const bg = arr[i] + ' ' + arr[i + 1];
      out.set(bg, (out.get(bg) || 0) + 1);
    }
    return out;
  };

  const aB = bigrams(aw);
  const bB = bigrams(bw);

  let overlap = 0;
  for (const [k, c] of aB.entries()) {
    const d = bB.get(k) || 0;
    overlap += Math.min(c, d);
  }

  const total = Array.from(aB.values()).reduce((x, y) => x + y, 0) + Array.from(bB.values()).reduce((x, y) => x + y, 0);
  if (total === 0) return 0;
  return (2 * overlap) / total;
}

module.exports = {
  diceCoefficientWords,
};
