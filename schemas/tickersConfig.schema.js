const { z } = require('zod');

const ShowOnSchema = z.enum(['home', 'category', 'article']);

const TickersConfigSchema = z.object({
  tickers: z.object({
    pauseOnHover: z.boolean().default(true),
    live: z.object({
      enabled: z.boolean(),
      speedSec: z.number().min(5).max(120),
      refreshSec: z.number().min(10).max(300),
      maxItems: z.number().int().min(1).max(30),
      showOn: z.array(ShowOnSchema),
      placeholder: z.string(),
    }),
    breaking: z.object({
      mode: z.enum(['auto', 'force_on', 'off']),
      showWhenEmpty: z.boolean(),
      speedSec: z.number().min(5).max(120),
      freshnessMinutes: z.number().min(0).max(1440),
      maxItems: z.number().int().min(1).max(30),
      placeholder: z.string(),
    }),
  }),
});

const DEFAULT_TICKERS_CONFIG = {
  tickers: {
    pauseOnHover: true,
    live: {
      enabled: true,
      speedSec: 24,
      refreshSec: 30,
      maxItems: 20,
      showOn: ['home'],
      placeholder: 'Live updates will appear here.',
    },
    breaking: {
      mode: 'auto',
      showWhenEmpty: true,
      speedSec: 18,
      freshnessMinutes: 180,
      maxItems: 10,
      placeholder: 'Breaking News',
    },
  },
};

module.exports = {
  TickersConfigSchema,
  DEFAULT_TICKERS_CONFIG,
};
