import { ObjectId, type Collection, type Document } from "mongodb";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { connectDatabase } from "./mongodb";

type UserDocument = {
  _id: ObjectId;
  telegramUserId: string;
  username?: string;
  role: "admin" | "user";
  access: "active" | "revoked";
  createdAt: Date;
  lastActivity: Date;
};

type GithubConfigDocument = {
  _id: ObjectId;
  userId: string;
  encryptedToken?: string;
  tokenIv?: string;
  tokenAuthTag?: string;
  defaultRepository: string | null;
  defaultBranch: string;
  createdAt: Date;
  updatedAt: Date;
};

type UploadJobDocument = {
  _id: ObjectId;
  userId: string;
  zipFilename: string;
  repository: string;
  branch: string;
  destinationPath: string;
  totalFiles: number;
  totalSize: string;
  status: string;
  createdFiles: number;
  updatedFiles: number;
  deletedFiles: number;
  commitSha?: string | null;
  error?: string | null;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  completedAt?: Date;
};

export type User = {
  id: string;
  telegramUserId: string;
  username?: string;
  role: "admin" | "user";
  access: "active" | "revoked";
  createdAt: Date;
  lastActivity: Date;
};

export type UploadJob = Omit<UploadJobDocument, "_id"> & { id: string };

async function collection<T extends Document>(name: string): Promise<Collection<T>> {
  return (await connectDatabase()).collection<T>(name);
}

function toUser(document: UserDocument): User {
  return {
    id: document._id.toHexString(),
    telegramUserId: document.telegramUserId,
    username: document.username,
    role: document.role ?? "user",
    access: document.access ?? "active",
    createdAt: document.createdAt,
    lastActivity: document.lastActivity,
  };
}

function toUploadJob(document: UploadJobDocument): UploadJob {
  const { _id, ...job } = document;
  return { ...job, id: _id.toHexString() };
}

function objectId(id: string): ObjectId {
  if (!ObjectId.isValid(id)) throw new Error("Invalid database record ID.");
  return new ObjectId(id);
}

export async function upsertUser(
  telegramUserId: string,
  username?: string,
  initialAccess: "active" | "revoked" = "active",
): Promise<User> {
  const users = await collection<UserDocument>("users");
  const now = new Date();
  const set: Partial<UserDocument> = { lastActivity: now };
  if (username !== undefined) set.username = username;
  await users.updateOne(
    { telegramUserId },
    {
      $set: set,
      $setOnInsert: { createdAt: now, role: "user", access: initialAccess },
    },
    { upsert: true },
  );
  const document = await users.findOne({ telegramUserId });
  if (!document) throw new Error("Could not load the MongoDB user record.");
  return toUser(document);
}

export async function getUserByTelegramId(telegramUserId: string): Promise<User | null> {
  const document = await (await collection<UserDocument>("users")).findOne({ telegramUserId });
  return document ? toUser(document) : null;
}

export async function ensureAdmin(telegramUserId: string, username?: string): Promise<User> {
  const user = await upsertUser(telegramUserId, username);
  await (await collection<UserDocument>("users")).updateOne(
    { telegramUserId },
    { $set: { role: "admin", access: "active", ...(username === undefined ? {} : { username }) } },
  );
  return { ...user, role: "admin", access: "active", ...(username === undefined ? {} : { username }) };
}

export async function listUsers(): Promise<User[]> {
  const documents = await (await collection<UserDocument>("users")).find({}).sort({ createdAt: 1 }).toArray();
  return documents.map(toUser);
}

export async function setUserAccess(telegramUserId: string, access: "active" | "revoked"): Promise<void> {
  await (await collection<UserDocument>("users")).updateOne({ telegramUserId }, { $set: { access } });
}

export async function touchUser(userId: string): Promise<void> {
  await (await collection<UserDocument>("users")).updateOne({ _id: objectId(userId) }, { $set: { lastActivity: new Date() } });
}

