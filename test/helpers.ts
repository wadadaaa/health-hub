/** Shared bits of test scaffolding. */
import { composeBriefing } from '../src/briefing.js';
import type { Queryable } from '../src/db.js';

/** The briefing, named so a test reads as intent rather than plumbing. */
export const briefingFixture = (db: Queryable, day: string) => composeBriefing(db, day);
