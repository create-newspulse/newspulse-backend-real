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

function expression(value, doc, variables = {}) {
  if (value === '$$ROOT') return doc;
  if (typeof value === 'string' && value.startsWith('$$')) return get(variables, value.slice(2));
  if (typeof value === 'string' && value.startsWith('$')) return get(doc, value.slice(1));
  if (Array.isArray(value)) return value.map(item => expression(item, doc, variables));
  if (!value || typeof value !== 'object' || value instanceof Date || value.toHexString) return value;
  const [operator, operand] = Object.entries(value)[0] || [];
  const evaluate = item => expression(item, doc, variables);
  const args = () => evaluate(operand);
  if (!operator?.startsWith('$')) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, evaluate(item)]));
  switch (operator) {
    case '$ifNull': {
      for (const item of operand) {
        const result = evaluate(item);
        if (result !== null && result !== undefined) return result;
      }
      return null;
    }
    case '$trim': return evaluate(operand.input).trim();
    case '$toString': return String(evaluate(operand));
    case '$toLower': return evaluate(operand).toLowerCase();
    case '$type': {
      const result = evaluate(operand);
      if (result === undefined) return 'missing';
      if (result === null) return 'null';
      if (Array.isArray(result)) return 'array';
      return typeof result;
    }
    case '$concat': return args().join('');
    case '$eq': return equal(...args());
    case '$ne': return !equal(...args());
    case '$gt': { const [left, right] = args(); return comparable(left) > comparable(right); }
    case '$gte': { const [left, right] = args(); return comparable(left) >= comparable(right); }
    case '$and': return args().every(Boolean);
    case '$or': return args().some(Boolean);
    case '$in': { const [item, values] = args(); return values.some(entry => equal(item, entry)); }
    case '$indexOfArray': { const [values, item] = args(); return values.findIndex(entry => equal(item, entry)); }
    case '$arrayElemAt': { const [values, index] = args(); return values.at(index); }
    case '$size': return evaluate(operand).length;
    case '$regexMatch': return operand.regex.test(evaluate(operand.input));
    case '$regexFindAll': {
      const pattern = new RegExp(operand.regex.source, operand.regex.flags.replace('g', '') + 'g');
      return Array.from(evaluate(operand.input).matchAll(pattern), match => ({
        match: match[0], idx: match.index, captures: match.slice(1).map(item => item ?? null),
      }));
    }
    case '$let': {
      const scope = { ...variables, ...Object.fromEntries(Object.entries(operand.vars).map(([name, item]) => [name, evaluate(item)])) };
      return expression(operand.in, doc, scope);
    }
    case '$reduce': return evaluate(operand.input).reduce((result, item) => (
      expression(operand.in, doc, { ...variables, value: result, this: item })
    ), evaluate(operand.initialValue));
    case '$cond': return evaluate(evaluate(operand[0]) ? operand[1] : operand[2]);
    case '$switch': {
      const branch = operand.branches.find(item => evaluate(item.case));
      return evaluate(branch ? branch.then : operand.default);
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
      if (operator === '$not' && value instanceof RegExp) return !value.test(String(actual || ''));
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