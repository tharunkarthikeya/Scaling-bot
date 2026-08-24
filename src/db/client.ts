import { MongoClient, type Db } from 'mongodb';
import { config } from '../config.js';
import { logger } from '../logger.js';

let client: MongoClient | undefined;
let db: Db | undefined;

export async function connectDb(): Promise<Db> {
  if (db) return db;

  client = new MongoClient(config.MONGODB_URI, {
    maxPoolSize: 20,
    retryWrites: true,
  });

  await client.connect();
  db = client.db(config.MONGODB_DB);
  logger.info({ db: config.MONGODB_DB }, 'mongodb connected');
  return db;
}

export function getDb(): Db {
  if (!db) throw new Error('getDb() called before connectDb()');
  return db;
}

/**
 * The connection itself, for code that needs a second database on it.
 *
 * The ATS export writes into `resume_ats`, which lives on this same deployment
 * — a different database, not a different server. Handing out the client rather
 * than opening a second one is what keeps that a second handle on one pool
 * instead of a second pool nobody is counting.
 */
export function getMongoClient(): MongoClient {
  if (!client) throw new Error('getMongoClient() called before connectDb()');
  return client;
}

export async function closeDb(): Promise<void> {
  await client?.close();
  client = undefined;
  db = undefined;
}
