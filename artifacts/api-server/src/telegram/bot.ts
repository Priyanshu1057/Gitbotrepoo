import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  clearGithubToken,
  createUploadJob,
  getGithubToken,
  getDefaultRepository,
  getLatestUploadJob,
  getUserByTelegramId,
  hasGithubToken,
  listUsers,
  saveDefaultRepository,
  saveGithubToken,
  setUserAccess,
  touchUser,
  updateUploadJob,
  upsertUser,
  ensureAdmin,
  type User,
} from "../database/repository";
import { formatBytes, type BotConfig } from "../config/env";
import {
  GithubApiError,
  GithubClient,
  type GithubOrganization,
  type GithubRepository,
  githubErrorForUser,
  joinGithubPath,
  splitRepository,
} from "../github/client";
import { isBootstrapAdmin } from "../security/authorization";
import {
  createTemporaryDirectory,
  extractZipSafely,
  removeTemporaryDirectory,
  stripSingleTopLevelDirectory,
  type ZipSummary,
} from "../zip/safe-extract";
import { logger } from "../lib/logger";
import {
  TelegramApi,
  type TelegramMessage,
  type TelegramUpdate,
  type TelegramUser,
} from "./api";

type Stage =
  | "awaiting_zip"
  | "awaiting_repository"
  | "awaiting_branch"
  | "awaiting_destination"
  | "awaiting_commit_message"
  | "awaiting_confirmation"
  | "uploading";

type Session = {
  userId: number;
  chatId: number;
  databaseUserId: string;
  username?: string;
  stage: Stage;
  tempDirectory: string;
  zipPath: string;
  zipFilename: string;
  summary: ZipSummary;
  strippedDirectory?: string;
  jobId: string;
  repository?: string;
  repositoryDefaultBranch?: string;
  branch?: string;
  branchOptions?: string[];
  destination?: string;
  commitMessage?: string;
  progressMessageId?: number;
  cancelRequested?: boolean;
  syncMode: "replace" | "merge";
};

type RepositoryCreationSession = {
  userId: number;
  chatId: number;
  databaseUserId: string;
  username?: string;
  stage: "awaiting_owner" | "awaiting_organization" | "awaiting_name" | "awaiting_description" | "awaiting_visibility" | "creating";
  organization?: string;
  name?: string;
  description?: string;
  private?: boolean;
};

type AdminSession = {
  userId: number;
  chatId: number;
  stage: "awaiting_user_id";
};

type RepoManagementSession = {
  userId: number;
  chatId: number;
  repository: string;
};

class UploadCancelledError extends Error {
  constructor() {
    super("Upload cancelled");
  }
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function keyboard(rows: Array<Array<{ text: string; callback_data: string }>>): Record<string, unknown> {
  return { inline_keyboard: rows };
}

function cancelKeyboard(): Record<string, unknown> {
  return keyboard([[{ text: "Cancel", callback_data: "zip:cancel" }]]);
}

function validateBranch(branch: string): string {
  const clean = branch.trim();
  if (!clean || clean.length > 255 || /[\s~^:?*\[\\]/.test(clean) || clean.includes("..") || clean.endsWith("/") || clean.startsWith("/")) {
    throw new Error("Branch names must be a valid Git branch name.");
  }
  return clean;
}

function validateDestination(destination: string): string {
  const clean = destination.trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (!clean) return "/";
  const normalized = clean.split("/").filter(Boolean).join("/");
  if (
    !normalized ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.split("/").some((part) => part === "." || part === ".." || part.includes("\0"))
  ) {
    throw new Error("Destination path is unsafe.");
  }
  return `/${normalized}`;
}

function validateRepositoryName(name: string): string {
  const clean = name.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(clean) || clean.endsWith(".git")) {
    throw new Error("Repository names must be 1–100 characters using letters, numbers, dots, hyphens, or underscores.");
  }
  return clean;
}

function validateOrganizationName(name: string): string {
  const clean = name.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(clean)) {
    throw new Error("Organization names must use the organization login shown by GitHub.");
  }
  return clean;
}

function commandName(text: string): string {
  return text.trim().split(/\s+/, 1)[0].split("@", 1)[0].toLowerCase();
}

function messageFromUpdate(update: TelegramUpdate): TelegramMessage | undefined {
  return update.message ?? update.callback_query?.message;
}

function archiveSummaryText(session: Session): string {
  const preview = session.summary.preview
    .slice(0, 30)
    .map((file) => `• ${escapeHtml(file)}`)
    .join("\n");
  const more = session.summary.fileCount > 30 ? `\n… and ${session.summary.fileCount - 30} more` : "";
  return [
    "<b>Archive ready</b>",
    "",
    `<b>Name:</b> ${escapeHtml(session.zipFilename)}`,
    `<b>Files:</b> ${session.summary.fileCount}`,
    `<b>Folders:</b> ${session.summary.folderCount}`,
    `<b>Size:</b> ${formatBytes(session.summary.totalSize)}`,
    "",
    "<b>Preview:</b>",
    `<pre>${preview}${more}</pre>`,
    session.strippedDirectory
      ? `\n<b>Removed wrapper folder:</b> <code>${escapeHtml(session.strippedDirectory)}/</code>\nFiles will be uploaded from the ZIP root.`
      : "",
  ].join("\n");
}

function progressText(total: number, processed: number, uploaded: number, updated: number): string {
  const percent = total === 0 ? 0 : Math.round((processed / total) * 100);
  const filled = Math.round(percent / 5);
  return [
    "<b>Uploading to GitHub…</b>",
    "",
    `${"█".repeat(filled)}${"░".repeat(20 - filled)} ${percent}%`,
    "",
    `Processed: ${processed} / ${total}`,
    `Uploaded: ${uploaded}`,
    `Updated: ${updated}`,
  ].join("\n");
}

export class TelegramBotService {
  private readonly api: TelegramApi;
  private readonly sessions = new Map<number, Session>();
  private readonly repositoryChoices = new Map<number, GithubRepository[]>();
  private readonly organizationChoices = new Map<number, GithubOrganization[]>();
  private readonly repositoryCreationSessions = new Map<number, RepositoryCreationSession>();
  private readonly adminSessions = new Map<number, AdminSession>();
  private readonly tokenSessions = new Map<number, { chatId: number }>();
  private readonly repoManagementSessions = new Map<number, RepoManagementSession>();
  private running = false;
  private nextUpdateOffset = 0;

  constructor(public readonly config: BotConfig) {
    this.api = new TelegramApi(config.telegramBotToken);
  }

  async start(): Promise<void> {
    try {
      await this.api.setMyCommands([
        { command: "start", description: "Open the interactive menu" },
        { command: "upload", description: "Upload a ZIP to GitHub" },
        { command: "newrepo", description: "Create a GitHub repository" },
        { command: "repos", description: "Choose from accessible repositories" },
        { command: "settings", description: "Show limits and saved defaults" },
        { command: "status", description: "Show the latest upload status" },
        { command: "token", description: "Set your private GitHub token" },
        { command: "cleartoken", description: "Remove your saved GitHub token" },
        { command: "repo", description: "Manage the default repository" },
        { command: "users", description: "Admin: manage bot users" },
        { command: "cancel", description: "Cancel the current upload" },
        { command: "help", description: "Show help and safety information" },
      ]);
    } catch (error) {
      logger.warn({ err: error }, "Could not register Telegram command menu");
    }
    if (this.config.telegramWebhookUrl) {
      await this.api.setWebhook(this.config.telegramWebhookUrl, this.config.telegramWebhookSecret);
      return;
    }
    await this.api.deleteWebhook();
    this.running = true;
    void this.poll();
  }

  stop(): void {
    this.running = false;
  }

