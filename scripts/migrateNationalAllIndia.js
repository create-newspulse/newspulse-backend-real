/*
Alias script (kept for naming consistency): backfill nationalLocation for National articles.

Usage:
  MONGODB_URI="..." node scripts/migrateNationalAllIndia.js

This delegates to the same logic as migrate-national-location.js.
*/

require('./migrate-national-location');
