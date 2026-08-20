const CANONICAL_COMMUNITY_REPORTER_AGE_GROUPS = Object.freeze([
  'under_18',
  '18_24',
  '25_40',
  '41_plus',
]);

function normalizeAgeGroupToken(input) {
  if (typeof input !== 'string') return '';
  return input
    .trim()
    .toLowerCase()
    .replace(/\u00a0/g, ' ')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\u00e2\u20ac[\u0090-\u0095\u2018-\u201d]/g, '-')
    .replace(/\+/g, ' plus')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeAgeGroup(input) {
  const token = normalizeAgeGroupToken(input);
  switch (token) {
    case 'under_18':
    case 'under18':
      return 'under_18';
    case '18_24':
      return '18_24';
    case '25_40':
      return '25_40';
    case '41_plus':
    case '41plus':
      return '41_plus';
    default:
      return null;
  }
}

function buildAgeGroupValidationError() {
  return {
    field: 'ageGroup',
    code: 'invalid_enum',
    message: 'ageGroup must be one of: under_18, 18_24, 25_40, 41_plus',
    allowedValues: CANONICAL_COMMUNITY_REPORTER_AGE_GROUPS,
  };
}

function buildAgeGroupValidationResponse() {
  return {
    success: false,
    ok: false,
    code: 'VALIDATION_ERROR',
    error: 'VALIDATION_ERROR',
    fields: ['ageGroup'],
    fieldErrors: [buildAgeGroupValidationError()],
  };
}

module.exports = {
  CANONICAL_COMMUNITY_REPORTER_AGE_GROUPS,
  normalizeAgeGroup,
  buildAgeGroupValidationError,
  buildAgeGroupValidationResponse,
};