  async handleWebhookUpdate(update: TelegramUpdate): Promise<void> {
    await this.handleUpdate(update);
  }

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.api.getUpdates(this.nextUpdateOffset, 50);
        for (const update of updates) {
          this.nextUpdateOffset = update.update_id + 1;
          await this.handleUpdate(update);
        }
      } catch (error) {
        logger.error({ err: error }, "Telegram polling failed");
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = messageFromUpdate(update);
    const user = update.callback_query?.from ?? message?.from;
    if (!message || !user) return;

    const telegramUserId = String(user.id);
    const isBootstrap = isBootstrapAdmin(this.config, user.id);
    try {
      const existingUser = await getUserByTelegramId(telegramUserId);
      const databaseUser = isBootstrap
        ? await ensureAdmin(telegramUserId, user.username)
        : existingUser ?? (await upsertUser(telegramUserId, user.username, "revoked"));
      if (!isBootstrap && databaseUser.access !== "active") {
        await this.api.sendMessage(
          message.chat.id,
          "This bot is private. Your access request is pending admin approval. Ask an admin to authorize your Telegram user ID.",
        );
        return;
      }
      await touchUser(databaseUser.id);
      if (update.callback_query) {
        await this.handleCallback(update.callback_query.id, update.callback_query.data ?? "", databaseUser.id, user, message);
      } else if (message.text) {
        await this.handleText(message, databaseUser.id, user);
      } else if (message.document) {
        await this.handleDocument(message, databaseUser.id, user);
      }
    } catch (error) {
      logger.error({ err: error }, "Telegram update failed");
      await this.api.sendMessage(message.chat.id, this.userFacingError(error));
    }
  }

  private userFacingError(error: unknown): string {
    if (error instanceof GithubApiError) return githubErrorForUser(error);
    if (error instanceof Error && /Unsafe archive path|invalid relative path|absolute path/i.test(error.message)) {
      return "The ZIP was rejected because it contains an unsafe path.";
    }
    if (error instanceof Error && error.message.includes("empty")) return "The ZIP is empty. Please send an archive containing at least one file.";
    if (
      error instanceof Error &&
      /ZIP|archive|extracted|compression|file limit|Repository must|Repository names|Organization names|Branch names|Destination path|Please send a file/i.test(error.message)
    ) {
      return `The ZIP could not be accepted: ${escapeHtml(error.message)}`;
    }
    return "Something went wrong. Nothing was uploaded. Please try again or use /help.";
  }

  private async handleText(message: TelegramMessage, databaseUserId: string, user: TelegramUser): Promise<void> {
    const text = message.text?.trim() ?? "";
    if (text.startsWith("/")) {
      await this.handleCommand(commandName(text), message, databaseUserId, user);
      return;
    }

    if (this.tokenSessions.has(user.id)) {
      await this.handleGithubToken(message, databaseUserId, user);
      return;
    }

    const adminSession = this.adminSessions.get(user.id);
    if (adminSession) {
      await this.handleAdminText(adminSession, text);
      return;
    }

    const repositoryCreation = this.repositoryCreationSessions.get(user.id);
    if (repositoryCreation) {
      await this.handleRepositoryCreationText(repositoryCreation, text);
      return;
    }

    const session = this.sessions.get(user.id);
    if (!session) {
      await this.api.sendMessage(message.chat.id, "Choose /upload to start an upload, or /help to see all commands.");
      return;
    }

    if (session.stage === "awaiting_repository") {
      await this.setRepository(session, text, databaseUserId);
      return;
    }

    if (session.stage === "awaiting_branch") {
      await this.setBranch(session, text);
      await this.askDestination(session);
      return;
    }

    if (session.stage === "awaiting_destination") {
      await this.setDestination(session, text);
      await this.askCommitMessage(session);
      return;
    }

    if (session.stage === "awaiting_commit_message") {
      if (!text) {
        await this.api.sendMessage(message.chat.id, "Please send a commit message or tap Use default message.", cancelKeyboard());
        return;
      }
      session.commitMessage = text.slice(0, 200);
      await this.showConfirmation(session);
      return;
    }

    await this.api.sendMessage(message.chat.id, "Please use the buttons in the current upload step, or /cancel.");
  }

  private async handleCommand(command: string, message: TelegramMessage, databaseUserId: string, user: TelegramUser): Promise<void> {
    switch (command) {
      case "/start":
        await this.api.sendMessage(
          message.chat.id,
          "<b>ZIP-to-GitHub Uploader</b>\n\nConnect your own GitHub token, manage repositories, and sync ZIP contents directly into a branch without creating a ZIP-name folder.",
          keyboard([
            [{ text: "Set GitHub token", callback_data: "token:set" }],
            [{ text: "Upload ZIP", callback_data: "zip:start" }],
            [{ text: "Create repository", callback_data: "repo:new" }],
            [
              { text: "Repositories", callback_data: "zip:repos" },
              { text: "Manage default repo", callback_data: "repo:manage" },
            ],
            [
              { text: "Bot users", callback_data: "admin:users" },
              { text: "Help", callback_data: "zip:help" },
            ],
          ]),
        );
        break;
      case "/help":
        await this.sendHelp(message.chat.id);
        break;
      case "/upload":
        await this.beginUpload(message, user, databaseUserId);
        break;
      case "/newrepo":
        await this.beginCreateRepository(message, user, databaseUserId);
        break;
      case "/repos":
        await this.listRepositories(message.chat.id, user.id, databaseUserId);
        break;
      case "/settings":
        await this.showSettings(message.chat.id, databaseUserId);
        break;
      case "/status":
        await this.showStatus(message.chat.id, databaseUserId);
        break;
      case "/token":
        await this.beginGithubToken(message, user.id);
        break;
      case "/cleartoken":
        await this.clearGithubToken(message.chat.id, databaseUserId);
        break;
      case "/repo":
        await this.beginRepoManagement(message.chat.id, databaseUserId, user.id);
        break;
      case "/users":
        await this.listManagedUsers(message.chat.id, databaseUserId, user.id);
        break;
      case "/cancel":
        await this.cancel(user.id, message.chat.id);
        break;
      default:
        await this.api.sendMessage(message.chat.id, "Unknown command. Use /help to see the available commands.");
    }
  }

  private async handleCallback(
    callbackId: string,
    data: string,
    databaseUserId: string,
    user: TelegramUser,
    message: TelegramMessage,
  ): Promise<void> {
    await this.api.answerCallbackQuery(callbackId);
    if (data === "repo:new") {
      await this.beginCreateRepository(message, user, databaseUserId);
      return;
    }
    if (data === "token:set") {
      await this.beginGithubToken(message, user.id);
      return;
    }
    if (data === "zip:start") {
      await this.beginUpload(message, user, databaseUserId);
      return;
    }
    if (data === "zip:help") {
      await this.sendHelp(message.chat.id);
      return;
    }
    if (data === "repo:manage") {
      await this.beginRepoManagement(message.chat.id, databaseUserId, user.id);
      return;
    }
    if (data === "admin:users") {
      await this.listManagedUsers(message.chat.id, databaseUserId, user.id);
      return;
    }
    if (data === "admin:add") {
      await this.beginAddUser(message.chat.id, user.id);
      return;
    }
    if (data.startsWith("admin:toggle:")) {
      await this.toggleManagedUser(data.slice("admin:toggle:".length), message.chat.id, databaseUserId, user.id);
      return;
    }
    if (data === "repo:manage:visibility:private" || data === "repo:manage:visibility:public") {
      await this.changeRepositoryVisibility(
        data.endsWith(":private"),
        message.chat.id,
        databaseUserId,
        user.id,
      );
      return;
    }
    if (data === "repo:manage:archive" || data === "repo:manage:unarchive") {
      await this.changeRepositoryArchive(
        data.endsWith(":archive"),
        message.chat.id,
        databaseUserId,
        user.id,
      );
      return;
    }
    if (data === "repo:manage:delete") {
      await this.api.sendMessage(
        message.chat.id,
        "<b>Delete repository?</b>\n\nThis permanently deletes the GitHub repository and cannot be undone.",
        keyboard([
          [{ text: "Yes, permanently delete", callback_data: "repo:manage:delete:confirm" }],
          [{ text: "Cancel", callback_data: "repo:manage:cancel" }],
        ]),
      );
      return;
    }
    if (data === "repo:manage:delete:confirm") {
      await this.deleteManagedRepository(message.chat.id, databaseUserId, user.id);
      return;
    }
    if (data === "repo:manage:cancel") {
      this.repoManagementSessions.delete(user.id);
      await this.api.sendMessage(message.chat.id, "Repository management closed.");
      return;
    }
    if (data.startsWith("repo:")) {
      await this.handleRepositoryCreationCallback(data, user.id, message);
      return;
    }
    if (data === "zip:repos") {
      await this.listRepositories(message.chat.id, user.id, databaseUserId);
      return;
    }
    const session = this.sessions.get(user.id);
    if (data.startsWith("zip:repo:") && !session) {
      const index = Number(data.slice("zip:repo:".length));
      const repository = this.repositoryChoices.get(user.id)?.[index];
      if (!repository) {
        await this.api.sendMessage(message.chat.id, "That repository choice expired. Send /repos to load it again.");
        return;
      }
      await saveDefaultRepository(databaseUserId, repository.full_name, repository.default_branch);
      await this.api.sendMessage(
        message.chat.id,
        `<b>Default repository saved</b>\n\n${escapeHtml(repository.full_name)}\nBranch: ${escapeHtml(repository.default_branch)}\n\nUse /upload to send a ZIP.`,
        keyboard([[{ text: "Upload ZIP", callback_data: "zip:start" }]]),
      );
      return;
    }
    if (data === "zip:cancel") {
      await this.cancel(user.id, message.chat.id);
      return;
    }
    if (!session) {
      await this.api.sendMessage(message.chat.id, "This upload session has expired. Use /upload to start again.");
      return;
    }
    if (data === "zip:repo:list" && session.stage === "awaiting_repository") {
      await this.listRepositories(message.chat.id, user.id, databaseUserId, true);
      return;
    }
    if (data === "zip:repo:default" && session.stage === "awaiting_repository") {
      const defaults = await getDefaultRepository(databaseUserId);
      if (!defaults?.repository) {
        await this.api.sendMessage(message.chat.id, "No saved repository yet. Choose one from GitHub or send owner/repository manually.");
        return;
      }
      await this.setRepository(session, defaults.repository, databaseUserId);
      return;
    }
    if (data.startsWith("zip:repo:") && session.stage === "awaiting_repository") {
      const index = Number(data.slice("zip:repo:".length));
      const repository = this.repositoryChoices.get(user.id)?.[index];
      if (!repository) {
        await this.api.sendMessage(message.chat.id, "That repository choice expired. Tap Choose from GitHub repositories again.");
        return;
      }
      await this.setRepository(session, repository.full_name, databaseUserId);
      return;
    }
    if (data === "zip:branch:default" && session.stage === "awaiting_branch") {
      await this.setBranch(session, session.repositoryDefaultBranch ?? "main");
      await this.askDestination(session);
      return;
    }
    if (data === "zip:branch:manual" && session.stage === "awaiting_branch") {
      await this.api.sendMessage(session.chatId, "Send the branch name, for example main or feature/my-change.", cancelKeyboard());
      return;
    }
    if (data.startsWith("zip:branch:") && session.stage === "awaiting_branch") {
      const index = Number(data.slice("zip:branch:".length));
      const branch = session.branchOptions?.[index];
      if (!branch) {
        await this.api.sendMessage(message.chat.id, "That branch choice expired. Choose the repository again.");
        return;
      }
      await this.setBranch(session, branch);
      await this.askDestination(session);
      return;
    }
    if (data.startsWith("zip:destination:root") && session.stage === "awaiting_destination") {
      session.syncMode = data.endsWith(":merge") ? "merge" : "replace";
      await this.setDestination(session, "/");
      await this.askCommitMessage(session);
      return;
    }
    if (data === "zip:message:default" && session.stage === "awaiting_commit_message") {
      session.commitMessage = `Upload ${session.zipFilename}`;
      await this.showConfirmation(session);
      return;
    }
    if (data === "zip:edit:repo" && session.stage === "awaiting_confirmation") {
      session.stage = "awaiting_repository";
      await this.promptRepository(session, databaseUserId);
      return;
    }
    if (data === "zip:edit:branch" && session.stage === "awaiting_confirmation") {
      session.stage = "awaiting_branch";
      await this.promptBranch(session);
      return;
    }
    if (data === "zip:edit:destination" && session.stage === "awaiting_confirmation") {
      session.stage = "awaiting_destination";
      await this.askDestination(session);
      return;
    }
    if (data === "zip:edit:message" && session.stage === "awaiting_confirmation") {
      session.stage = "awaiting_commit_message";
      await this.askCommitMessage(session);
      return;
    }
    if (data === "zip:preview" && session.stage === "awaiting_confirmation") {
      await this.previewUpload(session);
      return;
    }
    if (data === "zip:back" && session.stage === "awaiting_confirmation") {
      await this.showConfirmation(session);
      return;
    }
    if (data === "zip:confirm" && session.stage === "awaiting_confirmation") {
      session.stage = "uploading";
      session.progressMessageId = message.message_id;
      void this.upload(session);
      return;
    }
    await this.api.sendMessage(message.chat.id, "That action is no longer available. Use /upload to start again.");
  }

  private async githubClient(databaseUserId: string): Promise<GithubClient> {
    const token = await getGithubToken(databaseUserId, this.config.tokenEncryptionKey);
    if (!token) {
      throw new Error("No GitHub token is configured. Use /token to securely add your own GitHub token first.");
    }
    return new GithubClient(token);
  }

  private async beginGithubToken(message: TelegramMessage, userId: number): Promise<void> {
    if (this.sessions.has(userId) || this.repositoryCreationSessions.has(userId)) {
      await this.api.sendMessage(message.chat.id, "Finish or cancel the current flow before changing your GitHub token.");
      return;
    }
    this.tokenSessions.set(userId, { chatId: message.chat.id });
    await this.api.sendMessage(
      message.chat.id,
      "<b>Set your GitHub token</b>\n\nSend a GitHub fine-grained token with repository access. I will validate it, delete this Telegram message, and store it encrypted. Never share a token in a group chat.\n\nUse /cancel to stop.",
      cancelKeyboard(),
    );
  }

  private async handleGithubToken(message: TelegramMessage, databaseUserId: string, user: TelegramUser): Promise<void> {
    const token = message.text?.trim() ?? "";
    this.tokenSessions.delete(user.id);
    try {
      if (!token || token.length > 500) throw new Error("That token does not look valid.");
      try {
        await this.api.deleteMessage(message.chat.id, message.message_id);
      } catch (error) {
        logger.warn({ err: error, userId: user.id }, "Could not delete GitHub token message");
      }
      const github = new GithubClient(token);
      const profile = await github.getAuthenticatedUser();
      await saveGithubToken(databaseUserId, token, this.config.tokenEncryptionKey);
      await this.api.sendMessage(
        message.chat.id,
        `<b>GitHub token saved</b>\n\nConnected as <code>${escapeHtml(profile.login)}</code>. Your token is encrypted in the database and is only used for your GitHub actions.`,
        keyboard([
          [{ text: "Browse repositories", callback_data: "zip:repos" }],
          [{ text: "Upload ZIP", callback_data: "zip:start" }],
        ]),
      );
    } catch (error) {
      await this.api.sendMessage(
        message.chat.id,
        `The GitHub token could not be saved: ${this.userFacingError(error)}\n\nNothing was changed. Use /token to try again.`,
      );
    }
  }

  private async clearGithubToken(chatId: number, databaseUserId: string): Promise<void> {
    await clearGithubToken(databaseUserId);
    await this.api.sendMessage(chatId, "Your saved GitHub token was removed. Use /token to add a new one.");
  }

  private async handleAdminText(session: AdminSession, text: string): Promise<void> {
    if (session.stage !== "awaiting_user_id") return;
    if (!/^\d{5,20}$/.test(text)) {
      await this.api.sendMessage(session.chatId, "Send a numeric Telegram user ID, or use /cancel.");
      return;
    }
    const target = await upsertUser(text);
    await setUserAccess(text, "active");
    this.adminSessions.delete(session.userId);
    await this.api.sendMessage(
      session.chatId,
      `<b>User authorized</b>\n\nTelegram ID: <code>${escapeHtml(text)}</code>\nStatus: active\n\nThey must use /token to connect their own GitHub account.`,
      keyboard([[{ text: "Manage users", callback_data: "admin:users" }]]),
    );
    logger.info({ adminUserId: session.userId, telegramUserId: target.telegramUserId }, "Telegram user authorized");
  }

  private async beginAddUser(chatId: number, adminTelegramUserId: number): Promise<void> {
    this.adminSessions.set(adminTelegramUserId, {
      userId: adminTelegramUserId,
      chatId,
      stage: "awaiting_user_id",
    });
    await this.api.sendMessage(
      chatId,
      "<b>Add a user</b>\n\nSend the user's numeric Telegram ID. They will be able to use the bot, but their GitHub token remains separate from yours.",
      cancelKeyboard(),
    );
  }

  private async listManagedUsers(chatId: number, databaseUserId: string, telegramUserId: number): Promise<void> {
    const current = await getUserByTelegramId(String(telegramUserId));
    if (!current || current.role !== "admin") {
      await this.api.sendMessage(chatId, "Only admins can manage bot users.");
      return;
    }
    const users = await listUsers();
    const rows: Array<Array<{ text: string; callback_data: string }>> = [];
    const lines = ["<b>Bot users</b>", ""];
    for (const user of users) {
      lines.push(
        `${user.access === "active" ? "●" : "○"} <code>${escapeHtml(user.telegramUserId)}</code> — ${user.role}, ${user.access}`,
      );
      if (user.telegramUserId !== String(telegramUserId) && user.role !== "admin") {
        rows.push([
          {
            text: `${user.access === "active" ? "Revoke" : "Authorize"} ${user.telegramUserId}`.slice(0, 60),
            callback_data: `admin:toggle:${user.telegramUserId}`,
          },
        ]);
      }
    }
    if (users.length === 0) lines.push("No users have opened the bot yet.");
    rows.push([{ text: "Add user", callback_data: "admin:add" }]);
    await this.api.sendMessage(chatId, lines.join("\n"), keyboard(rows));
  }

  private async toggleManagedUser(
    telegramUserId: string,
    chatId: number,
    databaseUserId: string,
    adminTelegramUserId: number,
  ): Promise<void> {
    const admin = await getUserByTelegramId(String(adminTelegramUserId));
    if (!admin || admin.role !== "admin") {
      await this.api.sendMessage(chatId, "Only admins can manage bot users.");
      return;
    }
    const target = await getUserByTelegramId(telegramUserId);
    if (!target || target.role === "admin") {
      await this.api.sendMessage(chatId, "Admin accounts cannot be changed from this menu.");
      return;
    }
    const nextAccess = target.access === "active" ? "revoked" : "active";
    await setUserAccess(telegramUserId, nextAccess);
    await this.api.sendMessage(chatId, `User <code>${escapeHtml(telegramUserId)}</code> is now <b>${nextAccess}</b>.`);
    await this.listManagedUsers(chatId, databaseUserId, adminTelegramUserId);
  }

  private async beginRepoManagement(chatId: number, databaseUserId: string, telegramUserId: number): Promise<void> {
    const defaults = await getDefaultRepository(databaseUserId);
    if (!defaults?.repository) {
      await this.api.sendMessage(chatId, "No default repository is saved yet. Use /repos to choose one or /newrepo to create one.");
      return;
    }
    const parsed = splitRepository(defaults.repository);
    const repository = await (await this.githubClient(databaseUserId)).getRepository(parsed.owner, parsed.name);
    this.repoManagementSessions.set(telegramUserId, { userId: telegramUserId, chatId, repository: repository.full_name });
    await this.sendRepositoryManagement(chatId, repository);
  }

  private async sendRepositoryManagement(chatId: number, repository: GithubRepository): Promise<void> {
    await this.api.sendMessage(
      chatId,
      [
        "<b>Repository management</b>",
        "",
        `<b>Repository:</b> <code>${escapeHtml(repository.full_name)}</code>`,
        `<b>Visibility:</b> ${repository.private ? "Private" : "Public"}`,
        `<b>Archived:</b> ${repository.archived ? "Yes" : "No"}`,
        "",
        "Changes apply immediately to GitHub.",
      ].join("\n"),
      keyboard([
        [
          { text: "Make private", callback_data: "repo:manage:visibility:private" },
          { text: "Make public", callback_data: "repo:manage:visibility:public" },
        ],
        [{ text: repository.archived ? "Unarchive" : "Archive", callback_data: `repo:manage:${repository.archived ? "unarchive" : "archive"}` }],
        [{ text: "Delete repository", callback_data: "repo:manage:delete" }],
        [{ text: "Close", callback_data: "repo:manage:cancel" }],
      ]),
    );
  }

  private async managedRepository(databaseUserId: string, telegramUserId: number): Promise<{ owner: string; name: string; repository: GithubRepository }> {
    const session = this.repoManagementSessions.get(telegramUserId);
    const defaults = await getDefaultRepository(databaseUserId);
    const value = session?.repository ?? defaults?.repository;
    if (!value) throw new Error("No default repository is saved. Use /repos first.");
    const parsed = splitRepository(value);
    const repository = await (await this.githubClient(databaseUserId)).getRepository(parsed.owner, parsed.name);
    return { ...parsed, repository };
  }

  private async changeRepositoryVisibility(privateRepo: boolean, chatId: number, databaseUserId: string, telegramUserId: number): Promise<void> {
    const current = await this.managedRepository(databaseUserId, telegramUserId);
    const repository = await (await this.githubClient(databaseUserId)).updateRepository(current.owner, current.name, { private: privateRepo });
    await this.api.sendMessage(chatId, `<b>Repository updated</b>\n\n${escapeHtml(repository.full_name)} is now <b>${privateRepo ? "private" : "public"}</b>.`);
    await this.sendRepositoryManagement(chatId, repository);
  }

  private async changeRepositoryArchive(archived: boolean, chatId: number, databaseUserId: string, telegramUserId: number): Promise<void> {
    const current = await this.managedRepository(databaseUserId, telegramUserId);
    const repository = await (await this.githubClient(databaseUserId)).updateRepository(current.owner, current.name, { archived });
    await this.api.sendMessage(chatId, `<b>Repository updated</b>\n\n${escapeHtml(repository.full_name)} is now ${archived ? "archived" : "active"}.`);
    await this.sendRepositoryManagement(chatId, repository);
  }

  private async deleteManagedRepository(chatId: number, databaseUserId: string, telegramUserId: number): Promise<void> {
    const current = await this.managedRepository(databaseUserId, telegramUserId);
    await (await this.githubClient(databaseUserId)).deleteRepository(current.owner, current.name);
    this.repoManagementSessions.delete(telegramUserId);
    await this.api.sendMessage(chatId, `<b>Repository deleted</b>\n\n<code>${escapeHtml(`${current.owner}/${current.name}`)}</code> was permanently deleted from GitHub.`);
  }

  private async beginUpload(message: TelegramMessage, user: TelegramUser, databaseUserId: string): Promise<void> {
    if (this.repositoryCreationSessions.has(user.id)) {
      await this.api.sendMessage(message.chat.id, "Finish or cancel the repository creation flow before starting an upload.");
      return;
    }
    const existing = this.sessions.get(user.id);
    if (existing) {
      await this.api.sendMessage(message.chat.id, "An upload is already in progress. Use /cancel before starting another one.");
      return;
    }
    this.sessions.set(user.id, {
      userId: user.id,
      chatId: message.chat.id,
      databaseUserId,
      username: user.username,
      stage: "awaiting_zip",
      tempDirectory: "",
      zipPath: "",
      zipFilename: "",
      summary: { files: [], fileCount: 0, folderCount: 0, totalSize: 0, preview: [] },
      jobId: "",
      syncMode: "replace",
    });
    await this.api.sendMessage(message.chat.id, "📦 Please send your ZIP file.", cancelKeyboard());
  }

  private async beginCreateRepository(message: TelegramMessage, user: TelegramUser, databaseUserId: string): Promise<void> {
    if (this.sessions.has(user.id)) {
      await this.api.sendMessage(message.chat.id, "Finish or cancel the current upload before creating a repository.");
      return;
    }
    if (this.repositoryCreationSessions.has(user.id)) {
      await this.api.sendMessage(message.chat.id, "A repository creation flow is already open. Use the buttons below or /cancel.");
      return;
    }
    const session: RepositoryCreationSession = {
      userId: user.id,
      chatId: message.chat.id,
      databaseUserId,
      username: user.username,
      stage: "awaiting_owner",
    };
    this.repositoryCreationSessions.set(user.id, session);
    await this.api.sendMessage(
      message.chat.id,
      "<b>Create a GitHub repository</b>\n\nThe repository will be initialized with a README so it is ready for the ZIP uploader.",
      keyboard([
        [{ text: "Personal account", callback_data: "repo:personal" }],
        [{ text: "Organization", callback_data: "repo:organization" }],
        [{ text: "Cancel", callback_data: "repo:cancel" }],
      ]),
    );
  }

  private async handleRepositoryCreationText(session: RepositoryCreationSession, text: string): Promise<void> {
    if (session.stage === "awaiting_organization") {
      session.organization = validateOrganizationName(text);
      session.stage = "awaiting_name";
      await this.promptRepositoryName(session);
      return;
    }
    if (session.stage === "awaiting_name") {
      session.name = validateRepositoryName(text);
      session.stage = "awaiting_description";
      await this.promptRepositoryDescription(session);
      return;
    }
    if (session.stage === "awaiting_description") {
      session.description = text.slice(0, 350);
      session.stage = "awaiting_visibility";
      await this.promptRepositoryVisibility(session);
      return;
    }
    await this.api.sendMessage(session.chatId, "Use the buttons in the repository creation flow, or /cancel.");
  }

  private async handleRepositoryCreationCallback(data: string, userId: number, message: TelegramMessage): Promise<void> {
    const session = this.repositoryCreationSessions.get(userId);
    if (!session) {
      await this.api.sendMessage(message.chat.id, "That repository creation flow expired. Use /newrepo to start again.");
      return;
    }
    if (data === "repo:cancel") {
      this.repositoryCreationSessions.delete(userId);
      await this.api.sendMessage(message.chat.id, "Repository creation cancelled.");
      return;
    }
    if (data === "repo:personal" && session.stage === "awaiting_owner") {
      session.stage = "awaiting_name";
      await this.promptRepositoryName(session);
      return;
    }
    if (data === "repo:organization" && session.stage === "awaiting_owner") {
      const github = await this.githubClient(session.databaseUserId);
      const organizations = await github.listOrganizations();
      this.organizationChoices.set(userId, organizations);
      const rows = organizations.slice(0, 20).map((organization, index) => [
        { text: organization.login.slice(0, 60), callback_data: `repo:org:${index}` },
      ]);
      rows.push([{ text: "Enter organization login", callback_data: "repo:org:manual" }]);
      rows.push([{ text: "Cancel", callback_data: "repo:cancel" }]);
      await this.api.sendMessage(
        message.chat.id,
        organizations.length
          ? "<b>Choose an organization</b>\n\nSelect an organization or enter its GitHub login manually."
          : "No organizations were returned for this token. Enter the organization login manually.",
        keyboard(rows),
      );
      return;
    }
    if (data === "repo:org:manual" && session.stage === "awaiting_owner") {
      session.stage = "awaiting_organization";
      await this.api.sendMessage(message.chat.id, "Send the GitHub organization login.", cancelKeyboard());
      return;
    }
    if (data.startsWith("repo:org:") && session.stage === "awaiting_owner") {
      const index = Number(data.slice("repo:org:".length));
      const organization = this.organizationChoices.get(userId)?.[index];
      if (!organization) {
        await this.api.sendMessage(message.chat.id, "That organization choice expired. Start /newrepo again.");
        return;
      }
      session.organization = organization.login;
      session.stage = "awaiting_name";
      await this.promptRepositoryName(session);
      return;
    }
    if (data === "repo:description:skip" && session.stage === "awaiting_description") {
      session.description = "";
      session.stage = "awaiting_visibility";
      await this.promptRepositoryVisibility(session);
      return;
    }
    if (data === "repo:visibility:private" && session.stage === "awaiting_visibility") {
      session.private = true;
      await this.finishRepositoryCreation(session);
      return;
    }
    if (data === "repo:visibility:public" && session.stage === "awaiting_visibility") {
      session.private = false;
      await this.finishRepositoryCreation(session);
      return;
    }
    await this.api.sendMessage(message.chat.id, "That repository action is no longer available. Use /newrepo to start again.");
  }

  private async promptRepositoryName(session: RepositoryCreationSession): Promise<void> {
    await this.api.sendMessage(
      session.chatId,
      `${session.organization ? `<b>Organization:</b> ${escapeHtml(session.organization)}\n\n` : ""}Send a repository name (1–100 letters, numbers, dots, hyphens, or underscores).`,
      cancelKeyboard(),
    );
  }

  private async promptRepositoryDescription(session: RepositoryCreationSession): Promise<void> {
    await this.api.sendMessage(
      session.chatId,
      "Send an optional repository description, or tap Skip.",
      keyboard([
        [{ text: "Skip description", callback_data: "repo:description:skip" }],
        [{ text: "Cancel", callback_data: "repo:cancel" }],
      ]),
    );
  }

  private async promptRepositoryVisibility(session: RepositoryCreationSession): Promise<void> {
    await this.api.sendMessage(
      session.chatId,
      "<b>Repository visibility</b>\n\nPrivate is recommended unless you intentionally want the code publicly visible.",
      keyboard([
        [{ text: "Private", callback_data: "repo:visibility:private" }],
        [{ text: "Public", callback_data: "repo:visibility:public" }],
        [{ text: "Cancel", callback_data: "repo:cancel" }],
      ]),
    );
  }

  private async finishRepositoryCreation(session: RepositoryCreationSession): Promise<void> {
    if (!session.name || session.private === undefined) {
      throw new Error("Repository creation details are incomplete.");
    }
    session.stage = "creating";
    await this.api.sendMessage(session.chatId, "Creating and initializing the GitHub repository…");
    try {
      const repository = await (await this.githubClient(session.databaseUserId)).createRepository({
        name: session.name,
        description: session.description,
        private: session.private,
        organization: session.organization,
      });
      const branch = repository.default_branch || "main";
       await saveDefaultRepository(session.databaseUserId, repository.full_name, branch);
      await this.api.sendMessage(
        session.chatId,
        [
          "<b>Repository created</b>",
          "",
          `📦 <a href="${repository.html_url}">${escapeHtml(repository.full_name)}</a>`,
          `🔒 Visibility: ${repository.private ? "Private" : "Public"}`,
          `🌿 Default branch: ${escapeHtml(branch)}`,
          "",
          "It is now saved as your default repository.",
        ].join("\n"),
        keyboard([
          [{ text: "Upload ZIP here", callback_data: "zip:start" }],
          [{ text: "Create another repository", callback_data: "repo:new" }],
        ]),
      );
    } catch (error) {
      logger.error({ err: error, userId: session.userId }, "GitHub repository creation failed");
      const creationError =
        error instanceof GithubApiError && error.status === 403
          ? "GitHub denied repository creation. Confirm the token can create repositories in this account or organization."
          : this.userFacingError(error);
      await this.api.sendMessage(
        session.chatId,
        `${creationError}\n\nCheck the token's repository creation permission and try again.`,
        keyboard([[{ text: "Try again", callback_data: "repo:new" }]]),
      );
    } finally {
      this.repositoryCreationSessions.delete(session.userId);
      this.organizationChoices.delete(session.userId);
    }
  }

  private async handleDocument(message: TelegramMessage, databaseUserId: string, user: TelegramUser): Promise<void> {
    const session = this.sessions.get(user.id);
    if (!session || session.stage !== "awaiting_zip" || !message.document) {
      await this.api.sendMessage(message.chat.id, "Use /upload first, then send a ZIP file.");
      return;
    }
    try {
      const filename = message.document.file_name ?? "upload.zip";
      if (!filename.toLowerCase().endsWith(".zip")) throw new Error("Please send a file with a .zip extension.");
      if (message.document.file_size && message.document.file_size > this.config.maxZipSizeBytes) {
        throw new Error(`The ZIP is larger than the ${Math.round(this.config.maxZipSizeBytes / 1024 / 1024)} MB limit.`);
      }

      session.tempDirectory = await createTemporaryDirectory();
      session.zipFilename = filename;
      session.zipPath = path.join(session.tempDirectory, "archive.zip");
      await this.api.sendMessage(message.chat.id, "Downloading and securely inspecting the archive…");
      const file = await this.api.getFile(message.document.file_id);
      if (!file.file_path) throw new Error("Telegram did not return a downloadable file path.");
      await this.api.downloadFile(file.file_path, session.zipPath, this.config.maxZipSizeBytes);
      const zipStats = await stat(session.zipPath);
      if (zipStats.size > this.config.maxZipSizeBytes) {
        throw new Error(`The ZIP is larger than the ${Math.round(this.config.maxZipSizeBytes / 1024 / 1024)} MB limit.`);
      }
      const extractionDirectory = path.join(session.tempDirectory, "extracted");
       const extracted = await extractZipSafely(session.zipPath, extractionDirectory, {
        maxFiles: this.config.maxFilesPerZip,
        maxExtractedSize: this.config.maxExtractedSizeBytes,
        maxCompressionRatio: this.config.maxCompressionRatio,
      });
       const normalized = stripSingleTopLevelDirectory(extracted);
       session.summary = normalized.summary;
       session.strippedDirectory = normalized.strippedDirectory;
      const dbUser = await upsertUser(String(user.id), user.username);
      const job = await createUploadJob({
        userId: dbUser.id,
        zipFilename: filename,
        repository: "pending",
        branch: "pending",
        destinationPath: "/",
        totalFiles: session.summary.fileCount,
        totalSize: session.summary.totalSize,
        metadata: { files: session.summary.files.map((file) => ({ relativePath: file.relativePath, size: file.size })) },
      });
      session.jobId = job.id;
      session.stage = "awaiting_repository";
      await this.api.sendMessage(message.chat.id, archiveSummaryText(session));
      await this.promptRepository(session, databaseUserId);
    } catch (error) {
      logger.warn({ err: error, userId: user.id }, "ZIP preparation failed");
      if (session.jobId) {
        await updateUploadJob(session.jobId, { status: "failed", error: error instanceof Error ? error.message : "ZIP preparation failed", completedAt: new Date() });
      }
      await removeTemporaryDirectory(session.tempDirectory);
      session.tempDirectory = "";
      session.zipPath = "";
      session.jobId = "";
      session.stage = "awaiting_zip";
      await this.api.sendMessage(message.chat.id, `${this.userFacingError(error)}\n\nYou can send another ZIP, or use /cancel.`);
    }
  }

  private async promptRepository(session: Session, databaseUserId: string): Promise<void> {
    const defaults = await getDefaultRepository(databaseUserId);
    const rows: Array<Array<{ text: string; callback_data: string }>> = [];
    if (defaults?.repository) {
      rows.push([{ text: `Use ${defaults.repository}`.slice(0, 60), callback_data: "zip:repo:default" }]);
    }
    rows.push([{ text: "Choose from GitHub repositories", callback_data: "zip:repo:list" }]);
    rows.push([{ text: "Cancel", callback_data: "zip:cancel" }]);
    await this.api.sendMessage(
      session.chatId,
      defaults?.repository
        ? `<b>Repository</b>\n\nSaved default: <code>${escapeHtml(defaults.repository)}</code>\n\nChoose it, browse accessible repositories, or send <code>owner/repository</code> manually.`
        : "<b>Repository</b>\n\nChoose from accessible GitHub repositories or send <code>owner/repository</code> manually.",
      keyboard(rows),
    );
  }

  private async setRepository(session: Session, value: string, databaseUserId: string): Promise<void> {
    const parsed = splitRepository(value);
    const github = await this.githubClient(databaseUserId);
    const repository = await github.getRepository(parsed.owner, parsed.name);
    session.repository = repository.full_name || `${parsed.owner}/${parsed.name}`;
    session.repositoryDefaultBranch = repository.default_branch || "main";
    session.branch = undefined;
    session.branchOptions = undefined;
    await updateUploadJob(session.jobId, { repository: session.repository, status: "awaiting_confirmation" });
    await saveDefaultRepository(databaseUserId, session.repository, session.repositoryDefaultBranch);
    session.stage = "awaiting_branch";
    await this.promptBranch(session);
  }

  private async promptBranch(session: Session): Promise<void> {
    if (!session.repository) throw new Error("Choose a repository before selecting a branch.");
    const { owner, name } = splitRepository(session.repository);
    const user = await getUserByTelegramId(String(session.userId));
    if (!user) throw new Error("Telegram user record not found.");
    const github = await this.githubClient(user.id);
    const branches = await github.listBranches(owner, name);
    const names = [
      ...(session.repositoryDefaultBranch ? [session.repositoryDefaultBranch] : []),
      ...branches.map((branch) => branch.name),
    ].filter((name, index, all) => all.indexOf(name) === index).slice(0, 8);
    session.branchOptions = names;
    const rows: Array<Array<{ text: string; callback_data: string }>> = [];
    if (session.repositoryDefaultBranch) {
      rows.push([{ text: `Use ${session.repositoryDefaultBranch} (default)`.slice(0, 60), callback_data: "zip:branch:default" }]);
    }
    const alternateBranches = names.filter((name) => name !== session.repositoryDefaultBranch);
    for (let index = 0; index < alternateBranches.length; index += 2) {
      rows.push(
        alternateBranches.slice(index, index + 2).map((name, offset) => ({
          text: name.slice(0, 28),
          callback_data: `zip:branch:${names.indexOf(name)}`,
        })),
      );
    }
    rows.push([{ text: "Enter a different branch", callback_data: "zip:branch:manual" }]);
    rows.push([{ text: "Cancel", callback_data: "zip:cancel" }]);
    await this.api.sendMessage(
      session.chatId,
      names.length
        ? "<b>Branch</b>\n\nChoose an existing branch or enter another branch name."
        : "No branches were returned. Send the branch name manually.",
      keyboard(rows),
    );
  }

  private async askDestination(session: Session): Promise<void> {
    await this.api.sendMessage(
      session.chatId,
      "<b>Upload mode</b>\n\nBy default, the ZIP is synced into the repository root: files with the same path are replaced and old files missing from the ZIP are removed. This avoids creating a folder named after the ZIP.\n\nChoose sync mode, or send a destination directory such as <code>apps/web</code>.",
      keyboard([
        [{ text: "Sync ZIP to repository root", callback_data: "zip:destination:root:replace" }],
        [{ text: "Add/update at repository root", callback_data: "zip:destination:root:merge" }],
        [{ text: "Cancel", callback_data: "zip:cancel" }],
      ]),
    );
  }

  private async setBranch(session: Session, value: string): Promise<void> {
    session.branch = validateBranch(value);
    await updateUploadJob(session.jobId, { branch: session.branch });
    session.stage = "awaiting_destination";
  }

  private async setDestination(session: Session, value: string): Promise<void> {
    session.destination = validateDestination(value);
    await updateUploadJob(session.jobId, { destinationPath: session.destination });
    session.stage = "awaiting_commit_message";
  }

  private async askCommitMessage(session: Session): Promise<void> {
    await this.api.sendMessage(
      session.chatId,
      "Optional commit message. Send one now, or use the default message.",
      keyboard([
        [{ text: "Use default message", callback_data: "zip:message:default" }],
        [{ text: "Cancel", callback_data: "zip:cancel" }],
      ]),
    );
  }

  private async showConfirmation(session: Session): Promise<void> {
    session.stage = "awaiting_confirmation";
    await updateUploadJob(session.jobId, { status: "awaiting_confirmation" });
    const destination = session.destination ?? "/";
    const message = [
      archiveSummaryText(session),
      "",
      `<b>Repository:</b> ${escapeHtml(session.repository ?? "")}`,
      `<b>Branch:</b> ${escapeHtml(session.branch ?? "")}`,
      `<b>Destination:</b> ${escapeHtml(destination)}`,
      `<b>Commit:</b> ${escapeHtml(session.commitMessage ?? `Upload ${session.zipFilename}`)}`,
      "",
       session.strippedDirectory
         ? `The common wrapper folder ${session.strippedDirectory}/ was removed, so its files will be uploaded from the repository root.`
         : "The ZIP paths will be preserved exactly.",
    ].join("\n");
    const sent = await this.api.sendMessage(
      session.chatId,
      message,
      keyboard([
        [{ text: "Preview GitHub changes", callback_data: "zip:preview" }],
        [{ text: "Upload", callback_data: "zip:confirm" }],
          [
            { text: "Change repository", callback_data: "zip:edit:repo" },
            { text: "Change branch", callback_data: "zip:edit:branch" },
          ],
          [
            { text: "Change destination", callback_data: "zip:edit:destination" },
            { text: "Change message", callback_data: "zip:edit:message" },
          ],
        [{ text: "Cancel", callback_data: "zip:cancel" }],
      ]),
    );
    session.progressMessageId = sent.message_id;
  }

  private async upload(session: Session): Promise<void> {
    let processed = 0;
    let created = 0;
    let updated = 0;
    try {
      if (!session.repository || !session.branch || !session.destination || !session.jobId) {
        throw new Error("Upload session is incomplete.");
      }
      const { owner, name } = splitRepository(session.repository);
       const github = await this.githubClient(session.databaseUserId);
      await github.getRepository(owner, name);
      const parentCommit = await github.getBranchCommit(owner, name, session.branch);
      const baseTree = await github.getCommitTree(owner, name, parentCommit);
      const existingPaths = await github.getExistingPaths(owner, name, baseTree);
       const entries: Array<{ path: string; sha: string | null }> = [];
       const uploadedPaths = new Set<string>();
       let deleted = 0;
      const messageId = session.progressMessageId;
      if (messageId) await this.api.editMessageText(session.chatId, messageId, progressText(session.summary.fileCount, 0, 0, 0));

      for (const file of session.summary.files) {
        if (session.cancelRequested) throw new UploadCancelledError();
        const githubPath = joinGithubPath(session.destination, file.relativePath);
        const sha = await github.createBlob(owner, name, file.absolutePath);
        entries.push({ path: githubPath, sha });
         uploadedPaths.add(githubPath);
        if (existingPaths.has(githubPath)) updated++;
        else created++;
        processed++;
        if (messageId && (processed === session.summary.fileCount || processed % 5 === 0)) {
          await this.api.editMessageText(session.chatId, messageId, progressText(session.summary.fileCount, processed, created, updated));
        }
        await updateUploadJob(session.jobId, { createdFiles: created, updatedFiles: updated, status: "uploading" });
      }

       if (session.syncMode === "replace") {
         const destinationPrefix = session.destination === "/" ? "" : `${session.destination.replace(/^\/+|\/+$/g, "")}/`;
         for (const existingPath of existingPaths) {
           const isInsideDestination = destinationPrefix === "" || existingPath.startsWith(destinationPrefix);
           if (isInsideDestination && !uploadedPaths.has(existingPath)) {
             entries.push({ path: existingPath, sha: null });
             deleted++;
           }
         }
       }

      const tree = await github.createTree(owner, name, baseTree, entries);
      const commit = await github.createCommit(
        owner,
        name,
        session.commitMessage ?? `Upload ${session.zipFilename}`,
        tree,
        parentCommit,
      );
      await github.updateBranch(owner, name, session.branch, commit.sha);
      await updateUploadJob(session.jobId, {
        status: "completed",
        createdFiles: created,
        updatedFiles: updated,
         deletedFiles: deleted,
        commitSha: commit.sha,
        completedAt: new Date(),
      });
       await saveDefaultRepository(session.databaseUserId, session.repository, session.branch);

      const commitUrl = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commit/${commit.sha}`;
      const finalText = [
        "<b>Upload completed!</b>",
        "",
        `📦 ZIP: ${escapeHtml(session.zipFilename)}`,
        `📁 Files: ${session.summary.fileCount}`,
        `📂 Folders: ${session.summary.folderCount}`,
        "",
        `🆕 Created: ${created}`,
         `🔄 Updated: ${updated}`,
         `🗑 Removed: ${deleted}`,
        "",
        `📌 Repository: ${escapeHtml(session.repository)}`,
        `🌿 Branch: ${escapeHtml(session.branch)}`,
        `📝 Commit: <code>${escapeHtml(commit.sha.slice(0, 12))}</code>`,
        "",
        `<a href="${commitUrl}">View on GitHub</a>`,
      ].join("\n");
      if (messageId) await this.api.editMessageText(session.chatId, messageId, finalText);
      else await this.api.sendMessage(session.chatId, finalText);
    } catch (error) {
      if (error instanceof UploadCancelledError) {
        await updateUploadJob(session.jobId, { status: "cancelled", error: "Cancelled by user", completedAt: new Date() });
        if (session.progressMessageId) await this.api.editMessageText(session.chatId, session.progressMessageId, "Upload cancelled. No new commit was created.");
      } else {
        const detail = error instanceof Error ? error.message : "Unexpected upload error";
        await updateUploadJob(session.jobId, { status: "failed", error: detail, createdFiles: created, updatedFiles: updated, completedAt: new Date() });
        if (session.progressMessageId) await this.api.editMessageText(session.chatId, session.progressMessageId, this.userFacingError(error));
        else await this.api.sendMessage(session.chatId, this.userFacingError(error));
        logger.error({ err: error }, "GitHub upload failed");
      }
    } finally {
      await removeTemporaryDirectory(session.tempDirectory);
      this.sessions.delete(session.userId);
    }
  }

  private async previewUpload(session: Session): Promise<void> {
    try {
      if (!session.repository || !session.branch || !session.destination) {
        throw new Error("Upload session is incomplete.");
      }
      const { owner, name } = splitRepository(session.repository);
      const github = await this.githubClient(session.databaseUserId);
      const parentCommit = await github.getBranchCommit(owner, name, session.branch);
      const baseTree = await github.getCommitTree(owner, name, parentCommit);
      const existingPaths = await github.getExistingPaths(owner, name, baseTree);
      const destinationPrefix =
        session.destination === "/" ? "" : `${session.destination.replace(/^\/+|\/+$/g, "")}/`;
      const incomingPaths = new Set(
        session.summary.files.map((file) => joinGithubPath(session.destination ?? "/", file.relativePath)),
      );
      const existingInDestination = [...existingPaths].filter(
        (existingPath) => destinationPrefix === "" || existingPath.startsWith(destinationPrefix),
      );
      const created = [...incomingPaths].filter((filePath) => !existingPaths.has(filePath));
      const updated = [...incomingPaths].filter((filePath) => existingPaths.has(filePath));
      const deleted =
        session.syncMode === "replace"
          ? existingInDestination.filter((filePath) => !incomingPaths.has(filePath))
          : [];
      const sample = (label: string, paths: string[]) =>
        paths.length
          ? `\n<b>${label} examples:</b>\n<pre>${paths.slice(0, 5).map(escapeHtml).join("\n")}</pre>`
          : "";

      await this.api.sendMessage(
        session.chatId,
        [
          "<b>GitHub change preview</b>",
          "",
          `<b>Repository:</b> ${escapeHtml(session.repository)}`,
          `<b>Branch:</b> ${escapeHtml(session.branch)}`,
          `<b>Mode:</b> ${session.syncMode === "replace" ? "exact sync" : "merge (add/update only)"}`,
          "",
          `✅ New files: ${created.length}`,
          `♻️ Updated files: ${updated.length}`,
          `🗑 Files to remove: ${deleted.length}`,
          sample("New", created),
          sample("Updated", updated),
          sample("Removed", deleted),
          "",
          deleted.length
            ? "Review the removed-file count carefully. Upload creates one commit only after you tap Upload."
            : "No files will be removed. Upload creates one commit only after you tap Upload.",
        ].join("\n"),
        keyboard([
          [{ text: "Upload now", callback_data: "zip:confirm" }],
          [{ text: "Back to upload details", callback_data: "zip:back" }],
          [{ text: "Cancel", callback_data: "zip:cancel" }],
        ]),
      );
    } catch (error) {
      await this.api.sendMessage(session.chatId, this.userFacingError(error));
    }
  }

  private async cancel(userId: number, chatId: number): Promise<void> {
    if (this.tokenSessions.delete(userId)) {
      await this.api.sendMessage(chatId, "GitHub token setup cancelled.");
      return;
    }
    if (this.adminSessions.delete(userId)) {
      await this.api.sendMessage(chatId, "User management cancelled.");
      return;
    }
    if (this.repoManagementSessions.delete(userId)) {
      await this.api.sendMessage(chatId, "Repository management closed.");
      return;
    }
    const repositoryCreation = this.repositoryCreationSessions.get(userId);
    if (repositoryCreation) {
      this.repositoryCreationSessions.delete(userId);
      this.organizationChoices.delete(userId);
      await this.api.sendMessage(chatId, "Repository creation cancelled.");
      return;
    }
    const session = this.sessions.get(userId);
    if (!session) {
      await this.api.sendMessage(chatId, "There is no active upload to cancel.");
      return;
    }
    if (session.stage === "uploading") {
      session.cancelRequested = true;
      await this.api.sendMessage(chatId, "Cancellation requested. I’ll stop after the current GitHub operation.");
      return;
    }
    if (session.jobId) await updateUploadJob(session.jobId, { status: "cancelled", error: "Cancelled by user", completedAt: new Date() });
    await removeTemporaryDirectory(session.tempDirectory);
    this.sessions.delete(userId);
    await this.api.sendMessage(chatId, "Upload cancelled.");
  }

  private async sendHelp(chatId: number): Promise<void> {
    await this.api.sendMessage(
      chatId,
      [
        "<b>Commands</b>",
        "/start — welcome and quick actions",
        "/upload — receive and prepare a ZIP",
        "/newrepo — create and initialize a GitHub repository",
        "/repos — list repositories the GitHub token can access",
        "/token — securely set or replace your own GitHub token",
        "/cleartoken — remove your saved GitHub token",
        "/repo — manage visibility, archive state, or delete your default repository",
        "/users — admin: authorize or revoke bot users",
        "/settings — show current limits and defaults",
        "/status — show the latest upload status",
        "/cancel — cancel the current upload",
        "/help — show this help",
        "",
         "Before committing, use Preview GitHub changes to see new, updated, and removed files.",
        "ZIP entries are extracted without execution, checked for traversal and symlink attacks, and committed in one Git commit with their exact relative paths.",
      ].join("\n"),
      keyboard([
        [{ text: "Upload ZIP", callback_data: "zip:start" }],
        [{ text: "Create repository", callback_data: "repo:new" }],
      ]),
    );
  }

  private async listRepositories(chatId: number, telegramUserId: number, databaseUserId: string, forUpload = false): Promise<void> {
    const github = await this.githubClient(databaseUserId);
    const repositories = await github.listRepositories();
    if (repositories.length === 0) {
      await this.api.sendMessage(chatId, "No repositories were returned for the configured GitHub token.");
      return;
    }
    const choices = repositories.slice(0, 20);
    this.repositoryChoices.set(telegramUserId, choices);
    const rows = choices.map((repo, index) => [
      {
        text: `${repo.full_name}${repo.private ? " 🔒" : ""}`.slice(0, 60),
        callback_data: `zip:repo:${index}`,
      },
    ]);
    rows.push([{ text: "Create new repository", callback_data: "repo:new" }]);
    rows.push([{ text: "Cancel", callback_data: "zip:cancel" }]);
    await this.api.sendMessage(
      chatId,
      forUpload
        ? "<b>Choose a repository</b>\n\nTap a repository below, or send <code>owner/repository</code> manually."
        : "<b>Accessible repositories</b>\n\nTap a repository to save it as the default for future uploads.",
      keyboard(rows),
    );
  }

  private async showSettings(chatId: number, databaseUserId: string): Promise<void> {
    const defaults = await getDefaultRepository(databaseUserId);
    const tokenConfigured = await hasGithubToken(databaseUserId);
    await this.api.sendMessage(
      chatId,
      [
        "<b>Settings</b>",
        "",
        `<b>Default repository:</b> ${escapeHtml(defaults?.repository ?? "not set")}`,
         `<b>Default branch:</b> ${escapeHtml(defaults?.branch ?? "main")}`,
         `<b>GitHub token:</b> ${tokenConfigured ? "configured" : "not configured"}`,
        `<b>ZIP size limit:</b> ${formatBytes(this.config.maxZipSizeBytes)}`,
        `<b>Extracted size limit:</b> ${formatBytes(this.config.maxExtractedSizeBytes)}`,
        `<b>File limit:</b> ${this.config.maxFilesPerZip.toLocaleString()}`,
        "",
         "Each user connects their own GitHub account with /token. Tokens are encrypted before being stored and are never shown back.",
      ].join("\n"),
    );
  }

  private async showStatus(chatId: number, databaseUserId: string): Promise<void> {
    const job = await getLatestUploadJob(databaseUserId);
    if (!job) {
      await this.api.sendMessage(chatId, "No upload jobs yet.");
      return;
    }
    const status = job.status.replaceAll("_", " ");
    await this.api.sendMessage(
      chatId,
      [
        "<b>Latest upload</b>",
        "",
        `<b>ZIP:</b> ${escapeHtml(job.zipFilename)}`,
        `<b>Repository:</b> ${escapeHtml(job.repository)}`,
        `<b>Branch:</b> ${escapeHtml(job.branch)}`,
        `<b>Status:</b> ${escapeHtml(status)}`,
        `<b>Files:</b> ${job.totalFiles}`,
         `<b>Created:</b> ${job.createdFiles}  <b>Updated:</b> ${job.updatedFiles}  <b>Removed:</b> ${job.deletedFiles ?? 0}`,
        job.commitSha ? `<b>Commit:</b> <code>${escapeHtml(job.commitSha.slice(0, 12))}</code>` : "",
        job.error ? `<b>Error:</b> ${escapeHtml(job.error)}` : "",
      ].filter(Boolean).join("\n"),
    );
  }
}