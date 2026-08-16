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

export async function closeDb(): Promise<void> {
  await client?.close();
  client = undefined;
  db = undefined;
}
