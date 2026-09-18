# News Pulse Backend - Agent Instructions

Read `BRAIN.md` before making repository changes.

Use current code and tests as the source of truth over historical documentation.

Protect production systems. Never expose or print `.env`, passwords, database credentials, JWT secrets, SMTP credentials, API keys, private keys, tokens, or other secret values.

Keep localhost/testing isolated from production database, authentication, email, OTP delivery, and destructive maintenance operations.

Preserve authentication, Founder authorization, public-content visibility rules, Reporter Portal protections, and security boundaries unless the requested change explicitly changes them.

Before running migrations, repair scripts, cleanup scripts, or other data-mutating utilities, inspect their target environment and behavior.

Keep changes focused. Do not combine unrelated cleanup or historical test fixes with the requested task.