export async function saveDefaultRepository(userId: string, repository: string, branch: string): Promise<void> {
  const configs = await collection<GithubConfigDocument>("github_config");
  const now = new Date();
  await configs.updateOne(
    { userId },
    {
      $set: {
        defaultRepository: repository,
        defaultBranch: branch,
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
}

function encryptionKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

export function encryptGithubToken(token: string, secret: string): {
  encryptedToken: string;
  tokenIv: string;
  tokenAuthTag: string;
} {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return {
    encryptedToken: encrypted.toString("base64"),
    tokenIv: iv.toString("base64"),
    tokenAuthTag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptGithubToken(
  encryptedToken: string,
  tokenIv: string,
  tokenAuthTag: string,
  secret: string,
): string {
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(secret), Buffer.from(tokenIv, "base64"));
  decipher.setAuthTag(Buffer.from(tokenAuthTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedToken, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export async function saveGithubToken(userId: string, token: string, secret: string): Promise<void> {
  const configs = await collection<GithubConfigDocument>("github_config");
  const now = new Date();
  const encrypted = encryptGithubToken(token, secret);
  await configs.updateOne(
    { userId },
    {
      $set: { ...encrypted, updatedAt: now },
      $setOnInsert: { createdAt: now, defaultRepository: null, defaultBranch: "main" },
    },
    { upsert: true },
  );
}

export async function getGithubToken(userId: string, secret: string): Promise<string | null> {
  const document = await (await collection<GithubConfigDocument>("github_config")).findOne({ userId });
  if (!document?.encryptedToken || !document.tokenIv || !document.tokenAuthTag) return null;
  return decryptGithubToken(document.encryptedToken, document.tokenIv, document.tokenAuthTag, secret);
}

export async function hasGithubToken(userId: string): Promise<boolean> {
  const document = await (await collection<GithubConfigDocument>("github_config")).findOne({ userId });
  return Boolean(document?.encryptedToken && document.tokenIv && document.tokenAuthTag);
}

export async function clearGithubToken(userId: string): Promise<void> {
  await (await collection<GithubConfigDocument>("github_config")).updateOne(
    { userId },
    { $unset: { encryptedToken: "", tokenIv: "", tokenAuthTag: "" }, $set: { updatedAt: new Date() } },
  );
}

export async function getDefaultRepository(userId: string): Promise<{
  repository: string | null;
  branch: string;
} | null> {
  const document = await (await collection<GithubConfigDocument>("github_config")).findOne({ userId });
  return document
    ? { repository: document.defaultRepository, branch: document.defaultBranch }
    : null;
}

export async function createUploadJob(input: {
  userId: string;
  zipFilename: string;
  repository: string;
  branch: string;
  destinationPath: string;
  totalFiles: number;
  totalSize: number;
  metadata?: Record<string, unknown>;
}): Promise<UploadJob> {
  const now = new Date();
  const document: Omit<UploadJobDocument, "_id"> = {
    userId: input.userId,
    zipFilename: input.zipFilename,
    repository: input.repository,
    branch: input.branch,
    destinationPath: input.destinationPath,
    totalFiles: input.totalFiles,
    totalSize: String(input.totalSize),
    status: "awaiting_confirmation",
    createdFiles: 0,
    updatedFiles: 0,
    deletedFiles: 0,
    metadata: input.metadata,
    createdAt: now,
  };
  const result = await (await collection<UploadJobDocument>("upload_jobs")).insertOne(document as UploadJobDocument);
  return toUploadJob({ ...document, _id: result.insertedId });
}

export async function updateUploadJob(
  id: string,
  update: Partial<{
    repository: string;
    branch: string;
    destinationPath: string;
    status: string;
    createdFiles: number;
    updatedFiles: number;
    deletedFiles: number;
    commitSha: string | null;
    error: string | null;
    metadata: Record<string, unknown>;
    completedAt: Date;
  }>,
): Promise<void> {
  await (await collection<UploadJobDocument>("upload_jobs")).updateOne({ _id: objectId(id) }, { $set: update });
}

export async function getLatestUploadJob(userId: string): Promise<UploadJob | null> {
  const document = await (await collection<UploadJobDocument>("upload_jobs"))
    .find({
      userId,
      status: { $in: ["awaiting_confirmation", "uploading", "completed", "failed", "cancelled"] },
    })
    .sort({ createdAt: -1 })
    .limit(1)
    .next();
  return document ? toUploadJob(document) : null;
}
