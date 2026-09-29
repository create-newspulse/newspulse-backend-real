const assert = require('node:assert/strict');

function get(doc, path) {
  return path.split('.').reduce((value, field) => value?.[field], doc);
}

function put(doc, path, value) {
  const fields = path.split('.');
  const last = fields.pop();
  let target = doc;
  for (const field of fields) target = target[field] ||= {};
  if (value !== undefined) target[last] = value;
}

const comparable = value => value instanceof Date ? value.getTime() : value?.toHexString ? value.toHexString() : value;
const equal = (left, right) => comparable(left) === comparable(right);

function expression(value, doc) {
  if (value === '$$ROOT') return doc;
  if (typeof value === 'string' && value.startsWith('$')) return get(doc, value.slice(1));
  if (Array.isArray(value)) return value.map(item => expression(item, doc));
  if (!value || typeof value !== 'object' || value instanceof Date || value.toHexString) return value;
  const [operator, operand] = Object.entries(value)[0] || [];
  const args = () => expression(operand, doc);
  if (!operator?.startsWith('$')) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expression(item, doc)]));
  switch (operator) {
    case '$ifNull': return args().find(item => item !== null && item !== undefined) ?? null;
    case '$trim': return expression(operand.input, doc).trim();
    case '$toString': return String(expression(operand, doc));
    case '$concat': return args().join('');
    case '$eq': return equal(...args());
    case '$ne': return !equal(...args());
    case '$and': return args().every(Boolean);
    case '$or': return args().some(Boolean);
    case '$in': { const [item, values] = args(); return values.some(entry => equal(item, entry)); }
    case '$indexOfArray': { const [values, item] = args(); return values.findIndex(entry => equal(item, entry)); }
    case '$cond': return expression(expression(operand[0], doc) ? operand[1] : operand[2], doc);
    case '$switch': {
      const branch = operand.branches.find(item => expression(item.case, doc));
      return expression(branch ? branch.then : operand.default, doc);
    }
    default: throw new Error(`Unsupported test expression ${operator}`);
  }
}

function matches(doc, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$and') return expected.every(clause => matches(doc, clause));
    if (key === '$or') return expected.some(clause => matches(doc, clause));
    if (key === '$expr') return Boolean(expression(expected, doc));
    const actual = get(doc, key);
    if (expected instanceof RegExp) return expected.test(String(actual || ''));
    if (expected === null) return actual == null;
    if (!expected || typeof expected !== 'object' || expected instanceof Date || expected.toHexString) return equal(actual, expected);
    return Object.entries(expected).every(([operator, value]) => {
      if (operator === '$in') return value.some(item => equal(actual, item));
      if (operator === '$ne') return !equal(actual, value);
      if (operator === '$exists') return (actual !== undefined) === value;
      const left = value instanceof Date ? new Date(actual).getTime() : comparable(actual);
      if (operator === '$lte') return actual != null && left <= comparable(value);
      if (operator === '$lt') return actual != null && left < comparable(value);
      throw new Error(`Unsupported test match ${operator}`);
    });
  });
}

function runPipeline(input, pipeline) {
  let rows = input.slice();
  for (const stage of pipeline) {
    const [operator, value] = Object.entries(stage)[0];
    switch (operator) {
      case '$match': rows = rows.filter(doc => matches(doc, value)); break;
      case '$project': rows = rows.map(doc => {
        const out = doc._id === undefined ? {} : { _id: doc._id };
        for (const [field, selected] of Object.entries(value)) put(out, field, selected === 1 ? get(doc, field) : expression(selected, doc));
        return out;
      }); break;
      case '$set': rows = rows.map(doc => ({ ...doc, ...expression(value, doc) })); break;
      case '$sort': rows.sort((left, right) => {
        for (const [field, direction] of Object.entries(value)) {
          const first = comparable(get(left, field));
          const second = comparable(get(right, field));
          if (first < second) return -direction;
          if (first > second) return direction;
        }
        return 0;
      }); break;
      case '$group': {
        const groups = new Map();
        for (const doc of rows) {
          const id = expression(value._id, doc);
          const key = JSON.stringify(id);
          const first = !groups.has(key);
          const group = groups.get(key) || { _id: id };
          for (const [field, accumulator] of Object.entries(value)) {
            if (field === '_id') continue;
            if ('$first' in accumulator && first) group[field] = expression(accumulator.$first, doc);
            else if ('$min' in accumulator) group[field] = Math.min(group[field] ?? Infinity, expression(accumulator.$min, doc));
          }
          groups.set(key, group);
        }
        rows = [...groups.values()]; break;
      }
      case '$replaceRoot': rows = rows.map(doc => expression(value.newRoot, doc)); break;
      case '$skip': rows = rows.slice(value); break;
      case '$limit': rows = rows.slice(0, value); break;
      case '$count': rows = rows.length ? [{ [value]: rows.length }] : []; break;
      case '$facet': rows = [Object.fromEntries(Object.entries(value).map(([key, stages]) => [key, runPipeline(rows, stages)]))]; break;
      default: throw new Error(`Unsupported test stage ${operator}`);
    }
  }
  return rows;
}

function stubAggregate(context, Model, docs, calls = []) {
  context.mock.method(Model, 'aggregate', pipeline => {
    calls.push(pipeline);
    return { option(options) {
      assert.equal(options.maxTimeMS, 2500);
      assert.equal(options.allowDiskUse, false);
      return this;
    }, exec: async () => runPipeline(docs, pipeline) };
  });
}

module.exports = { matches, runPipeline, stubAggregate };