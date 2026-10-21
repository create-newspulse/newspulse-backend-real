const { buildPublicCategoryFilter } = require('../lib/categories');
const {
  PublicNewsQueryError,
  parsePublicNewsPagination,
  buildPublicNewsBaseLanguageExpression,
  buildPublicNewsPagePipeline,
  listPublicNewsPage,
} = require('./publicNewsPagination.service');

const UNAVAILABLE_MESSAGE = 'News feed is temporarily unavailable. Please retry shortly.';

async function listFaithCultureNews({ filter, lang, page, limit, select, timingContext }) {
  // Explicit regex preserves category case compatibility without making story IDs/slugs case-insensitive.
  const faithFilter = {
    ...filter,
    category: buildPublicCategoryFilter('faith-culture'),
    $and: [...filter.$and, { visibility: { $not: /^private$/i } }],
  };
  return listPublicNewsPage({
    filter: faithFilter, lang, page, limit, select, timingContext, scope: 'faith',
  });
}

module.exports = {
  UNAVAILABLE_MESSAGE,
  FaithPaginationError: PublicNewsQueryError,
  parseFaithCulturePagination: parsePublicNewsPagination,
  buildPublicNewsBaseLanguageExpression,
  buildFaithCulturePagePipeline: buildPublicNewsPagePipeline,
  listFaithCultureNews,
};
