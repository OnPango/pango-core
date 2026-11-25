import { resetDatabase } from './database.js';

/** Starts every integration run from an empty local database. */
export default async function setup(): Promise<void> {
  await resetDatabase();
}
