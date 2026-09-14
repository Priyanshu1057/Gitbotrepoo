import { MongoClient, type Db } from "mongodb";

const uri = process.env.MONGODB_URI?.trim();
const databaseName = process.env.MONGODB_DB_NAME?.trim() || "zip_to_github";

if (!uri) {
  throw new Error("MONGODB_URI is required");
}

const client = new MongoClient(uri, {
  serverSelectionTimeoutMS: 10_000,
});

let databasePromise: Promise<Db> | undefined;

export function connectDatabase(): Promise<Db> {
  databasePromise ??= client
    .connect()
    .then(async () => {
      const database = client.db(databaseName);
      await Promise.all([
        database.collection("users").createIndex({ telegramUserId: 1 }, { unique: true }),
        database.collection("github_config").createIndex({ userId: 1 }, { unique: true }),
        database.collection("upload_jobs").createIndex({ userId: 1, createdAt: -1 }),
      ]);
      return database;
    })
    .catch((error) => {
      databasePromise = undefined;
      throw error;
    });
  return databasePromise;
}

export async function closeDatabase(): Promise<void> {
  await client.close();
  databasePromise = undefined;
}
