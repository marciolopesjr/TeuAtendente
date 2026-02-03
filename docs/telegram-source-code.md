# Código Fonte da Integração Telegram

Este arquivo contém o código fonte completo da implementação do Telegram no OpenClaw, facilitando a extração para outros projetos.

## src/telegram/bot.ts
```typescript
// @ts-nocheck
import { sequentialize } from "@grammyjs/runner";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import type { ApiClientOptions } from "grammy";
import { Bot, webhookCallback } from "grammy";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { isControlCommandMessage } from "../auto-reply/command-detection.js";
import { resolveTextChunkLimit } from "../auto-reply/chunk.js";
import { DEFAULT_GROUP_HISTORY_LIMIT, type HistoryEntry } from "../auto-reply/reply/history.js";
import {
  isNativeCommandsExplicitlyDisabled,
  resolveNativeCommandsEnabled,
  resolveNativeSkillsEnabled,
} from "../config/commands.js";
import type { OpenClawConfig, ReplyToMode } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
} from "../config/group-policy.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import { danger, logVerbose, shouldLogVerbose } from "../globals.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { formatUncaughtError } from "../infra/errors.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { getChildLogger } from "../logging.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import { resolveThreadSessionKeys } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveTelegramAccount } from "./accounts.js";
import {
  buildTelegramGroupPeerId,
  resolveTelegramForumThreadId,
  resolveTelegramStreamMode,
} from "./bot/helpers.js";
import type { TelegramContext, TelegramMessage } from "./bot/types.js";
import { registerTelegramHandlers } from "./bot-handlers.js";
import { createTelegramMessageProcessor } from "./bot-message.js";
import { registerTelegramNativeCommands } from "./bot-native-commands.js";
import {
  buildTelegramUpdateKey,
  createTelegramUpdateDedupe,
  resolveTelegramUpdateId,
  type TelegramUpdateKeyContext,
} from "./bot-updates.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { resolveTelegramFetch } from "./fetch.js";
import { wasSentByBot } from "./sent-message-cache.js";

export type TelegramBotOptions = {
  token: string;
  accountId?: string;
  runtime?: RuntimeEnv;
  requireMention?: boolean;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  mediaMaxMb?: number;
  replyToMode?: ReplyToMode;
  proxyFetch?: typeof fetch;
  config?: OpenClawConfig;
  updateOffset?: {
    lastUpdateId?: number | null;
    onUpdateId?: (updateId: number) => void | Promise<void>;
  };
};

export function getTelegramSequentialKey(ctx: {
  chat?: { id?: number };
  message?: TelegramMessage;
  update?: {
    message?: TelegramMessage;
    edited_message?: TelegramMessage;
    callback_query?: { message?: TelegramMessage };
    message_reaction?: { chat?: { id?: number } };
  };
}): string {
  // Handle reaction updates
  const reaction = ctx.update?.message_reaction;
  if (reaction?.chat?.id) {
    return `telegram:${reaction.chat.id}`;
  }
  const msg =
    ctx.message ??
    ctx.update?.message ??
    ctx.update?.edited_message ??
    ctx.update?.callback_query?.message;
  const chatId = msg?.chat?.id ?? ctx.chat?.id;
  const rawText = msg?.text ?? msg?.caption;
  const botUsername = (ctx as { me?: { username?: string } }).me?.username;
  if (
    rawText &&
    isControlCommandMessage(rawText, undefined, botUsername ? { botUsername } : undefined)
  ) {
    if (typeof chatId === "number") {
      return `telegram:${chatId}:control`;
    }
    return "telegram:control";
  }
  const isGroup = msg?.chat?.type === "group" || msg?.chat?.type === "supergroup";
  const messageThreadId = msg?.message_thread_id;
  const isForum = (msg?.chat as { is_forum?: boolean } | undefined)?.is_forum;
  const threadId = isGroup
    ? resolveTelegramForumThreadId({ isForum, messageThreadId })
    : messageThreadId;
  if (typeof chatId === "number") {
    return threadId != null ? `telegram:${chatId}:topic:${threadId}` : `telegram:${chatId}`;
  }
  return "telegram:unknown";
}

export function createTelegramBot(opts: TelegramBotOptions) {
  const runtime: RuntimeEnv = opts.runtime ?? {
    log: console.log,
    error: console.error,
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };
  const cfg = opts.config ?? loadConfig();
  const account = resolveTelegramAccount({
    cfg,
    accountId: opts.accountId,
  });
  const telegramCfg = account.config;

  const fetchImpl = resolveTelegramFetch(opts.proxyFetch, {
    network: telegramCfg.network,
  });
  const shouldProvideFetch = Boolean(fetchImpl);
  const timeoutSeconds =
    typeof telegramCfg?.timeoutSeconds === "number" && Number.isFinite(telegramCfg.timeoutSeconds)
      ? Math.max(1, Math.floor(telegramCfg.timeoutSeconds))
      : undefined;
  const client: ApiClientOptions | undefined =
    shouldProvideFetch || timeoutSeconds
      ? {
          ...(shouldProvideFetch && fetchImpl
            ? { fetch: fetchImpl as unknown as ApiClientOptions["fetch"] }
            : {}),
          ...(timeoutSeconds ? { timeoutSeconds } : {}),
        }
      : undefined;

  const bot = new Bot(opts.token, client ? { client } : undefined);
  bot.api.config.use(apiThrottler());
  bot.use(sequentialize(getTelegramSequentialKey));
  bot.catch((err) => {
    runtime.error?.(danger(`telegram bot error: ${formatUncaughtError(err)}`));
  });

  // Catch all errors from bot middleware to prevent unhandled rejections
  bot.catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    runtime.error?.(danger(`telegram bot error: ${message}`));
  });

  const recentUpdates = createTelegramUpdateDedupe();
  let lastUpdateId =
    typeof opts.updateOffset?.lastUpdateId === "number" ? opts.updateOffset.lastUpdateId : null;

  const recordUpdateId = (ctx: TelegramUpdateKeyContext) => {
    const updateId = resolveTelegramUpdateId(ctx);
    if (typeof updateId !== "number") {
      return;
    }
    if (lastUpdateId !== null && updateId <= lastUpdateId) {
      return;
    }
    lastUpdateId = updateId;
    void opts.updateOffset?.onUpdateId?.(updateId);
  };

  const shouldSkipUpdate = (ctx: TelegramUpdateKeyContext) => {
    const updateId = resolveTelegramUpdateId(ctx);
    if (typeof updateId === "number" && lastUpdateId !== null) {
      if (updateId <= lastUpdateId) {
        return true;
      }
    }
    const key = buildTelegramUpdateKey(ctx);
    const skipped = recentUpdates.check(key);
    if (skipped && key && shouldLogVerbose()) {
      logVerbose(`telegram dedupe: skipped ${key}`);
    }
    return skipped;
  };

  const rawUpdateLogger = createSubsystemLogger("gateway/channels/telegram/raw-update");
  const MAX_RAW_UPDATE_CHARS = 8000;
  const MAX_RAW_UPDATE_STRING = 500;
  const MAX_RAW_UPDATE_ARRAY = 20;
  const stringifyUpdate = (update: unknown) => {
    const seen = new WeakSet();
    return JSON.stringify(update ?? null, (key, value) => {
      if (typeof value === "string" && value.length > MAX_RAW_UPDATE_STRING) {
        return `${value.slice(0, MAX_RAW_UPDATE_STRING)}...`;
      }
      if (Array.isArray(value) && value.length > MAX_RAW_UPDATE_ARRAY) {
        return [
          ...value.slice(0, MAX_RAW_UPDATE_ARRAY),
          `...(${value.length - MAX_RAW_UPDATE_ARRAY} more)`,
        ];
      }
      if (value && typeof value === "object") {
        const obj = value as object;
        if (seen.has(obj)) {
          return "[Circular]";
        }
        seen.add(obj);
      }
      return value;
    });
  };

  bot.use(async (ctx, next) => {
    if (shouldLogVerbose()) {
      try {
        const raw = stringifyUpdate(ctx.update);
        const preview =
          raw.length > MAX_RAW_UPDATE_CHARS ? `${raw.slice(0, MAX_RAW_UPDATE_CHARS)}...` : raw;
        rawUpdateLogger.debug(`telegram update: ${preview}`);
      } catch (err) {
        rawUpdateLogger.debug(`telegram update log failed: ${String(err)}`);
      }
    }
    await next();
    recordUpdateId(ctx);
  });

  const historyLimit = Math.max(
    0,
    telegramCfg.historyLimit ??
      cfg.messages?.groupChat?.historyLimit ??
      DEFAULT_GROUP_HISTORY_LIMIT,
  );
  const groupHistories = new Map<string, HistoryEntry[]>();
  const textLimit = resolveTextChunkLimit(cfg, "telegram", account.accountId);
  const dmPolicy = telegramCfg.dmPolicy ?? "pairing";
  const allowFrom = opts.allowFrom ?? telegramCfg.allowFrom;
  const groupAllowFrom =
    opts.groupAllowFrom ??
    telegramCfg.groupAllowFrom ??
    (telegramCfg.allowFrom && telegramCfg.allowFrom.length > 0
      ? telegramCfg.allowFrom
      : undefined) ??
    (opts.allowFrom && opts.allowFrom.length > 0 ? opts.allowFrom : undefined);
  const replyToMode = opts.replyToMode ?? telegramCfg.replyToMode ?? "first";
  const nativeEnabled = resolveNativeCommandsEnabled({
    providerId: "telegram",
    providerSetting: telegramCfg.commands?.native,
    globalSetting: cfg.commands?.native,
  });
  const nativeSkillsEnabled = resolveNativeSkillsEnabled({
    providerId: "telegram",
    providerSetting: telegramCfg.commands?.nativeSkills,
    globalSetting: cfg.commands?.nativeSkills,
  });
  const nativeDisabledExplicit = isNativeCommandsExplicitlyDisabled({
    providerSetting: telegramCfg.commands?.native,
    globalSetting: cfg.commands?.native,
  });
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const ackReactionScope = cfg.messages?.ackReactionScope ?? "group-mentions";
  const mediaMaxBytes = (opts.mediaMaxMb ?? telegramCfg.mediaMaxMb ?? 5) * 1024 * 1024;
  const logger = getChildLogger({ module: "telegram-auto-reply" });
  const streamMode = resolveTelegramStreamMode(telegramCfg);
  let botHasTopicsEnabled: boolean | undefined;
  const resolveBotTopicsEnabled = async (ctx?: TelegramContext) => {
    const fromCtx = ctx?.me as { has_topics_enabled?: boolean } | undefined;
    if (typeof fromCtx?.has_topics_enabled === "boolean") {
      botHasTopicsEnabled = fromCtx.has_topics_enabled;
      return botHasTopicsEnabled;
    }
    if (typeof botHasTopicsEnabled === "boolean") {
      return botHasTopicsEnabled;
    }
    if (typeof bot.api.getMe !== "function") {
      botHasTopicsEnabled = false;
      return botHasTopicsEnabled;
    }
    try {
      const me = (await withTelegramApiErrorLogging({
        operation: "getMe",
        runtime,
        fn: () => bot.api.getMe(),
      })) as { has_topics_enabled?: boolean };
      botHasTopicsEnabled = Boolean(me?.has_topics_enabled);
    } catch (err) {
      logVerbose(`telegram getMe failed: ${String(err)}`);
      botHasTopicsEnabled = false;
    }
    return botHasTopicsEnabled;
  };
  const resolveGroupPolicy = (chatId: string | number) =>
    resolveChannelGroupPolicy({
      cfg,
      channel: "telegram",
      accountId: account.accountId,
      groupId: String(chatId),
    });
  const resolveGroupActivation = (params: {
    chatId: string | number;
    agentId?: string;
    messageThreadId?: number;
    sessionKey?: string;
  }) => {
    const agentId = params.agentId ?? resolveDefaultAgentId(cfg);
    const sessionKey =
      params.sessionKey ??
      `agent:${agentId}:telegram:group:${buildTelegramGroupPeerId(params.chatId, params.messageThreadId)}`;
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    try {
      const store = loadSessionStore(storePath);
      const entry = store[sessionKey];
      if (entry?.groupActivation === "always") {
        return false;
      }
      if (entry?.groupActivation === "mention") {
        return true;
      }
    } catch (err) {
      logVerbose(`Failed to load session for activation check: ${String(err)}`);
    }
    return undefined;
  };
  const resolveGroupRequireMention = (chatId: string | number) =>
    resolveChannelGroupRequireMention({
      cfg,
      channel: "telegram",
      accountId: account.accountId,
      groupId: String(chatId),
      requireMentionOverride: opts.requireMention,
      overrideOrder: "after-config",
    });
  const resolveTelegramGroupConfig = (chatId: string | number, messageThreadId?: number) => {
    const groups = telegramCfg.groups;
    if (!groups) {
      return { groupConfig: undefined, topicConfig: undefined };
    }
    const groupKey = String(chatId);
    const groupConfig = groups[groupKey] ?? groups["*"];
    const topicConfig =
      messageThreadId != null ? groupConfig?.topics?.[String(messageThreadId)] : undefined;
    return { groupConfig, topicConfig };
  };

  const processMessage = createTelegramMessageProcessor({
    bot,
    cfg,
    account,
    telegramCfg,
    historyLimit,
    groupHistories,
    dmPolicy,
    allowFrom,
    groupAllowFrom,
    ackReactionScope,
    logger,
    resolveGroupActivation,
    resolveGroupRequireMention,
    resolveTelegramGroupConfig,
    runtime,
    replyToMode,
    streamMode,
    textLimit,
    opts,
    resolveBotTopicsEnabled,
  });

  registerTelegramNativeCommands({
    bot,
    cfg,
    runtime,
    accountId: account.accountId,
    telegramCfg,
    allowFrom,
    groupAllowFrom,
    replyToMode,
    textLimit,
    useAccessGroups,
    nativeEnabled,
    nativeSkillsEnabled,
    nativeDisabledExplicit,
    resolveGroupPolicy,
    resolveTelegramGroupConfig,
    shouldSkipUpdate,
    opts,
  });

  // Handle emoji reactions to messages
  bot.on("message_reaction", async (ctx) => {
    try {
      const reaction = ctx.messageReaction;
      if (!reaction) {
        return;
      }
      if (shouldSkipUpdate(ctx)) {
        return;
      }

      const chatId = reaction.chat.id;
      const messageId = reaction.message_id;
      const user = reaction.user;

      // Resolve reaction notification mode (default: "own")
      const reactionMode = telegramCfg.reactionNotifications ?? "own";
      if (reactionMode === "off") {
        return;
      }
      if (user?.is_bot) {
        return;
      }
      if (reactionMode === "own" && !wasSentByBot(chatId, messageId)) {
        return;
      }

      // Detect added reactions
      const oldEmojis = new Set(
        reaction.old_reaction
          .filter((r): r is { type: "emoji"; emoji: string } => r.type === "emoji")
          .map((r) => r.emoji),
      );
      const addedReactions = reaction.new_reaction
        .filter((r): r is { type: "emoji"; emoji: string } => r.type === "emoji")
        .filter((r) => !oldEmojis.has(r.emoji));

      if (addedReactions.length === 0) {
        return;
      }

      // Build sender label
      const senderName = user
        ? [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || user.username
        : undefined;
      const senderUsername = user?.username ? `@${user.username}` : undefined;
      let senderLabel = senderName;
      if (senderName && senderUsername) {
        senderLabel = `${senderName} (${senderUsername})`;
      } else if (!senderName && senderUsername) {
        senderLabel = senderUsername;
      }
      if (!senderLabel && user?.id) {
        senderLabel = `id:${user.id}`;
      }
      senderLabel = senderLabel || "unknown";

      // Extract forum thread info (similar to message processing)
      const messageThreadId = (reaction as any).message_thread_id;
      const isForum = (reaction.chat as any).is_forum === true;
      const resolvedThreadId = resolveTelegramForumThreadId({
        isForum,
        messageThreadId,
      });

      // Resolve agent route for session
      const isGroup = reaction.chat.type === "group" || reaction.chat.type === "supergroup";
      const peerId = isGroup ? buildTelegramGroupPeerId(chatId, resolvedThreadId) : String(chatId);
      const route = resolveAgentRoute({
        cfg,
        channel: "telegram",
        accountId: account.accountId,
        peer: { kind: isGroup ? "group" : "dm", id: peerId },
      });
      const baseSessionKey = route.sessionKey;
      // DMs: use raw messageThreadId for thread sessions (not resolvedThreadId which is for forums)
      const dmThreadId = !isGroup ? messageThreadId : undefined;
      const threadKeys =
        dmThreadId != null
          ? resolveThreadSessionKeys({ baseSessionKey, threadId: String(dmThreadId) })
          : null;
      const sessionKey = threadKeys?.sessionKey ?? baseSessionKey;

      // Enqueue system event for each added reaction
      for (const r of addedReactions) {
        const emoji = r.emoji;
        const text = `Telegram reaction added: ${emoji} by ${senderLabel} on msg ${messageId}`;
        enqueueSystemEvent(text, {
          sessionKey: sessionKey,
          contextKey: `telegram:reaction:add:${chatId}:${messageId}:${user?.id ?? "anon"}:${emoji}`,
        });
        logVerbose(`telegram: reaction event enqueued: ${text}`);
      }
    } catch (err) {
      runtime.error?.(danger(`telegram reaction handler failed: ${String(err)}`));
    }
  });

  registerTelegramHandlers({
    cfg,
    accountId: account.accountId,
    bot,
    opts,
    runtime,
    mediaMaxBytes,
    telegramCfg,
    groupAllowFrom,
    resolveGroupPolicy,
    resolveTelegramGroupConfig,
    shouldSkipUpdate,
    processMessage,
    logger,
  });

  return bot;
}

export function createTelegramWebhookCallback(bot: Bot, path = "/telegram-webhook") {
  return { path, handler: webhookCallback(bot, "http") };
}
```

## src/telegram/bot-handlers.ts
```typescript
// @ts-nocheck
import { hasControlCommand } from "../auto-reply/command-detection.js";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "../auto-reply/inbound-debounce.js";
import { buildCommandsPaginationKeyboard } from "../auto-reply/reply/commands-info.js";
import { buildCommandsMessagePaginated } from "../auto-reply/status.js";
import { listSkillCommandsForAgents } from "../auto-reply/skill-commands.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import { writeConfigFile } from "../config/io.js";
import { danger, logVerbose, warn } from "../globals.js";
import { resolveMedia } from "./bot/delivery.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { resolveTelegramForumThreadId } from "./bot/helpers.js";
import type { TelegramMessage } from "./bot/types.js";
import { firstDefined, isSenderAllowed, normalizeAllowFromWithStore } from "./bot-access.js";
import { MEDIA_GROUP_TIMEOUT_MS, type MediaGroupEntry } from "./bot-updates.js";
import { migrateTelegramGroupConfig } from "./group-migration.js";
import { resolveTelegramInlineButtonsScope } from "./inline-buttons.js";
import { readTelegramAllowFromStore } from "./pairing-store.js";
import { resolveChannelConfigWrites } from "../channels/plugins/config-writes.js";
import { buildInlineKeyboard } from "./send.js";

export const registerTelegramHandlers = ({
  cfg,
  accountId,
  bot,
  opts,
  runtime,
  mediaMaxBytes,
  telegramCfg,
  groupAllowFrom,
  resolveGroupPolicy,
  resolveTelegramGroupConfig,
  shouldSkipUpdate,
  processMessage,
  logger,
}) => {
  const TELEGRAM_TEXT_FRAGMENT_START_THRESHOLD_CHARS = 4000;
  const TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS = 1500;
  const TELEGRAM_TEXT_FRAGMENT_MAX_ID_GAP = 1;
  const TELEGRAM_TEXT_FRAGMENT_MAX_PARTS = 12;
  const TELEGRAM_TEXT_FRAGMENT_MAX_TOTAL_CHARS = 50_000;

  const mediaGroupBuffer = new Map<string, MediaGroupEntry>();
  let mediaGroupProcessing: Promise<void> = Promise.resolve();

  type TextFragmentEntry = {
    key: string;
    messages: Array<{ msg: TelegramMessage; ctx: unknown; receivedAtMs: number }>;
    timer: ReturnType<typeof setTimeout>;
  };
  const textFragmentBuffer = new Map<string, TextFragmentEntry>();
  let textFragmentProcessing: Promise<void> = Promise.resolve();

  const debounceMs = resolveInboundDebounceMs({ cfg, channel: "telegram" });
  type TelegramDebounceEntry = {
    ctx: unknown;
    msg: TelegramMessage;
    allMedia: Array<{ path: string; contentType?: string }>;
    storeAllowFrom: string[];
    debounceKey: string | null;
    botUsername?: string;
  };
  const inboundDebouncer = createInboundDebouncer<TelegramDebounceEntry>({
    debounceMs,
    buildKey: (entry) => entry.debounceKey,
    shouldDebounce: (entry) => {
      if (entry.allMedia.length > 0) {
        return false;
      }
      const text = entry.msg.text ?? entry.msg.caption ?? "";
      if (!text.trim()) {
        return false;
      }
      return !hasControlCommand(text, cfg, { botUsername: entry.botUsername });
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      if (entries.length === 1) {
        await processMessage(last.ctx, last.allMedia, last.storeAllowFrom);
        return;
      }
      const combinedText = entries
        .map((entry) => entry.msg.text ?? entry.msg.caption ?? "")
        .filter(Boolean)
        .join("\n");
      if (!combinedText.trim()) {
        return;
      }
      const first = entries[0];
      const baseCtx = first.ctx as { me?: unknown; getFile?: unknown } & Record<string, unknown>;
      const getFile =
        typeof baseCtx.getFile === "function" ? baseCtx.getFile.bind(baseCtx) : async () => ({});
      const syntheticMessage: TelegramMessage = {
        ...first.msg,
        text: combinedText,
        caption: undefined,
        caption_entities: undefined,
        entities: undefined,
        date: last.msg.date ?? first.msg.date,
      };
      const messageIdOverride = last.msg.message_id ? String(last.msg.message_id) : undefined;
      await processMessage(
        { message: syntheticMessage, me: baseCtx.me, getFile },
        [],
        first.storeAllowFrom,
        messageIdOverride ? { messageIdOverride } : undefined,
      );
    },
    onError: (err) => {
      runtime.error?.(danger(`telegram debounce flush failed: ${String(err)}`));
    },
  });

  const processMediaGroup = async (entry: MediaGroupEntry) => {
    try {
      entry.messages.sort((a, b) => a.msg.message_id - b.msg.message_id);

      const captionMsg = entry.messages.find((m) => m.msg.caption || m.msg.text);
      const primaryEntry = captionMsg ?? entry.messages[0];

      const allMedia: Array<{
        path: string;
        contentType?: string;
        stickerMetadata?: { emoji?: string; setName?: string; fileId?: string };
      }> = [];
      for (const { ctx } of entry.messages) {
        const media = await resolveMedia(ctx, mediaMaxBytes, opts.token, opts.proxyFetch);
        if (media) {
          allMedia.push({
            path: media.path,
            contentType: media.contentType,
            stickerMetadata: media.stickerMetadata,
          });
        }
      }

      const storeAllowFrom = await readTelegramAllowFromStore().catch(() => []);
      await processMessage(primaryEntry.ctx, allMedia, storeAllowFrom);
    } catch (err) {
      runtime.error?.(danger(`media group handler failed: ${String(err)}`));
    }
  };

  const flushTextFragments = async (entry: TextFragmentEntry) => {
    try {
      entry.messages.sort((a, b) => a.msg.message_id - b.msg.message_id);

      const first = entry.messages[0];
      const last = entry.messages.at(-1);
      if (!first || !last) {
        return;
      }

      const combinedText = entry.messages.map((m) => m.msg.text ?? "").join("");
      if (!combinedText.trim()) {
        return;
      }

      const syntheticMessage: TelegramMessage = {
        ...first.msg,
        text: combinedText,
        caption: undefined,
        caption_entities: undefined,
        entities: undefined,
        date: last.msg.date ?? first.msg.date,
      };

      const storeAllowFrom = await readTelegramAllowFromStore().catch(() => []);
      const baseCtx = first.ctx as { me?: unknown; getFile?: unknown } & Record<string, unknown>;
      const getFile =
        typeof baseCtx.getFile === "function" ? baseCtx.getFile.bind(baseCtx) : async () => ({});

      await processMessage(
        { message: syntheticMessage, me: baseCtx.me, getFile },
        [],
        storeAllowFrom,
        { messageIdOverride: String(last.msg.message_id) },
      );
    } catch (err) {
      runtime.error?.(danger(`text fragment handler failed: ${String(err)}`));
    }
  };

  const scheduleTextFragmentFlush = (entry: TextFragmentEntry) => {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(async () => {
      textFragmentBuffer.delete(entry.key);
      textFragmentProcessing = textFragmentProcessing
        .then(async () => {
          await flushTextFragments(entry);
        })
        .catch(() => undefined);
      await textFragmentProcessing;
    }, TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS);
  };

  bot.on("callback_query", async (ctx) => {
    const callback = ctx.callbackQuery;
    if (!callback) {
      return;
    }
    if (shouldSkipUpdate(ctx)) {
      return;
    }
    // Answer immediately to prevent Telegram from retrying while we process
    await withTelegramApiErrorLogging({
      operation: "answerCallbackQuery",
      runtime,
      fn: () => bot.api.answerCallbackQuery(callback.id),
    }).catch(() => {});
    try {
      const data = (callback.data ?? "").trim();
      const callbackMessage = callback.message;
      if (!data || !callbackMessage) {
        return;
      }

      const inlineButtonsScope = resolveTelegramInlineButtonsScope({
        cfg,
        accountId,
      });
      if (inlineButtonsScope === "off") {
        return;
      }

      const chatId = callbackMessage.chat.id;
      const isGroup =
        callbackMessage.chat.type === "group" || callbackMessage.chat.type === "supergroup";
      if (inlineButtonsScope === "dm" && isGroup) {
        return;
      }
      if (inlineButtonsScope === "group" && !isGroup) {
        return;
      }

      const messageThreadId = (callbackMessage as { message_thread_id?: number }).message_thread_id;
      const isForum = (callbackMessage.chat as { is_forum?: boolean }).is_forum === true;
      const resolvedThreadId = resolveTelegramForumThreadId({
        isForum,
        messageThreadId,
      });
      const { groupConfig, topicConfig } = resolveTelegramGroupConfig(chatId, resolvedThreadId);
      const storeAllowFrom = await readTelegramAllowFromStore().catch(() => []);
      const groupAllowOverride = firstDefined(topicConfig?.allowFrom, groupConfig?.allowFrom);
      const effectiveGroupAllow = normalizeAllowFromWithStore({
        allowFrom: groupAllowOverride ?? groupAllowFrom,
        storeAllowFrom,
      });
      const effectiveDmAllow = normalizeAllowFromWithStore({
        allowFrom: telegramCfg.allowFrom,
        storeAllowFrom,
      });
      const dmPolicy = telegramCfg.dmPolicy ?? "pairing";
      const senderId = callback.from?.id ? String(callback.from.id) : "";
      const senderUsername = callback.from?.username ?? "";

      if (isGroup) {
        if (groupConfig?.enabled === false) {
          logVerbose(`Blocked telegram group ${chatId} (group disabled)`);
          return;
        }
        if (topicConfig?.enabled === false) {
          logVerbose(
            `Blocked telegram topic ${chatId} (${resolvedThreadId ?? "unknown"}) (topic disabled)`,
          );
          return;
        }
        if (typeof groupAllowOverride !== "undefined") {
          const allowed =
            senderId &&
            isSenderAllowed({
              allow: effectiveGroupAllow,
              senderId,
              senderUsername,
            });
          if (!allowed) {
            logVerbose(
              `Blocked telegram group sender ${senderId || "unknown"} (group allowFrom override)`,
            );
            return;
          }
        }
        const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
        const groupPolicy = telegramCfg.groupPolicy ?? defaultGroupPolicy ?? "open";
        if (groupPolicy === "disabled") {
          logVerbose(`Blocked telegram group message (groupPolicy: disabled)`);
          return;
        }
        if (groupPolicy === "allowlist") {
          if (!senderId) {
            logVerbose(`Blocked telegram group message (no sender ID, groupPolicy: allowlist)`);
            return;
          }
          if (!effectiveGroupAllow.hasEntries) {
            logVerbose(
              "Blocked telegram group message (groupPolicy: allowlist, no group allowlist entries)",
            );
            return;
          }
          if (
            !isSenderAllowed({
              allow: effectiveGroupAllow,
              senderId,
              senderUsername,
            })
          ) {
            logVerbose(`Blocked telegram group message from ${senderId} (groupPolicy: allowlist)`);
            return;
          }
        }
        const groupAllowlist = resolveGroupPolicy(chatId);
        if (groupAllowlist.allowlistEnabled && !groupAllowlist.allowed) {
          logger.info(
            { chatId, title: callbackMessage.chat.title, reason: "not-allowed" },
            "skipping group message",
          );
          return;
        }
      }

      if (inlineButtonsScope === "allowlist") {
        if (!isGroup) {
          if (dmPolicy === "disabled") {
            return;
          }
          if (dmPolicy !== "open") {
            const allowed =
              effectiveDmAllow.hasWildcard ||
              (effectiveDmAllow.hasEntries &&
                isSenderAllowed({
                  allow: effectiveDmAllow,
                  senderId,
                  senderUsername,
                }));
            if (!allowed) {
              return;
            }
          }
        } else {
          const allowed =
            effectiveGroupAllow.hasWildcard ||
            (effectiveGroupAllow.hasEntries &&
              isSenderAllowed({
                allow: effectiveGroupAllow,
                senderId,
                senderUsername,
              }));
          if (!allowed) {
            return;
          }
        }
      }

      const paginationMatch = data.match(/^commands_page_(\d+|noop)(?::(.+))?$/);
      if (paginationMatch) {
        const pageValue = paginationMatch[1];
        if (pageValue === "noop") {
          return;
        }

        const page = Number.parseInt(pageValue, 10);
        if (Number.isNaN(page) || page < 1) {
          return;
        }

        const agentId = paginationMatch[2]?.trim() || resolveDefaultAgentId(cfg) || undefined;
        const skillCommands = listSkillCommandsForAgents({
          cfg,
          agentIds: agentId ? [agentId] : undefined,
        });
        const result = buildCommandsMessagePaginated(cfg, skillCommands, {
          page,
          surface: "telegram",
        });

        const keyboard =
          result.totalPages > 1
            ? buildInlineKeyboard(
                buildCommandsPaginationKeyboard(result.currentPage, result.totalPages, agentId),
              )
            : undefined;

        try {
          await bot.api.editMessageText(
            callbackMessage.chat.id,
            callbackMessage.message_id,
            result.text,
            keyboard ? { reply_markup: keyboard } : undefined,
          );
        } catch (editErr) {
          const errStr = String(editErr);
          if (!errStr.includes("message is not modified")) {
            throw editErr;
          }
        }
        return;
      }

      const syntheticMessage: TelegramMessage = {
        ...callbackMessage,
        from: callback.from,
        text: data,
        caption: undefined,
        caption_entities: undefined,
        entities: undefined,
      };
      const getFile = typeof ctx.getFile === "function" ? ctx.getFile.bind(ctx) : async () => ({});
      await processMessage({ message: syntheticMessage, me: ctx.me, getFile }, [], storeAllowFrom, {
        forceWasMentioned: true,
        messageIdOverride: callback.id,
      });
    } catch (err) {
      runtime.error?.(danger(`callback handler failed: ${String(err)}`));
    }
  });

  // Handle group migration to supergroup (chat ID changes)
  bot.on("message:migrate_to_chat_id", async (ctx) => {
    try {
      const msg = ctx.message;
      if (!msg?.migrate_to_chat_id) {
        return;
      }
      if (shouldSkipUpdate(ctx)) {
        return;
      }

      const oldChatId = String(msg.chat.id);
      const newChatId = String(msg.migrate_to_chat_id);
      const chatTitle = (msg.chat as { title?: string }).title ?? "Unknown";

      runtime.log?.(warn(`[telegram] Group migrated: "${chatTitle}" ${oldChatId} → ${newChatId}`));

      if (!resolveChannelConfigWrites({ cfg, channelId: "telegram", accountId })) {
        runtime.log?.(warn("[telegram] Config writes disabled; skipping group config migration."));
        return;
      }

      // Check if old chat ID has config and migrate it
      const currentConfig = loadConfig();
      const migration = migrateTelegramGroupConfig({
        cfg: currentConfig,
        accountId,
        oldChatId,
        newChatId,
      });

      if (migration.migrated) {
        runtime.log?.(warn(`[telegram] Migrating group config from ${oldChatId} to ${newChatId}`));
        migrateTelegramGroupConfig({ cfg, accountId, oldChatId, newChatId });
        await writeConfigFile(currentConfig);
        runtime.log?.(warn(`[telegram] Group config migrated and saved successfully`));
      } else if (migration.skippedExisting) {
        runtime.log?.(
          warn(
            `[telegram] Group config already exists for ${newChatId}; leaving ${oldChatId} unchanged`,
          ),
        );
      } else {
        runtime.log?.(
          warn(`[telegram] No config found for old group ID ${oldChatId}, migration logged only`),
        );
      }
    } catch (err) {
      runtime.error?.(danger(`[telegram] Group migration handler failed: ${String(err)}`));
    }
  });

  bot.on("message", async (ctx) => {
    try {
      const msg = ctx.message;
      if (!msg) {
        return;
      }
      if (shouldSkipUpdate(ctx)) {
        return;
      }

      const chatId = msg.chat.id;
      const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
      const messageThreadId = (msg as { message_thread_id?: number }).message_thread_id;
      const isForum = (msg.chat as { is_forum?: boolean }).is_forum === true;
      const resolvedThreadId = resolveTelegramForumThreadId({
        isForum,
        messageThreadId,
      });
      const storeAllowFrom = await readTelegramAllowFromStore().catch(() => []);
      const { groupConfig, topicConfig } = resolveTelegramGroupConfig(chatId, resolvedThreadId);
      const groupAllowOverride = firstDefined(topicConfig?.allowFrom, groupConfig?.allowFrom);
      const effectiveGroupAllow = normalizeAllowFromWithStore({
        allowFrom: groupAllowOverride ?? groupAllowFrom,
        storeAllowFrom,
      });
      const hasGroupAllowOverride = typeof groupAllowOverride !== "undefined";

      if (isGroup) {
        if (groupConfig?.enabled === false) {
          logVerbose(`Blocked telegram group ${chatId} (group disabled)`);
          return;
        }
        if (topicConfig?.enabled === false) {
          logVerbose(
            `Blocked telegram topic ${chatId} (${resolvedThreadId ?? "unknown"}) (topic disabled)`,
          );
          return;
        }
        if (hasGroupAllowOverride) {
          const senderId = msg.from?.id;
          const senderUsername = msg.from?.username ?? "";
          const allowed =
            senderId != null &&
            isSenderAllowed({
              allow: effectiveGroupAllow,
              senderId: String(senderId),
              senderUsername,
            });
          if (!allowed) {
            logVerbose(
              `Blocked telegram group sender ${senderId ?? "unknown"} (group allowFrom override)`,
            );
            return;
          }
        }
        // Group policy filtering: controls how group messages are handled
        // - "open": groups bypass allowFrom, only mention-gating applies
        // - "disabled": block all group messages entirely
        // - "allowlist": only allow group messages from senders in groupAllowFrom/allowFrom
        const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
        const groupPolicy = telegramCfg.groupPolicy ?? defaultGroupPolicy ?? "open";
        if (groupPolicy === "disabled") {
          logVerbose(`Blocked telegram group message (groupPolicy: disabled)`);
          return;
        }
        if (groupPolicy === "allowlist") {
          // For allowlist mode, the sender (msg.from.id) must be in allowFrom
          const senderId = msg.from?.id;
          if (senderId == null) {
            logVerbose(`Blocked telegram group message (no sender ID, groupPolicy: allowlist)`);
            return;
          }
          if (!effectiveGroupAllow.hasEntries) {
            logVerbose(
              "Blocked telegram group message (groupPolicy: allowlist, no group allowlist entries)",
            );
            return;
          }
          const senderUsername = msg.from?.username ?? "";
          if (
            !isSenderAllowed({
              allow: effectiveGroupAllow,
              senderId: String(senderId),
              senderUsername,
            })
          ) {
            logVerbose(`Blocked telegram group message from ${senderId} (groupPolicy: allowlist)`);
            return;
          }
        }

        // Group allowlist based on configured group IDs.
        const groupAllowlist = resolveGroupPolicy(chatId);
        if (groupAllowlist.allowlistEnabled && !groupAllowlist.allowed) {
          logger.info(
            { chatId, title: msg.chat.title, reason: "not-allowed" },
            "skipping group message",
          );
          return;
        }
      }

      // Text fragment handling - Telegram splits long pastes into multiple inbound messages (~4096 chars).
      // We buffer “near-limit” messages and append immediately-following parts.
      const text = typeof msg.text === "string" ? msg.text : undefined;
      const isCommandLike = (text ?? "").trim().startsWith("/");
      if (text && !isCommandLike) {
        const nowMs = Date.now();
        const senderId = msg.from?.id != null ? String(msg.from.id) : "unknown";
        const key = `text:${chatId}:${resolvedThreadId ?? "main"}:${senderId}`;
        const existing = textFragmentBuffer.get(key);

        if (existing) {
          const last = existing.messages.at(-1);
          const lastMsgId = last?.msg.message_id;
          const lastReceivedAtMs = last?.receivedAtMs ?? nowMs;
          const idGap = typeof lastMsgId === "number" ? msg.message_id - lastMsgId : Infinity;
          const timeGapMs = nowMs - lastReceivedAtMs;
          const canAppend =
            idGap > 0 &&
            idGap <= TELEGRAM_TEXT_FRAGMENT_MAX_ID_GAP &&
            timeGapMs >= 0 &&
            timeGapMs <= TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS;

          if (canAppend) {
            const currentTotalChars = existing.messages.reduce(
              (sum, m) => sum + (m.msg.text?.length ?? 0),
              0,
            );
            const nextTotalChars = currentTotalChars + text.length;
            if (
              existing.messages.length + 1 <= TELEGRAM_TEXT_FRAGMENT_MAX_PARTS &&
              nextTotalChars <= TELEGRAM_TEXT_FRAGMENT_MAX_TOTAL_CHARS
            ) {
              existing.messages.push({ msg, ctx, receivedAtMs: nowMs });
              scheduleTextFragmentFlush(existing);
              return;
            }
          }

          // Not appendable (or limits exceeded): flush buffered entry first, then continue normally.
          clearTimeout(existing.timer);
          textFragmentBuffer.delete(key);
          textFragmentProcessing = textFragmentProcessing
            .then(async () => {
              await flushTextFragments(existing);
            })
            .catch(() => undefined);
          await textFragmentProcessing;
        }

        const shouldStart = text.length >= TELEGRAM_TEXT_FRAGMENT_START_THRESHOLD_CHARS;
        if (shouldStart) {
          const entry: TextFragmentEntry = {
            key,
            messages: [{ msg, ctx, receivedAtMs: nowMs }],
            timer: setTimeout(() => {}, TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS),
          };
          textFragmentBuffer.set(key, entry);
          scheduleTextFragmentFlush(entry);
          return;
        }
      }

      // Media group handling - buffer multi-image messages
      const mediaGroupId = (msg as { media_group_id?: string }).media_group_id;
      if (mediaGroupId) {
        const existing = mediaGroupBuffer.get(mediaGroupId);
        if (existing) {
          clearTimeout(existing.timer);
          existing.messages.push({ msg, ctx });
          existing.timer = setTimeout(async () => {
            mediaGroupBuffer.delete(mediaGroupId);
            mediaGroupProcessing = mediaGroupProcessing
              .then(async () => {
                await processMediaGroup(existing);
              })
              .catch(() => undefined);
            await mediaGroupProcessing;
          }, MEDIA_GROUP_TIMEOUT_MS);
        } else {
          const entry: MediaGroupEntry = {
            messages: [{ msg, ctx }],
            timer: setTimeout(async () => {
              mediaGroupBuffer.delete(mediaGroupId);
              mediaGroupProcessing = mediaGroupProcessing
                .then(async () => {
                  await processMediaGroup(entry);
                })
                .catch(() => undefined);
              await mediaGroupProcessing;
            }, MEDIA_GROUP_TIMEOUT_MS),
          };
          mediaGroupBuffer.set(mediaGroupId, entry);
        }
        return;
      }

      let media: Awaited<ReturnType<typeof resolveMedia>> = null;
      try {
        media = await resolveMedia(ctx, mediaMaxBytes, opts.token, opts.proxyFetch);
      } catch (mediaErr) {
        const errMsg = String(mediaErr);
        if (errMsg.includes("exceeds") && errMsg.includes("MB limit")) {
          const limitMb = Math.round(mediaMaxBytes / (1024 * 1024));
          await withTelegramApiErrorLogging({
            operation: "sendMessage",
            runtime,
            fn: () =>
              bot.api.sendMessage(chatId, `⚠️ File too large. Maximum size is ${limitMb}MB.`, {
                reply_to_message_id: msg.message_id,
              }),
          }).catch(() => {});
          logger.warn({ chatId, error: errMsg }, "media exceeds size limit");
          return;
        }
        throw mediaErr;
      }

      // Skip sticker-only messages where the sticker was skipped (animated/video)
      // These have no media and no text content to process.
      const hasText = Boolean((msg.text ?? msg.caption ?? "").trim());
      if (msg.sticker && !media && !hasText) {
        logVerbose("telegram: skipping sticker-only message (unsupported sticker type)");
        return;
      }

      const allMedia = media
        ? [
            {
              path: media.path,
              contentType: media.contentType,
              stickerMetadata: media.stickerMetadata,
            },
          ]
        : [];
      const senderId = msg.from?.id ? String(msg.from.id) : "";
      const conversationKey =
        resolvedThreadId != null ? `${chatId}:topic:${resolvedThreadId}` : String(chatId);
      const debounceKey = senderId
        ? `telegram:${accountId ?? "default"}:${conversationKey}:${senderId}`
        : null;
      await inboundDebouncer.enqueue({
        ctx,
        msg,
        allMedia,
        storeAllowFrom,
        debounceKey,
        botUsername: ctx.me?.username,
      });
    } catch (err) {
      runtime.error?.(danger(`handler failed: ${String(err)}`));
    }
  });
};
```
## src/telegram/webhook.ts
```typescript
import { createServer } from "node:http";

import { webhookCallback } from "grammy";
import type { OpenClawConfig } from "../config/config.js";
import { isDiagnosticsEnabled } from "../infra/diagnostic-events.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import {
  logWebhookError,
  logWebhookProcessed,
  logWebhookReceived,
  startDiagnosticHeartbeat,
  stopDiagnosticHeartbeat,
} from "../logging/diagnostic.js";
import { resolveTelegramAllowedUpdates } from "./allowed-updates.js";
import { createTelegramBot } from "./bot.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";

export async function startTelegramWebhook(opts: {
  token: string;
  accountId?: string;
  config?: OpenClawConfig;
  path?: string;
  port?: number;
  host?: string;
  secret?: string;
  runtime?: RuntimeEnv;
  fetch?: typeof fetch;
  abortSignal?: AbortSignal;
  healthPath?: string;
  publicUrl?: string;
}) {
  const path = opts.path ?? "/telegram-webhook";
  const healthPath = opts.healthPath ?? "/healthz";
  const port = opts.port ?? 8787;
  const host = opts.host ?? "0.0.0.0";
  const runtime = opts.runtime ?? defaultRuntime;
  const diagnosticsEnabled = isDiagnosticsEnabled(opts.config);
  const bot = createTelegramBot({
    token: opts.token,
    runtime,
    proxyFetch: opts.fetch,
    config: opts.config,
    accountId: opts.accountId,
  });
  const handler = webhookCallback(bot, "http", {
    secretToken: opts.secret,
  });

  if (diagnosticsEnabled) {
    startDiagnosticHeartbeat();
  }

  const server = createServer((req, res) => {
    if (req.url === healthPath) {
      res.writeHead(200);
      res.end("ok");
      return;
    }
    if (req.url !== path || req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }
    const startTime = Date.now();
    if (diagnosticsEnabled) {
      logWebhookReceived({ channel: "telegram", updateType: "telegram-post" });
    }
    const handled = handler(req, res);
    if (handled && typeof handled.catch === "function") {
      void handled
        .then(() => {
          if (diagnosticsEnabled) {
            logWebhookProcessed({
              channel: "telegram",
              updateType: "telegram-post",
              durationMs: Date.now() - startTime,
            });
          }
        })
        .catch((err) => {
          const errMsg = formatErrorMessage(err);
          if (diagnosticsEnabled) {
            logWebhookError({
              channel: "telegram",
              updateType: "telegram-post",
              error: errMsg,
            });
          }
          runtime.log?.(`webhook handler failed: ${errMsg}`);
          if (!res.headersSent) {
            res.writeHead(500);
          }
          res.end();
        });
    }
  });

  const publicUrl =
    opts.publicUrl ?? `http://${host === "0.0.0.0" ? "localhost" : host}:${port}${path}`;

  await withTelegramApiErrorLogging({
    operation: "setWebhook",
    runtime,
    fn: () =>
      bot.api.setWebhook(publicUrl, {
        secret_token: opts.secret,
        allowed_updates: resolveTelegramAllowedUpdates(),
      }),
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  runtime.log?.(`webhook listening on ${publicUrl}`);

  const shutdown = () => {
    server.close();
    void bot.stop();
    if (diagnosticsEnabled) {
      stopDiagnosticHeartbeat();
    }
  };
  if (opts.abortSignal) {
    opts.abortSignal.addEventListener("abort", shutdown, { once: true });
  }

  return { server, bot, stop: shutdown };
}
```

## src/telegram/send.ts
```typescript
import type {
  InlineKeyboardButton,
  InlineKeyboardMarkup,
  ReactionType,
  ReactionTypeEmoji,
} from "@grammyjs/types";
import { type ApiClientOptions, Bot, HttpError, InputFile } from "grammy";
import { loadConfig } from "../config/config.js";
import { logVerbose } from "../globals.js";
import { recordChannelActivity } from "../infra/channel-activity.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { formatErrorMessage, formatUncaughtError } from "../infra/errors.js";
import { isDiagnosticFlagEnabled } from "../infra/diagnostic-flags.js";
import type { RetryConfig } from "../infra/retry.js";
import { createTelegramRetryRunner } from "../infra/retry-policy.js";
import { redactSensitiveText } from "../logging/redact.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { mediaKindFromMime } from "../media/constants.js";
import { isGifMedia } from "../media/mime.js";
import { loadWebMedia } from "../web/media.js";
import { type ResolvedTelegramAccount, resolveTelegramAccount } from "./accounts.js";
import { resolveTelegramFetch } from "./fetch.js";
import { makeProxyFetch } from "./proxy.js";
import { renderTelegramHtmlText } from "./format.js";
import { resolveMarkdownTableMode } from "../config/markdown-tables.js";
import { isRecoverableTelegramNetworkError } from "./network-errors.js";
import { splitTelegramCaption } from "./caption.js";
import { recordSentMessage } from "./sent-message-cache.js";
import { parseTelegramTarget, stripTelegramInternalPrefixes } from "./targets.js";
import { resolveTelegramVoiceSend } from "./voice.js";
import { buildTelegramThreadParams } from "./bot/helpers.js";

type TelegramSendOpts = {
  token?: string;
  accountId?: string;
  verbose?: boolean;
  mediaUrl?: string;
  maxBytes?: number;
  api?: Bot["api"];
  retry?: RetryConfig;
  textMode?: "markdown" | "html";
  plainText?: string;
  /** Send audio as voice message (voice bubble) instead of audio file. Defaults to false. */
  asVoice?: boolean;
  /** Send message silently (no notification). Defaults to false. */
  silent?: boolean;
  /** Message ID to reply to (for threading) */
  replyToMessageId?: number;
  /** Quote text for Telegram reply_parameters. */
  quoteText?: string;
  /** Forum topic thread ID (for forum supergroups) */
  messageThreadId?: number;
  /** Inline keyboard buttons (reply markup). */
  buttons?: Array<Array<{ text: string; callback_data: string }>>;
};

type TelegramSendResult = {
  messageId: string;
  chatId: string;
};

type TelegramReactionOpts = {
  token?: string;
  accountId?: string;
  api?: Bot["api"];
  remove?: boolean;
  verbose?: boolean;
  retry?: RetryConfig;
};

const PARSE_ERR_RE = /can't parse entities|parse entities|find end of the entity/i;
const diagLogger = createSubsystemLogger("telegram/diagnostic");

function createTelegramHttpLogger(cfg: ReturnType<typeof loadConfig>) {
  const enabled = isDiagnosticFlagEnabled("telegram.http", cfg);
  if (!enabled) {
    return () => {};
  }
  return (label: string, err: unknown) => {
    if (!(err instanceof HttpError)) {
      return;
    }
    const detail = redactSensitiveText(formatUncaughtError(err.error ?? err));
    diagLogger.warn(`telegram http error (${label}): ${detail}`);
  };
}

function resolveTelegramClientOptions(
  account: ResolvedTelegramAccount,
): ApiClientOptions | undefined {
  const proxyUrl = account.config.proxy?.trim();
  const proxyFetch = proxyUrl ? makeProxyFetch(proxyUrl) : undefined;
  const fetchImpl = resolveTelegramFetch(proxyFetch, {
    network: account.config.network,
  });
  const timeoutSeconds =
    typeof account.config.timeoutSeconds === "number" &&
    Number.isFinite(account.config.timeoutSeconds)
      ? Math.max(1, Math.floor(account.config.timeoutSeconds))
      : undefined;
  return fetchImpl || timeoutSeconds
    ? {
        ...(fetchImpl ? { fetch: fetchImpl as unknown as ApiClientOptions["fetch"] } : {}),
        ...(timeoutSeconds ? { timeoutSeconds } : {}),
      }
    : undefined;
}

function resolveToken(explicit: string | undefined, params: { accountId: string; token: string }) {
  if (explicit?.trim()) {
    return explicit.trim();
  }
  if (!params.token) {
    throw new Error(
      `Telegram bot token missing for account "${params.accountId}" (set channels.telegram.accounts.${params.accountId}.botToken/tokenFile or TELEGRAM_BOT_TOKEN for default).`,
    );
  }
  return params.token.trim();
}

function normalizeChatId(to: string): string {
  const trimmed = to.trim();
  if (!trimmed) {
    throw new Error("Recipient is required for Telegram sends");
  }

  // Common internal prefixes that sometimes leak into outbound sends.
  // - ctx.To uses `telegram:<id>`
  // - group sessions often use `telegram:group:<id>`
  let normalized = stripTelegramInternalPrefixes(trimmed);

  // Accept t.me links for public chats/channels.
  // (Invite links like `t.me/+...` are not resolvable via Bot API.)
  const m =
    /^https?:\/\/t\.me\/([A-Za-z0-9_]+)$/i.exec(normalized) ??
    /^t\.me\/([A-Za-z0-9_]+)$/i.exec(normalized);
  if (m?.[1]) {
    normalized = `@${m[1]}`;
  }

  if (!normalized) {
    throw new Error("Recipient is required for Telegram sends");
  }
  if (normalized.startsWith("@")) {
    return normalized;
  }
  if (/^-?\d+$/.test(normalized)) {
    return normalized;
  }

  // If the user passed a username without `@`, assume they meant a public chat/channel.
  if (/^[A-Za-z0-9_]{5,}$/i.test(normalized)) {
    return `@${normalized}`;
  }

  return normalized;
}

function normalizeMessageId(raw: string | number): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.trunc(raw);
  }
  if (typeof raw === "string") {
    const value = raw.trim();
    if (!value) {
      throw new Error("Message id is required for Telegram actions");
    }
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw new Error("Message id is required for Telegram actions");
}

export function buildInlineKeyboard(
  buttons?: TelegramSendOpts["buttons"],
): InlineKeyboardMarkup | undefined {
  if (!buttons?.length) {
    return undefined;
  }
  const rows = buttons
    .map((row) =>
      row
        .filter((button) => button?.text && button?.callback_data)
        .map(
          (button): InlineKeyboardButton => ({
            text: button.text,
            callback_data: button.callback_data,
          }),
        ),
    )
    .filter((row) => row.length > 0);
  if (rows.length === 0) {
    return undefined;
  }
  return { inline_keyboard: rows };
}

export async function sendMessageTelegram(
  to: string,
  text: string,
  opts: TelegramSendOpts = {},
): Promise<TelegramSendResult> {
  const cfg = loadConfig();
  const account = resolveTelegramAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = resolveToken(opts.token, account);
  const target = parseTelegramTarget(to);
  const chatId = normalizeChatId(target.chatId);
  // Use provided api or create a new Bot instance. The nullish coalescing
  // operator ensures api is always defined (Bot.api is always non-null).
  const client = resolveTelegramClientOptions(account);
  const api = opts.api ?? new Bot(token, client ? { client } : undefined).api;
  const mediaUrl = opts.mediaUrl?.trim();
  const replyMarkup = buildInlineKeyboard(opts.buttons);

  // Build optional params for forum topics and reply threading.
  // Only include these if actually provided to keep API calls clean.
  const messageThreadId =
    opts.messageThreadId != null ? opts.messageThreadId : target.messageThreadId;
  const threadIdParams = buildTelegramThreadParams(messageThreadId);
  const threadParams: Record<string, unknown> = threadIdParams ? { ...threadIdParams } : {};
  const quoteText = opts.quoteText?.trim();
  if (opts.replyToMessageId != null) {
    if (quoteText) {
      threadParams.reply_parameters = {
        message_id: Math.trunc(opts.replyToMessageId),
        quote: quoteText,
      };
    } else {
      threadParams.reply_to_message_id = Math.trunc(opts.replyToMessageId);
    }
  }
  const hasThreadParams = Object.keys(threadParams).length > 0;
  const request = createTelegramRetryRunner({
    retry: opts.retry,
    configRetry: account.config.retry,
    verbose: opts.verbose,
    shouldRetry: (err) => isRecoverableTelegramNetworkError(err, { context: "send" }),
  });
  const logHttpError = createTelegramHttpLogger(cfg);
  const requestWithDiag = <T>(fn: () => Promise<T>, label?: string) =>
    withTelegramApiErrorLogging({
      operation: label ?? "request",
      fn: () => request(fn, label),
    }).catch((err) => {
      logHttpError(label ?? "request", err);
      throw err;
    });
  const wrapChatNotFound = (err: unknown) => {
    if (!/400: Bad Request: chat not found/i.test(formatErrorMessage(err))) {
      return err;
    }
    return new Error(
      [
        `Telegram send failed: chat not found (chat_id=${chatId}).`,
        "Likely: bot not started in DM, bot removed from group/channel, group migrated (new -100… id), or wrong bot token.",
        `Input was: ${JSON.stringify(to)}.`,
      ].join(" "),
    );
  };

  const textMode = opts.textMode ?? "markdown";
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "telegram",
    accountId: account.accountId,
  });
  const renderHtmlText = (value: string) => renderTelegramHtmlText(value, { textMode, tableMode });

  // Resolve link preview setting from config (default: enabled).
  const linkPreviewEnabled = account.config.linkPreview ?? true;
  const linkPreviewOptions = linkPreviewEnabled ? undefined : { is_disabled: true };

  const sendTelegramText = async (
    rawText: string,
    params?: Record<string, unknown>,
    fallbackText?: string,
  ) => {
    const htmlText = renderHtmlText(rawText);
    const baseParams = params ? { ...params } : {};
    if (linkPreviewOptions) {
      baseParams.link_preview_options = linkPreviewOptions;
    }
    const hasBaseParams = Object.keys(baseParams).length > 0;
    const sendParams = {
      parse_mode: "HTML" as const,
      ...baseParams,
      ...(opts.silent === true ? { disable_notification: true } : {}),
    };
    const res = await requestWithDiag(
      () => api.sendMessage(chatId, htmlText, sendParams),
      "message",
    ).catch(async (err) => {
      // Telegram rejects malformed HTML (e.g., unsupported tags or entities).
      // When that happens, fall back to plain text so the message still delivers.
      const errText = formatErrorMessage(err);
      if (PARSE_ERR_RE.test(errText)) {
        if (opts.verbose) {
          console.warn(`telegram HTML parse failed, retrying as plain text: ${errText}`);
        }
        const fallback = fallbackText ?? rawText;
        const plainParams = hasBaseParams ? baseParams : undefined;
        return await requestWithDiag(
          () =>
            plainParams
              ? api.sendMessage(chatId, fallback, plainParams)
              : api.sendMessage(chatId, fallback),
          "message-plain",
        ).catch((err2) => {
          throw wrapChatNotFound(err2);
        });
      }
      throw wrapChatNotFound(err);
    });
    return res;
  };

  if (mediaUrl) {
    const media = await loadWebMedia(mediaUrl, opts.maxBytes);
    const kind = mediaKindFromMime(media.contentType ?? undefined);
    const isGif = isGifMedia({
      contentType: media.contentType,
      fileName: media.fileName,
    });
    const fileName = media.fileName ?? (isGif ? "animation.gif" : inferFilename(kind)) ?? "file";
    const file = new InputFile(media.buffer, fileName);
    const { caption, followUpText } = splitTelegramCaption(text);
    const htmlCaption = caption ? renderHtmlText(caption) : undefined;
    // If text exceeds Telegram's caption limit, send media without caption
    // then send text as a separate follow-up message.
    const needsSeparateText = Boolean(followUpText);
    // When splitting, put reply_markup only on the follow-up text (the "main" content),
    // not on the media message.
    const baseMediaParams = {
      ...(hasThreadParams ? threadParams : {}),
      ...(!needsSeparateText && replyMarkup ? { reply_markup: replyMarkup } : {}),
    };
    const mediaParams = {
      caption: htmlCaption,
      ...(htmlCaption ? { parse_mode: "HTML" as const } : {}),
      ...baseMediaParams,
      ...(opts.silent === true ? { disable_notification: true } : {}),
    };
    let result:
      | Awaited<ReturnType<typeof api.sendPhoto>>
      | Awaited<ReturnType<typeof api.sendVideo>>
      | Awaited<ReturnType<typeof api.sendAudio>>
      | Awaited<ReturnType<typeof api.sendVoice>>
      | Awaited<ReturnType<typeof api.sendAnimation>>
      | Awaited<ReturnType<typeof api.sendDocument>>;
    if (isGif) {
      result = await requestWithDiag(
        () => api.sendAnimation(chatId, file, mediaParams),
        "animation",
      ).catch((err) => {
        throw wrapChatNotFound(err);
      });
    } else if (kind === "image") {
      result = await requestWithDiag(() => api.sendPhoto(chatId, file, mediaParams), "photo").catch(
        (err) => {
          throw wrapChatNotFound(err);
        },
      );
    } else if (kind === "video") {
      result = await requestWithDiag(() => api.sendVideo(chatId, file, mediaParams), "video").catch(
        (err) => {
          throw wrapChatNotFound(err);
        },
      );
    } else if (kind === "audio") {
      const { useVoice } = resolveTelegramVoiceSend({
        wantsVoice: opts.asVoice === true, // default false (backward compatible)
        contentType: media.contentType,
        fileName,
        logFallback: logVerbose,
      });
      if (useVoice) {
        result = await requestWithDiag(
          () => api.sendVoice(chatId, file, mediaParams),
          "voice",
        ).catch((err) => {
          throw wrapChatNotFound(err);
        });
      } else {
        result = await requestWithDiag(
          () => api.sendAudio(chatId, file, mediaParams),
          "audio",
        ).catch((err) => {
          throw wrapChatNotFound(err);
        });
      }
    } else {
      result = await requestWithDiag(
        () => api.sendDocument(chatId, file, mediaParams),
        "document",
      ).catch((err) => {
        throw wrapChatNotFound(err);
      });
    }
    const mediaMessageId = String(result?.message_id ?? "unknown");
    const resolvedChatId = String(result?.chat?.id ?? chatId);
    if (result?.message_id) {
      recordSentMessage(chatId, result.message_id);
    }
    recordChannelActivity({
      channel: "telegram",
      accountId: account.accountId,
      direction: "outbound",
    });

    // If text was too long for a caption, send it as a separate follow-up message.
    // Use HTML conversion so markdown renders like captions.
    if (needsSeparateText && followUpText) {
      const textParams =
        hasThreadParams || replyMarkup
          ? {
              ...threadParams,
              ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
            }
          : undefined;
      const textRes = await sendTelegramText(followUpText, textParams);
      // Return the text message ID as the "main" message (it's the actual content).
      return {
        messageId: String(textRes?.message_id ?? mediaMessageId),
        chatId: resolvedChatId,
      };
    }

    return { messageId: mediaMessageId, chatId: resolvedChatId };
  }

  if (!text || !text.trim()) {
    throw new Error("Message must be non-empty for Telegram sends");
  }
  const textParams =
    hasThreadParams || replyMarkup
      ? {
          ...threadParams,
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        }
      : undefined;
  const res = await sendTelegramText(text, textParams, opts.plainText);
  const messageId = String(res?.message_id ?? "unknown");
  if (res?.message_id) {
    recordSentMessage(chatId, res.message_id);
  }
  recordChannelActivity({
    channel: "telegram",
    accountId: account.accountId,
    direction: "outbound",
  });
  return { messageId, chatId: String(res?.chat?.id ?? chatId) };
}

export async function reactMessageTelegram(
  chatIdInput: string | number,
  messageIdInput: string | number,
  emoji: string,
  opts: TelegramReactionOpts = {},
): Promise<{ ok: true }> {
  const cfg = loadConfig();
  const account = resolveTelegramAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = resolveToken(opts.token, account);
  const chatId = normalizeChatId(String(chatIdInput));
  const messageId = normalizeMessageId(messageIdInput);
  const client = resolveTelegramClientOptions(account);
  const api = opts.api ?? new Bot(token, client ? { client } : undefined).api;
  const request = createTelegramRetryRunner({
    retry: opts.retry,
    configRetry: account.config.retry,
    verbose: opts.verbose,
    shouldRetry: (err) => isRecoverableTelegramNetworkError(err, { context: "send" }),
  });
  const logHttpError = createTelegramHttpLogger(cfg);
  const requestWithDiag = <T>(fn: () => Promise<T>, label?: string) =>
    withTelegramApiErrorLogging({
      operation: label ?? "request",
      fn: () => request(fn, label),
    }).catch((err) => {
      logHttpError(label ?? "request", err);
      throw err;
    });
  const remove = opts.remove === true;
  const trimmedEmoji = emoji.trim();
  // Build the reaction array. We cast emoji to the grammY union type since
  // Telegram validates emoji server-side; invalid emojis fail gracefully.
  const reactions: ReactionType[] =
    remove || !trimmedEmoji
      ? []
      : [{ type: "emoji", emoji: trimmedEmoji as ReactionTypeEmoji["emoji"] }];
  if (typeof api.setMessageReaction !== "function") {
    throw new Error("Telegram reactions are unavailable in this bot API.");
  }
  await requestWithDiag(() => api.setMessageReaction(chatId, messageId, reactions), "reaction");
  return { ok: true };
}

type TelegramDeleteOpts = {
  token?: string;
  accountId?: string;
  verbose?: boolean;
  api?: Bot["api"];
  retry?: RetryConfig;
};

export async function deleteMessageTelegram(
  chatIdInput: string | number,
  messageIdInput: string | number,
  opts: TelegramDeleteOpts = {},
): Promise<{ ok: true }> {
  const cfg = loadConfig();
  const account = resolveTelegramAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = resolveToken(opts.token, account);
  const chatId = normalizeChatId(String(chatIdInput));
  const messageId = normalizeMessageId(messageIdInput);
  const client = resolveTelegramClientOptions(account);
  const api = opts.api ?? new Bot(token, client ? { client } : undefined).api;
  const request = createTelegramRetryRunner({
    retry: opts.retry,
    configRetry: account.config.retry,
    verbose: opts.verbose,
    shouldRetry: (err) => isRecoverableTelegramNetworkError(err, { context: "send" }),
  });
  const logHttpError = createTelegramHttpLogger(cfg);
  const requestWithDiag = <T>(fn: () => Promise<T>, label?: string) =>
    withTelegramApiErrorLogging({
      operation: label ?? "request",
      fn: () => request(fn, label),
    }).catch((err) => {
      logHttpError(label ?? "request", err);
      throw err;
    });
  await requestWithDiag(() => api.deleteMessage(chatId, messageId), "deleteMessage");
  logVerbose(`[telegram] Deleted message ${messageId} from chat ${chatId}`);
  return { ok: true };
}

type TelegramEditOpts = {
  token?: string;
  accountId?: string;
  verbose?: boolean;
  api?: Bot["api"];
  retry?: RetryConfig;
  textMode?: "markdown" | "html";
  /** Inline keyboard buttons (reply markup). Pass empty array to remove buttons. */
  buttons?: Array<Array<{ text: string; callback_data: string }>>;
  /** Optional config injection to avoid global loadConfig() (improves testability). */
  cfg?: ReturnType<typeof loadConfig>;
};

export async function editMessageTelegram(
  chatIdInput: string | number,
  messageIdInput: string | number,
  text: string,
  opts: TelegramEditOpts = {},
): Promise<{ ok: true; messageId: string; chatId: string }> {
  const cfg = opts.cfg ?? loadConfig();
  const account = resolveTelegramAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = resolveToken(opts.token, account);
  const chatId = normalizeChatId(String(chatIdInput));
  const messageId = normalizeMessageId(messageIdInput);
  const client = resolveTelegramClientOptions(account);
  const api = opts.api ?? new Bot(token, client ? { client } : undefined).api;
  const request = createTelegramRetryRunner({
    retry: opts.retry,
    configRetry: account.config.retry,
    verbose: opts.verbose,
  });
  const logHttpError = createTelegramHttpLogger(cfg);
  const requestWithDiag = <T>(fn: () => Promise<T>, label?: string) =>
    withTelegramApiErrorLogging({
      operation: label ?? "request",
      fn: () => request(fn, label),
    }).catch((err) => {
      logHttpError(label ?? "request", err);
      throw err;
    });

  const textMode = opts.textMode ?? "markdown";
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "telegram",
    accountId: account.accountId,
  });
  const htmlText = renderTelegramHtmlText(text, { textMode, tableMode });

  // Reply markup semantics:
  // - buttons === undefined → don't send reply_markup (keep existing)
  // - buttons is [] (or filters to empty) → send { inline_keyboard: [] } (remove)
  // - otherwise → send built inline keyboard
  const shouldTouchButtons = opts.buttons !== undefined;
  const builtKeyboard = shouldTouchButtons ? buildInlineKeyboard(opts.buttons) : undefined;
  const replyMarkup = shouldTouchButtons ? (builtKeyboard ?? { inline_keyboard: [] }) : undefined;

  const editParams: Record<string, unknown> = {
    parse_mode: "HTML",
  };
  if (replyMarkup !== undefined) {
    editParams.reply_markup = replyMarkup;
  }

  await requestWithDiag(
    () => api.editMessageText(chatId, messageId, htmlText, editParams),
    "editMessage",
  ).catch(async (err) => {
    // Telegram rejects malformed HTML. Fall back to plain text.
    const errText = formatErrorMessage(err);
    if (PARSE_ERR_RE.test(errText)) {
      if (opts.verbose) {
        console.warn(`telegram HTML parse failed, retrying as plain text: ${errText}`);
      }
      const plainParams: Record<string, unknown> = {};
      if (replyMarkup !== undefined) {
        plainParams.reply_markup = replyMarkup;
      }
      return await requestWithDiag(
        () =>
          Object.keys(plainParams).length > 0
            ? api.editMessageText(chatId, messageId, text, plainParams)
            : api.editMessageText(chatId, messageId, text),
        "editMessage-plain",
      );
    }
    throw err;
  });

  logVerbose(`[telegram] Edited message ${messageId} in chat ${chatId}`);
  return { ok: true, messageId: String(messageId), chatId };
}

function inferFilename(kind: ReturnType<typeof mediaKindFromMime>) {
  switch (kind) {
    case "image":
      return "image.jpg";
    case "video":
      return "video.mp4";
    case "audio":
      return "audio.ogg";
    default:
      return "file.bin";
  }
}

type TelegramStickerOpts = {
  token?: string;
  accountId?: string;
  verbose?: boolean;
  api?: Bot["api"];
  retry?: RetryConfig;
  /** Message ID to reply to (for threading) */
  replyToMessageId?: number;
  /** Forum topic thread ID (for forum supergroups) */
  messageThreadId?: number;
};

/**
 * Send a sticker to a Telegram chat by file_id.
 * @param to - Chat ID or username (e.g., "123456789" or "@username")
 * @param fileId - Telegram file_id of the sticker to send
 * @param opts - Optional configuration
 */
export async function sendStickerTelegram(
  to: string,
  fileId: string,
  opts: TelegramStickerOpts = {},
): Promise<TelegramSendResult> {
  if (!fileId?.trim()) {
    throw new Error("Telegram sticker file_id is required");
  }

  const cfg = loadConfig();
  const account = resolveTelegramAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = resolveToken(opts.token, account);
  const target = parseTelegramTarget(to);
  const chatId = normalizeChatId(target.chatId);
  const client = resolveTelegramClientOptions(account);
  const api = opts.api ?? new Bot(token, client ? { client } : undefined).api;

  const messageThreadId =
    opts.messageThreadId != null ? opts.messageThreadId : target.messageThreadId;
  const threadIdParams = buildTelegramThreadParams(messageThreadId);
  const threadParams: Record<string, number> = threadIdParams ? { ...threadIdParams } : {};
  if (opts.replyToMessageId != null) {
    threadParams.reply_to_message_id = Math.trunc(opts.replyToMessageId);
  }
  const hasThreadParams = Object.keys(threadParams).length > 0;

  const request = createTelegramRetryRunner({
    retry: opts.retry,
    configRetry: account.config.retry,
    verbose: opts.verbose,
  });
  const logHttpError = createTelegramHttpLogger(cfg);
  const requestWithDiag = <T>(fn: () => Promise<T>, label?: string) =>
    request(fn, label).catch((err) => {
      logHttpError(label ?? "request", err);
      throw err;
    });

  const wrapChatNotFound = (err: unknown) => {
    if (!/400: Bad Request: chat not found/i.test(formatErrorMessage(err))) {
      return err;
    }
    return new Error(
      [
        `Telegram send failed: chat not found (chat_id=${chatId}).`,
        "Likely: bot not started in DM, bot removed from group/channel, group migrated (new -100… id), or wrong bot token.",
        `Input was: ${JSON.stringify(to)}.`,
      ].join(" "),
    );
  };

  const stickerParams = hasThreadParams ? threadParams : undefined;

  const result = await requestWithDiag(
    () => api.sendSticker(chatId, fileId.trim(), stickerParams),
    "sticker",
  ).catch((err) => {
    throw wrapChatNotFound(err);
  });

  const messageId = String(result?.message_id ?? "unknown");
  const resolvedChatId = String(result?.chat?.id ?? chatId);
  if (result?.message_id) {
    recordSentMessage(chatId, result.message_id);
  }
  recordChannelActivity({
    channel: "telegram",
    accountId: account.accountId,
    direction: "outbound",
  });

  return { messageId, chatId: resolvedChatId };
}
```

## src/telegram/bot-message.ts
```typescript
// @ts-nocheck
import { buildTelegramMessageContext } from "./bot-message-context.js";
import { dispatchTelegramMessage } from "./bot-message-dispatch.js";

export const createTelegramMessageProcessor = (deps) => {
  const {
    bot,
    cfg,
    account,
    telegramCfg,
    historyLimit,
    groupHistories,
    dmPolicy,
    allowFrom,
    groupAllowFrom,
    ackReactionScope,
    logger,
    resolveGroupActivation,
    resolveGroupRequireMention,
    resolveTelegramGroupConfig,
    runtime,
    replyToMode,
    streamMode,
    textLimit,
    opts,
    resolveBotTopicsEnabled,
  } = deps;

  return async (primaryCtx, allMedia, storeAllowFrom, options) => {
    const context = await buildTelegramMessageContext({
      primaryCtx,
      allMedia,
      storeAllowFrom,
      options,
      bot,
      cfg,
      account,
      historyLimit,
      groupHistories,
      dmPolicy,
      allowFrom,
      groupAllowFrom,
      ackReactionScope,
      logger,
      resolveGroupActivation,
      resolveGroupRequireMention,
      resolveTelegramGroupConfig,
    });
    if (!context) {
      return;
    }
    await dispatchTelegramMessage({
      context,
      bot,
      cfg,
      runtime,
      replyToMode,
      streamMode,
      textLimit,
      telegramCfg,
      opts,
      resolveBotTopicsEnabled,
    });
  };
};
```
## src/telegram/bot-updates.ts
```typescript
import { createDedupeCache } from "../infra/dedupe.js";
import type { TelegramContext, TelegramMessage } from "./bot/types.js";

const MEDIA_GROUP_TIMEOUT_MS = 500;
const RECENT_TELEGRAM_UPDATE_TTL_MS = 5 * 60_000;
const RECENT_TELEGRAM_UPDATE_MAX = 2000;

export type MediaGroupEntry = {
  messages: Array<{
    msg: TelegramMessage;
    ctx: TelegramContext;
  }>;
  timer: ReturnType<typeof setTimeout>;
};

export type TelegramUpdateKeyContext = {
  update?: {
    update_id?: number;
    message?: TelegramMessage;
    edited_message?: TelegramMessage;
  };
  update_id?: number;
  message?: TelegramMessage;
  callbackQuery?: { id?: string; message?: TelegramMessage };
};

export const resolveTelegramUpdateId = (ctx: TelegramUpdateKeyContext) =>
  ctx.update?.update_id ?? ctx.update_id;

export const buildTelegramUpdateKey = (ctx: TelegramUpdateKeyContext) => {
  const updateId = resolveTelegramUpdateId(ctx);
  if (typeof updateId === "number") {
    return `update:${updateId}`;
  }
  const callbackId = ctx.callbackQuery?.id;
  if (callbackId) {
    return `callback:${callbackId}`;
  }
  const msg =
    ctx.message ?? ctx.update?.message ?? ctx.update?.edited_message ?? ctx.callbackQuery?.message;
  const chatId = msg?.chat?.id;
  const messageId = msg?.message_id;
  if (typeof chatId !== "undefined" && typeof messageId === "number") {
    return `message:${chatId}:${messageId}`;
  }
  return undefined;
};

export const createTelegramUpdateDedupe = () =>
  createDedupeCache({
    ttlMs: RECENT_TELEGRAM_UPDATE_TTL_MS,
    maxSize: RECENT_TELEGRAM_UPDATE_MAX,
  });

export { MEDIA_GROUP_TIMEOUT_MS };
```

## src/telegram/bot-access.ts
```typescript
import type { AllowlistMatch } from "../channels/allowlist-match.js";

export type NormalizedAllowFrom = {
  entries: string[];
  entriesLower: string[];
  hasWildcard: boolean;
  hasEntries: boolean;
};

export type AllowFromMatch = AllowlistMatch<"wildcard" | "id" | "username">;

export const normalizeAllowFrom = (list?: Array<string | number>): NormalizedAllowFrom => {
  const entries = (list ?? []).map((value) => String(value).trim()).filter(Boolean);
  const hasWildcard = entries.includes("*");
  const normalized = entries
    .filter((value) => value !== "*")
    .map((value) => value.replace(/^(telegram|tg):/i, ""));
  const normalizedLower = normalized.map((value) => value.toLowerCase());
  return {
    entries: normalized,
    entriesLower: normalizedLower,
    hasWildcard,
    hasEntries: entries.length > 0,
  };
};

export const normalizeAllowFromWithStore = (params: {
  allowFrom?: Array<string | number>;
  storeAllowFrom?: string[];
}): NormalizedAllowFrom => {
  const combined = [...(params.allowFrom ?? []), ...(params.storeAllowFrom ?? [])]
    .map((value) => String(value).trim())
    .filter(Boolean);
  return normalizeAllowFrom(combined);
};

export const firstDefined = <T>(...values: Array<T | undefined>) => {
  for (const value of values) {
    if (typeof value !== "undefined") {
      return value;
    }
  }
  return undefined;
};

export const isSenderAllowed = (params: {
  allow: NormalizedAllowFrom;
  senderId?: string;
  senderUsername?: string;
}) => {
  const { allow, senderId, senderUsername } = params;
  if (!allow.hasEntries) {
    return true;
  }
  if (allow.hasWildcard) {
    return true;
  }
  if (senderId && allow.entries.includes(senderId)) {
    return true;
  }
  const username = senderUsername?.toLowerCase();
  if (!username) {
    return false;
  }
  return allow.entriesLower.some((entry) => entry === username || entry === `@${username}`);
};

export const resolveSenderAllowMatch = (params: {
  allow: NormalizedAllowFrom;
  senderId?: string;
  senderUsername?: string;
}): AllowFromMatch => {
  const { allow, senderId, senderUsername } = params;
  if (allow.hasWildcard) {
    return { allowed: true, matchKey: "*", matchSource: "wildcard" };
  }
  if (!allow.hasEntries) {
    return { allowed: false };
  }
  if (senderId && allow.entries.includes(senderId)) {
    return { allowed: true, matchKey: senderId, matchSource: "id" };
  }
  const username = senderUsername?.toLowerCase();
  if (!username) {
    return { allowed: false };
  }
  const entry = allow.entriesLower.find(
    (candidate) => candidate === username || candidate === `@${username}`,
  );
  if (entry) {
    return { allowed: true, matchKey: entry, matchSource: "username" };
  }
  return { allowed: false };
};
```

## src/telegram/api-logging.ts
```typescript
import { danger } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { RuntimeEnv } from "../runtime.js";

export type TelegramApiLogger = (message: string) => void;

type TelegramApiLoggingParams<T> = {
  operation: string;
  fn: () => Promise<T>;
  runtime?: RuntimeEnv;
  logger?: TelegramApiLogger;
  shouldLog?: (err: unknown) => boolean;
};

const fallbackLogger = createSubsystemLogger("telegram/api");

function resolveTelegramApiLogger(runtime?: RuntimeEnv, logger?: TelegramApiLogger) {
  if (logger) {
    return logger;
  }
  if (runtime?.error) {
    return runtime.error;
  }
  return (message: string) => fallbackLogger.error(message);
}

export async function withTelegramApiErrorLogging<T>({
  operation,
  fn,
  runtime,
  logger,
  shouldLog,
}: TelegramApiLoggingParams<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!shouldLog || shouldLog(err)) {
      const errText = formatErrorMessage(err);
      const log = resolveTelegramApiLogger(runtime, logger);
      log(danger(`telegram ${operation} failed: ${errText}`));
    }
    throw err;
  }
}
```
## src/telegram/format.ts
```typescript
import {
  chunkMarkdownIR,
  markdownToIR,
  type MarkdownLinkSpan,
  type MarkdownIR,
} from "../markdown/ir.js";
import { renderMarkdownWithMarkers } from "../markdown/render.js";
import type { MarkdownTableMode } from "../config/types.base.js";

export type TelegramFormattedChunk = {
  html: string;
  text: string;
};

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

function buildTelegramLink(link: MarkdownLinkSpan, _text: string) {
  const href = link.href.trim();
  if (!href) {
    return null;
  }
  if (link.start === link.end) {
    return null;
  }
  const safeHref = escapeHtmlAttr(href);
  return {
    start: link.start,
    end: link.end,
    open: `<a href="${safeHref}">`,
    close: "</a>",
  };
}

function renderTelegramHtml(ir: MarkdownIR): string {
  return renderMarkdownWithMarkers(ir, {
    styleMarkers: {
      bold: { open: "<b>", close: "</b>" },
      italic: { open: "<i>", close: "</i>" },
      strikethrough: { open: "<s>", close: "</s>" },
      code: { open: "<code>", close: "</code>" },
      code_block: { open: "<pre><code>", close: "</code></pre>" },
    },
    escapeText: escapeHtml,
    buildLink: buildTelegramLink,
  });
}

export function markdownToTelegramHtml(
  markdown: string,
  options: { tableMode?: MarkdownTableMode } = {},
): string {
  const ir = markdownToIR(markdown ?? "", {
    linkify: true,
    headingStyle: "none",
    blockquotePrefix: "",
    tableMode: options.tableMode,
  });
  return renderTelegramHtml(ir);
}

export function renderTelegramHtmlText(
  text: string,
  options: { textMode?: "markdown" | "html"; tableMode?: MarkdownTableMode } = {},
): string {
  const textMode = options.textMode ?? "markdown";
  if (textMode === "html") {
    return text;
  }
  return markdownToTelegramHtml(text, { tableMode: options.tableMode });
}

export function markdownToTelegramChunks(
  markdown: string,
  limit: number,
  options: { tableMode?: MarkdownTableMode } = {},
): TelegramFormattedChunk[] {
  const ir = markdownToIR(markdown ?? "", {
    linkify: true,
    headingStyle: "none",
    blockquotePrefix: "",
    tableMode: options.tableMode,
  });
  const chunks = chunkMarkdownIR(ir, limit);
  return chunks.map((chunk) => ({
    html: renderTelegramHtml(chunk),
    text: chunk.text,
  }));
}

export function markdownToTelegramHtmlChunks(markdown: string, limit: number): string[] {
  return markdownToTelegramChunks(markdown, limit).map((chunk) => chunk.html);
}
```

## src/telegram/caption.ts
```typescript
export const TELEGRAM_MAX_CAPTION_LENGTH = 1024;

export function splitTelegramCaption(text?: string): {
  caption?: string;
  followUpText?: string;
} {
  const trimmed = text?.trim() ?? "";
  if (!trimmed) {
    return { caption: undefined, followUpText: undefined };
  }
  if (trimmed.length > TELEGRAM_MAX_CAPTION_LENGTH) {
    return { caption: undefined, followUpText: trimmed };
  }
  return { caption: trimmed, followUpText: undefined };
}
```

## src/telegram/fetch.ts
```typescript
import * as net from "node:net";
import { resolveFetch } from "../infra/fetch.js";
import type { TelegramNetworkConfig } from "../config/types.telegram.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveTelegramAutoSelectFamilyDecision } from "./network-config.js";

let appliedAutoSelectFamily: boolean | null = null;
const log = createSubsystemLogger("telegram/network");

// Node 22 workaround: disable autoSelectFamily to avoid Happy Eyeballs timeouts.
// See: https://github.com/nodejs/node/issues/54359
function applyTelegramNetworkWorkarounds(network?: TelegramNetworkConfig): void {
  const decision = resolveTelegramAutoSelectFamilyDecision({ network });
  if (decision.value === null || decision.value === appliedAutoSelectFamily) {
    return;
  }
  appliedAutoSelectFamily = decision.value;

  if (typeof net.setDefaultAutoSelectFamily === "function") {
    try {
      net.setDefaultAutoSelectFamily(decision.value);
      const label = decision.source ? ` (${decision.source})` : "";
      log.info(`telegram: autoSelectFamily=${decision.value}${label}`);
    } catch {
      // ignore if unsupported by the runtime
    }
  }
}

// Prefer wrapped fetch when available to normalize AbortSignal across runtimes.
export function resolveTelegramFetch(
  proxyFetch?: typeof fetch,
  options?: { network?: TelegramNetworkConfig },
): typeof fetch | undefined {
  applyTelegramNetworkWorkarounds(options?.network);
  if (proxyFetch) {
    return resolveFetch(proxyFetch);
  }
  const fetchImpl = resolveFetch();
  if (!fetchImpl) {
    throw new Error("fetch is not available; set channels.telegram.proxy in config");
  }
  return fetchImpl;
}
```

## src/telegram/proxy.ts
```typescript
// @ts-nocheck
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { wrapFetchWithAbortSignal } from "../infra/fetch.js";

export function makeProxyFetch(proxyUrl: string): typeof fetch {
  const agent = new ProxyAgent(proxyUrl);
  return wrapFetchWithAbortSignal((input: RequestInfo | URL, init?: RequestInit) => {
    const base = init ? { ...init } : {};
    return undiciFetch(input, { ...base, dispatcher: agent });
  });
}
```
## src/telegram/network-errors.ts
```typescript
import { extractErrorCode, formatErrorMessage } from "../infra/errors.js";

const RECOVERABLE_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_ABORTED",
  "ECONNABORTED",
  "ERR_NETWORK",
]);

const RECOVERABLE_ERROR_NAMES = new Set([
  "AbortError",
  "TimeoutError",
  "ConnectTimeoutError",
  "HeadersTimeoutError",
  "BodyTimeoutError",
]);

const RECOVERABLE_MESSAGE_SNIPPETS = [
  "fetch failed",
  "typeerror: fetch failed",
  "undici",
  "network error",
  "network request",
  "client network socket disconnected",
  "socket hang up",
  "getaddrinfo",
];

function normalizeCode(code?: string): string {
  return code?.trim().toUpperCase() ?? "";
}

function getErrorName(err: unknown): string {
  if (!err || typeof err !== "object") {
    return "";
  }
  return "name" in err ? String(err.name) : "";
}

function getErrorCode(err: unknown): string | undefined {
  const direct = extractErrorCode(err);
  if (direct) {
    return direct;
  }
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const errno = (err as { errno?: unknown }).errno;
  if (typeof errno === "string") {
    return errno;
  }
  if (typeof errno === "number") {
    return String(errno);
  }
  return undefined;
}

function collectErrorCandidates(err: unknown): unknown[] {
  const queue = [err];
  const seen = new Set<unknown>();
  const candidates: unknown[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current == null || seen.has(current)) {
      continue;
    }
    seen.add(current);
    candidates.push(current);

    if (typeof current === "object") {
      const cause = (current as { cause?: unknown }).cause;
      if (cause && !seen.has(cause)) {
        queue.push(cause);
      }
      const reason = (current as { reason?: unknown }).reason;
      if (reason && !seen.has(reason)) {
        queue.push(reason);
      }
      const errors = (current as { errors?: unknown }).errors;
      if (Array.isArray(errors)) {
        for (const nested of errors) {
          if (nested && !seen.has(nested)) {
            queue.push(nested);
          }
        }
      }
    }
  }

  return candidates;
}

export type TelegramNetworkErrorContext = "polling" | "send" | "webhook" | "unknown";

export function isRecoverableTelegramNetworkError(
  err: unknown,
  options: { context?: TelegramNetworkErrorContext; allowMessageMatch?: boolean } = {},
): boolean {
  if (!err) {
    return false;
  }
  const allowMessageMatch =
    typeof options.allowMessageMatch === "boolean"
      ? options.allowMessageMatch
      : options.context !== "send";

  for (const candidate of collectErrorCandidates(err)) {
    const code = normalizeCode(getErrorCode(candidate));
    if (code && RECOVERABLE_ERROR_CODES.has(code)) {
      return true;
    }

    const name = getErrorName(candidate);
    if (name && RECOVERABLE_ERROR_NAMES.has(name)) {
      return true;
    }

    if (allowMessageMatch) {
      const message = formatErrorMessage(candidate).toLowerCase();
      if (message && RECOVERABLE_MESSAGE_SNIPPETS.some((snippet) => message.includes(snippet))) {
        return true;
      }
    }
  }

  return false;
}
```

## src/telegram/bot/types.ts
```typescript
import type { Message } from "@grammyjs/types";

export type TelegramQuote = {
  text?: string;
};

export type TelegramMessage = Message & {
  quote?: TelegramQuote;
};

export type TelegramStreamMode = "off" | "partial" | "block";

export type TelegramForwardOriginType = "user" | "hidden_user" | "chat" | "channel";

export type TelegramForwardUser = {
  first_name?: string;
  last_name?: string;
  username?: string;
  id?: number;
};

export type TelegramForwardChat = {
  title?: string;
  id?: number;
  username?: string;
  type?: string;
};

export type TelegramForwardOrigin = {
  type: TelegramForwardOriginType;
  sender_user?: TelegramForwardUser;
  sender_user_name?: string;
  sender_chat?: TelegramForwardChat;
  chat?: TelegramForwardChat;
  date?: number;
};

export type TelegramForwardMetadata = {
  forward_origin?: TelegramForwardOrigin;
  forward_from?: TelegramForwardUser;
  forward_from_chat?: TelegramForwardChat;
  forward_sender_name?: string;
  forward_signature?: string;
  forward_date?: number;
};

export type TelegramForwardedMessage = TelegramMessage & TelegramForwardMetadata;

export type TelegramContext = {
  message: TelegramMessage;
  me?: { id?: number; username?: string };
  getFile: () => Promise<{
    file_path?: string;
  }>;
};

/** Telegram Location object */
export interface TelegramLocation {
  latitude: number;
  longitude: number;
  horizontal_accuracy?: number;
  live_period?: number;
  heading?: number;
}

/** Telegram Venue object */
export interface TelegramVenue {
  location: TelegramLocation;
  title: string;
  address: string;
  foursquare_id?: string;
  foursquare_type?: string;
  google_place_id?: string;
  google_place_type?: string;
}

/** Telegram sticker metadata for context enrichment. */
export interface StickerMetadata {
  /** Emoji associated with the sticker. */
  emoji?: string;
  /** Name of the sticker set the sticker belongs to. */
  setName?: string;
  /** Telegram file_id for sending the sticker back. */
  fileId?: string;
  /** Stable file_unique_id for cache deduplication. */
  fileUniqueId?: string;
  /** Cached description from previous vision processing (skip re-processing if present). */
  cachedDescription?: string;
}
```

## src/telegram/bot/helpers.ts
```typescript
import { formatLocationText, type NormalizedLocation } from "../../channels/location.js";
import type {
  TelegramForwardChat,
  TelegramForwardOrigin,
  TelegramForwardUser,
  TelegramForwardedMessage,
  TelegramLocation,
  TelegramMessage,
  TelegramStreamMode,
  TelegramVenue,
} from "./types.js";

const TELEGRAM_GENERAL_TOPIC_ID = 1;

/**
 * Resolve the thread ID for Telegram forum topics.
 * For non-forum groups, returns undefined even if messageThreadId is present
 * (reply threads in regular groups should not create separate sessions).
 * For forum groups, returns the topic ID (or General topic ID=1 if unspecified).
 */
export function resolveTelegramForumThreadId(params: {
  isForum?: boolean;
  messageThreadId?: number | null;
}) {
  // Non-forum groups: ignore message_thread_id (reply threads are not real topics)
  if (!params.isForum) {
    return undefined;
  }
  // Forum groups: use the topic ID, defaulting to General topic
  if (params.messageThreadId == null) {
    return TELEGRAM_GENERAL_TOPIC_ID;
  }
  return params.messageThreadId;
}

/**
 * Build thread params for Telegram API calls (messages, media).
 * General forum topic (id=1) must be treated like a regular supergroup send:
 * Telegram rejects sendMessage/sendMedia with message_thread_id=1 ("thread not found").
 */
export function buildTelegramThreadParams(messageThreadId?: number) {
  if (messageThreadId == null) {
    return undefined;
  }
  const normalized = Math.trunc(messageThreadId);
  if (normalized === TELEGRAM_GENERAL_TOPIC_ID) {
    return undefined;
  }
  return { message_thread_id: normalized };
}

/**
 * Build thread params for typing indicators (sendChatAction).
 * Empirically, General topic (id=1) needs message_thread_id for typing to appear.
 */
export function buildTypingThreadParams(messageThreadId?: number) {
  if (messageThreadId == null) {
    return undefined;
  }
  return { message_thread_id: Math.trunc(messageThreadId) };
}

export function resolveTelegramStreamMode(telegramCfg?: {
  streamMode?: TelegramStreamMode;
}): TelegramStreamMode {
  const raw = telegramCfg?.streamMode?.trim().toLowerCase();
  if (raw === "off" || raw === "partial" || raw === "block") {
    return raw;
  }
  return "partial";
}

export function buildTelegramGroupPeerId(chatId: number | string, messageThreadId?: number) {
  return messageThreadId != null ? `${chatId}:topic:${messageThreadId}` : String(chatId);
}

export function buildTelegramGroupFrom(chatId: number | string, messageThreadId?: number) {
  return `telegram:group:${buildTelegramGroupPeerId(chatId, messageThreadId)}`;
}

export function buildSenderName(msg: TelegramMessage) {
  const name =
    [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ").trim() ||
    msg.from?.username;
  return name || undefined;
}

export function buildSenderLabel(msg: TelegramMessage, senderId?: number | string) {
  const name = buildSenderName(msg);
  const username = msg.from?.username ? `@${msg.from.username}` : undefined;
  let label = name;
  if (name && username) {
    label = `${name} (${username})`;
  } else if (!name && username) {
    label = username;
  }
  const normalizedSenderId =
    senderId != null && `${senderId}`.trim() ? `${senderId}`.trim() : undefined;
  const fallbackId = normalizedSenderId ?? (msg.from?.id != null ? String(msg.from.id) : undefined);
  const idPart = fallbackId ? `id:${fallbackId}` : undefined;
  if (label && idPart) {
    return `${label} ${idPart}`;
  }
  if (label) {
    return label;
  }
  return idPart ?? "id:unknown";
}

export function buildGroupLabel(
  msg: TelegramMessage,
  chatId: number | string,
  messageThreadId?: number,
) {
  const title = msg.chat?.title;
  const topicSuffix = messageThreadId != null ? ` topic:${messageThreadId}` : "";
  if (title) {
    return `${title} id:${chatId}${topicSuffix}`;
  }
  return `group:${chatId}${topicSuffix}`;
}

export function hasBotMention(msg: TelegramMessage, botUsername: string) {
  const text = (msg.text ?? msg.caption ?? "").toLowerCase();
  if (text.includes(`@${botUsername}`)) {
    return true;
  }
  const entities = msg.entities ?? msg.caption_entities ?? [];
  for (const ent of entities) {
    if (ent.type !== "mention") {
      continue;
    }
    const slice = (msg.text ?? msg.caption ?? "").slice(ent.offset, ent.offset + ent.length);
    if (slice.toLowerCase() === `@${botUsername}`) {
      return true;
    }
  }
  return false;
}

type TelegramTextLinkEntity = {
  type: string;
  offset: number;
  length: number;
  url?: string;
};

export function expandTextLinks(text: string, entities?: TelegramTextLinkEntity[] | null): string {
  if (!text || !entities?.length) {
    return text;
  }

  const textLinks = entities
    .filter(
      (entity): entity is TelegramTextLinkEntity & { url: string } =>
        entity.type === "text_link" && Boolean(entity.url),
    )
    .toSorted((a, b) => b.offset - a.offset);

  if (textLinks.length === 0) {
    return text;
  }

  let result = text;
  for (const entity of textLinks) {
    const linkText = text.slice(entity.offset, entity.offset + entity.length);
    const markdown = `[${linkText}](${entity.url})`;
    result =
      result.slice(0, entity.offset) + markdown + result.slice(entity.offset + entity.length);
  }
  return result;
}

export function resolveTelegramReplyId(raw?: string): number | undefined {
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return parsed;
}

export type TelegramReplyTarget = {
  id?: string;
  sender: string;
  body: string;
  kind: "reply" | "quote";
};

export function describeReplyTarget(msg: TelegramMessage): TelegramReplyTarget | null {
  const reply = msg.reply_to_message;
  const quote = msg.quote;
  let body = "";
  let kind: TelegramReplyTarget["kind"] = "reply";

  if (quote?.text) {
    body = quote.text.trim();
    if (body) {
      kind = "quote";
    }
  }

  if (!body && reply) {
    const replyBody = (reply.text ?? reply.caption ?? "").trim();
    body = replyBody;
    if (!body) {
      if (reply.photo) {
        body = "<media:image>";
      } else if (reply.video) {
        body = "<media:video>";
      } else if (reply.audio || reply.voice) {
        body = "<media:audio>";
      } else if (reply.document) {
        body = "<media:document>";
      } else {
        const locationData = extractTelegramLocation(reply);
        if (locationData) {
          body = formatLocationText(locationData);
        }
      }
    }
  }
  if (!body) {
    return null;
  }
  const sender = reply ? buildSenderName(reply) : undefined;
  const senderLabel = sender ? `${sender}` : "unknown sender";

  return {
    id: reply?.message_id ? String(reply.message_id) : undefined,
    sender: senderLabel,
    body,
    kind,
  };
}

export type TelegramForwardedContext = {
  from: string;
  date?: number;
  fromType: string;
  fromId?: string;
  fromUsername?: string;
  fromTitle?: string;
  fromSignature?: string;
};

function normalizeForwardedUserLabel(user: TelegramForwardUser) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  const username = user.username?.trim() || undefined;
  const id = user.id != null ? String(user.id) : undefined;
  const display =
    (name && username
      ? `${name} (@${username})`
      : name || (username ? `@${username}` : undefined)) || (id ? `user:${id}` : undefined);
  return { display, name: name || undefined, username, id };
}

function normalizeForwardedChatLabel(chat: TelegramForwardChat, fallbackKind: "chat" | "channel") {
  const title = chat.title?.trim() || undefined;
  const username = chat.username?.trim() || undefined;
  const id = chat.id != null ? String(chat.id) : undefined;
  const display =
    title || (username ? `@${username}` : undefined) || (id ? `${fallbackKind}:${id}` : undefined);
  return { display, title, username, id };
}

function buildForwardedContextFromUser(params: {
  user: TelegramForwardUser;
  date?: number;
  type: string;
}): TelegramForwardedContext | null {
  const { display, name, username, id } = normalizeForwardedUserLabel(params.user);
  if (!display) {
    return null;
  }
  return {
    from: display,
    date: params.date,
    fromType: params.type,
    fromId: id,
    fromUsername: username,
    fromTitle: name,
  };
}

function buildForwardedContextFromHiddenName(params: {
  name?: string;
  date?: number;
  type: string;
}): TelegramForwardedContext | null {
  const trimmed = params.name?.trim();
  if (!trimmed) {
    return null;
  }
  return {
    from: trimmed,
    date: params.date,
    fromType: params.type,
    fromTitle: trimmed,
  };
}

function buildForwardedContextFromChat(params: {
  chat: TelegramForwardChat;
  date?: number;
  type: string;
  signature?: string;
}): TelegramForwardedContext | null {
  const fallbackKind =
    params.type === "channel" || params.type === "legacy_channel" ? "channel" : "chat";
  const { display, title, username, id } = normalizeForwardedChatLabel(params.chat, fallbackKind);
  if (!display) {
    return null;
  }
  const signature = params.signature?.trim() || undefined;
  const from = signature ? `${display} (${signature})` : display;
  return {
    from,
    date: params.date,
    fromType: params.type,
    fromId: id,
    fromUsername: username,
    fromTitle: title,
    fromSignature: signature,
    fromUsername,
    fromTitle,
  };
}

function resolveForwardOrigin(
  origin: TelegramForwardOrigin,
  signature?: string,
): TelegramForwardedContext | null {
  if (origin.type === "user" && origin.sender_user) {
    return buildForwardedContextFromUser({
      user: origin.sender_user,
      date: origin.date,
      type: "user",
    });
  }
  if (origin.type === "hidden_user") {
    return buildForwardedContextFromHiddenName({
      name: origin.sender_user_name,
      date: origin.date,
      type: "hidden_user",
    });
  }
  if (origin.type === "chat" && origin.sender_chat) {
    return buildForwardedContextFromChat({
      chat: origin.sender_chat,
      date: origin.date,
      type: "chat",
      signature,
    });
  }
  if (origin.type === "channel" && origin.chat) {
    return buildForwardedContextFromChat({
      chat: origin.chat,
      date: origin.date,
      type: "channel",
      signature,
    });
  }
  return null;
}

/**
 * Extract forwarded message origin info from Telegram message.
 * Supports both new forward_origin API and legacy forward_from/forward_from_chat fields.
 */
export function normalizeForwardedContext(msg: TelegramMessage): TelegramForwardedContext | null {
  const forwardMsg = msg as TelegramForwardedMessage;
  const signature = forwardMsg.forward_signature?.trim() || undefined;

  if (forwardMsg.forward_origin) {
    const originContext = resolveForwardOrigin(forwardMsg.forward_origin, signature);
    if (originContext) {
      return originContext;
    }
  }

  if (forwardMsg.forward_from_chat) {
    const legacyType =
      forwardMsg.forward_from_chat.type === "channel" ? "legacy_channel" : "legacy_chat";
    const legacyContext = buildForwardedContextFromChat({
      chat: forwardMsg.forward_from_chat,
      date: forwardMsg.forward_date,
      type: legacyType,
      signature,
    });
    if (legacyContext) {
      return legacyContext;
    }
  }

  if (forwardMsg.forward_from) {
    const legacyContext = buildForwardedContextFromUser({
      user: forwardMsg.forward_from,
      date: forwardMsg.forward_date,
      type: "legacy_user",
    });
    if (legacyContext) {
      return legacyContext;
    }
  }

  const hiddenContext = buildForwardedContextFromHiddenName({
    name: forwardMsg.forward_sender_name,
    date: forwardMsg.forward_date,
    type: "legacy_hidden_user",
  });
  if (hiddenContext) {
    return hiddenContext;
  }

  return null;
}

export function extractTelegramLocation(msg: TelegramMessage): NormalizedLocation | null {
  const msgWithLocation = msg as {
    location?: TelegramLocation;
    venue?: TelegramVenue;
  };
  const { venue, location } = msgWithLocation;

  if (venue) {
    return {
      latitude: venue.location.latitude,
      longitude: venue.location.longitude,
      accuracy: venue.location.horizontal_accuracy,
      name: venue.title,
      address: venue.address,
      source: "place",
      isLive: false,
    };
  }

  if (location) {
    const isLive = typeof location.live_period === "number" && location.live_period > 0;
    return {
      latitude: location.latitude,
      longitude: location.longitude,
      accuracy: location.horizontal_accuracy,
      source: isLive ? "live" : "pin",
      isLive,
    };
  }

  return null;
}
```
## src/telegram/bot/delivery.ts
```typescript
import { type Bot, GrammyError, InputFile } from "grammy";
import {
  markdownToTelegramChunks,
  markdownToTelegramHtml,
  renderTelegramHtmlText,
} from "../format.js";
import { withTelegramApiErrorLogging } from "../api-logging.js";
import { chunkMarkdownTextWithMode, type ChunkMode } from "../../auto-reply/chunk.js";
import { splitTelegramCaption } from "../caption.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { ReplyToMode } from "../../config/config.js";
import type { MarkdownTableMode } from "../../config/types.base.js";
import { danger, logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { mediaKindFromMime } from "../../media/constants.js";
import { fetchRemoteMedia } from "../../media/fetch.js";
import { isGifMedia } from "../../media/mime.js";
import { saveMediaBuffer } from "../../media/store.js";
import type { RuntimeEnv } from "../../runtime.js";
import { loadWebMedia } from "../../web/media.js";
import { buildInlineKeyboard } from "../send.js";
import { resolveTelegramVoiceSend } from "../voice.js";
import { buildTelegramThreadParams, resolveTelegramReplyId } from "./helpers.js";
import type { StickerMetadata, TelegramContext } from "./types.js";
import { cacheSticker, getCachedSticker } from "../sticker-cache.js";

const PARSE_ERR_RE = /can't parse entities|parse entities|find end of the entity/i;
const VOICE_FORBIDDEN_RE = /VOICE_MESSAGES_FORBIDDEN/;

export async function deliverReplies(params: {
  replies: ReplyPayload[];
  chatId: string;
  token: string;
  runtime: RuntimeEnv;
  bot: Bot;
  replyToMode: ReplyToMode;
  textLimit: number;
  messageThreadId?: number;
  tableMode?: MarkdownTableMode;
  chunkMode?: ChunkMode;
  /** Callback invoked before sending a voice message to switch typing indicator. */
  onVoiceRecording?: () => Promise<void> | void;
  /** Controls whether link previews are shown. Default: true (previews enabled). */
  linkPreview?: boolean;
  /** Optional quote text for Telegram reply_parameters. */
  replyQuoteText?: string;
}): Promise<{ delivered: boolean }> {
  const {
    replies,
    chatId,
    runtime,
    bot,
    replyToMode,
    textLimit,
    messageThreadId,
    linkPreview,
    replyQuoteText,
  } = params;
  const chunkMode = params.chunkMode ?? "length";
  let hasReplied = false;
  let hasDelivered = false;
  const markDelivered = () => {
    hasDelivered = true;
  };
  const chunkText = (markdown: string) => {
    const markdownChunks =
      chunkMode === "newline"
        ? chunkMarkdownTextWithMode(markdown, textLimit, chunkMode)
        : [markdown];
    const chunks: ReturnType<typeof markdownToTelegramChunks> = [];
    for (const chunk of markdownChunks) {
      const nested = markdownToTelegramChunks(chunk, textLimit, { tableMode: params.tableMode });
      if (!nested.length && chunk) {
        chunks.push({
          html: markdownToTelegramHtml(chunk, { tableMode: params.tableMode }),
          text: chunk,
        });
        continue;
      }
      chunks.push(...nested);
    }
    return chunks;
  };
  for (const reply of replies) {
    const hasMedia = Boolean(reply?.mediaUrl) || (reply?.mediaUrls?.length ?? 0) > 0;
    if (!reply?.text && !hasMedia) {
      if (reply?.audioAsVoice) {
        logVerbose("telegram reply has audioAsVoice without media/text; skipping");
        continue;
      }
      runtime.error?.(danger("reply missing text/media"));
      continue;
    }
    const replyToId = replyToMode === "off" ? undefined : resolveTelegramReplyId(reply.replyToId);
    const mediaList = reply.mediaUrls?.length
      ? reply.mediaUrls
      : reply.mediaUrl
        ? [reply.mediaUrl]
        : [];
    const telegramData = reply.channelData?.telegram as
      | { buttons?: Array<Array<{ text: string; callback_data: string }>> }
      | undefined;
    const replyMarkup = buildInlineKeyboard(telegramData?.buttons);
    if (mediaList.length === 0) {
      const chunks = chunkText(reply.text || "");
      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        if (!chunk) {
          continue;
        }
        // Only attach buttons to the first chunk.
        const shouldAttachButtons = i === 0 && replyMarkup;
        await sendTelegramText(bot, chatId, chunk.html, runtime, {
          replyToMessageId:
            replyToId && (replyToMode === "all" || !hasReplied) ? replyToId : undefined,
          replyQuoteText,
          messageThreadId,
          textMode: "html",
          plainText: chunk.text,
          linkPreview,
          replyMarkup: shouldAttachButtons ? replyMarkup : undefined,
        });
        markDelivered();
        if (replyToId && !hasReplied) {
          hasReplied = true;
        }
      }
      continue;
    }
    // media with optional caption on first item
    let first = true;
    // Track if we need to send a follow-up text message after media
    // (when caption exceeds Telegram's 1024-char limit)
    let pendingFollowUpText: string | undefined;
    for (const mediaUrl of mediaList) {
      const isFirstMedia = first;
      const media = await loadWebMedia(mediaUrl);
      const kind = mediaKindFromMime(media.contentType ?? undefined);
      const isGif = isGifMedia({
        contentType: media.contentType,
        fileName: media.fileName,
      });
      const fileName = media.fileName ?? (isGif ? "animation.gif" : "file");
      const file = new InputFile(media.buffer, fileName);
      // Caption only on first item; if text exceeds limit, defer to follow-up message.
      const { caption, followUpText } = splitTelegramCaption(
        isFirstMedia ? (reply.text ?? undefined) : undefined,
      );
      const htmlCaption = caption
        ? renderTelegramHtmlText(caption, { tableMode: params.tableMode })
        : undefined;
      if (followUpText) {
        pendingFollowUpText = followUpText;
      }
      first = false;
      const replyToMessageId =
        replyToId && (replyToMode === "all" || !hasReplied) ? replyToId : undefined;
      const shouldAttachButtonsToMedia = isFirstMedia && replyMarkup && !followUpText;
      const mediaParams: Record<string, unknown> = {
        caption: htmlCaption,
        ...(htmlCaption ? { parse_mode: "HTML" } : {}),
        ...(shouldAttachButtonsToMedia ? { reply_markup: replyMarkup } : {}),
        ...buildTelegramSendParams({
          replyToMessageId,
          messageThreadId,
          replyQuoteText,
        }),
      };
      if (isGif) {
        await withTelegramApiErrorLogging({
          operation: "sendAnimation",
          runtime,
          fn: () => bot.api.sendAnimation(chatId, file, { ...mediaParams }),
        });
        markDelivered();
      } else if (kind === "image") {
        await withTelegramApiErrorLogging({
          operation: "sendPhoto",
          runtime,
          fn: () => bot.api.sendPhoto(chatId, file, { ...mediaParams }),
        });
        markDelivered();
      } else if (kind === "video") {
        await withTelegramApiErrorLogging({
          operation: "sendVideo",
          runtime,
          fn: () => bot.api.sendVideo(chatId, file, { ...mediaParams }),
        });
        markDelivered();
      } else if (kind === "audio") {
        const { useVoice } = resolveTelegramVoiceSend({
          wantsVoice: reply.audioAsVoice === true, // default false (backward compatible)
          contentType: media.contentType,
          fileName,
          logFallback: logVerbose,
        });
        if (useVoice) {
          // Voice message - displays as round playable bubble (opt-in via [[audio_as_voice]])
          // Switch typing indicator to record_voice before sending.
          await params.onVoiceRecording?.();
          try {
            await withTelegramApiErrorLogging({
              operation: "sendVoice",
              runtime,
              shouldLog: (err) => !isVoiceMessagesForbidden(err),
              fn: () => bot.api.sendVoice(chatId, file, { ...mediaParams }),
            });
            markDelivered();
          } catch (voiceErr) {
            // Fall back to text if voice messages are forbidden in this chat.
            // This happens when the recipient has Telegram Premium privacy settings
            // that block voice messages (Settings > Privacy > Voice Messages).
            if (isVoiceMessagesForbidden(voiceErr)) {
              const fallbackText = reply.text;
              if (!fallbackText || !fallbackText.trim()) {
                throw voiceErr;
              }
              logVerbose(
                "telegram sendVoice forbidden (recipient has voice messages blocked in privacy settings); falling back to text",
              );
              hasReplied = await sendTelegramVoiceFallbackText({
                bot,
                chatId,
                runtime,
                text: fallbackText,
                chunkText,
                replyToId,
                replyToMode,
                hasReplied,
                messageThreadId,
                linkPreview,
                replyMarkup,
                replyQuoteText,
              });
              markDelivered();
              // Skip this media item; continue with next.
              continue;
            }
            throw voiceErr;
          }
        } else {
          // Audio file - displays with metadata (title, duration) - DEFAULT
          await withTelegramApiErrorLogging({
            operation: "sendAudio",
            runtime,
            fn: () => bot.api.sendAudio(chatId, file, { ...mediaParams }),
          });
          markDelivered();
        }
      } else {
        await withTelegramApiErrorLogging({
          operation: "sendDocument",
          runtime,
          fn: () => bot.api.sendDocument(chatId, file, { ...mediaParams }),
        });
        markDelivered();
      }
      if (replyToId && !hasReplied) {
        hasReplied = true;
      }
      // Send deferred follow-up text right after the first media item.
      // Chunk it in case it's extremely long (same logic as text-only replies).
      if (pendingFollowUpText && isFirstMedia) {
        const chunks = chunkText(pendingFollowUpText);
        for (let i = 0; i < chunks.length; i += 1) {
          const chunk = chunks[i];
          const replyToMessageIdFollowup =
            replyToId && (replyToMode === "all" || !hasReplied) ? replyToId : undefined;
          await sendTelegramText(bot, chatId, chunk.html, runtime, {
            replyToMessageId: replyToMessageIdFollowup,
            messageThreadId,
            textMode: "html",
            plainText: chunk.text,
            linkPreview,
            replyMarkup: i === 0 ? replyMarkup : undefined,
          });
          markDelivered();
          if (replyToId && !hasReplied) {
            hasReplied = true;
          }
        }
        pendingFollowUpText = undefined;
      }
    }
  }

  return { delivered: hasDelivered };
}

export async function resolveMedia(
  ctx: TelegramContext,
  maxBytes: number,
  token: string,
  proxyFetch?: typeof fetch,
): Promise<{
  path: string;
  contentType?: string;
  placeholder: string;
  stickerMetadata?: StickerMetadata;
} | null> {
  const msg = ctx.message;

  // Handle stickers separately - only static stickers (WEBP) are supported
  if (msg.sticker) {
    const sticker = msg.sticker;
    // Skip animated (TGS) and video (WEBM) stickers - only static WEBP supported
    if (sticker.is_animated || sticker.is_video) {
      logVerbose("telegram: skipping animated/video sticker (only static stickers supported)");
      return null;
    }
    if (!sticker.file_id) {
      return null;
    }

    try {
      const file = await ctx.getFile();
      if (!file.file_path) {
        logVerbose("telegram: getFile returned no file_path for sticker");
        return null;
      }
      const fetchImpl = proxyFetch ?? globalThis.fetch;
      if (!fetchImpl) {
        logVerbose("telegram: fetch not available for sticker download");
        return null;
      }
      const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const fetched = await fetchRemoteMedia({
        url,
        fetchImpl,
        filePathHint: file.file_path,
      });
      const originalName = fetched.fileName ?? file.file_path;
      const saved = await saveMediaBuffer(
        fetched.buffer,
        fetched.contentType,
        "inbound",
        maxBytes,
        originalName,
      );

      // Check sticker cache for existing description
      const cached = sticker.file_unique_id ? getCachedSticker(sticker.file_unique_id) : null;
      if (cached) {
        logVerbose(`telegram: sticker cache hit for ${sticker.file_unique_id}`);
        const fileId = sticker.file_id ?? cached.fileId;
        const emoji = sticker.emoji ?? cached.emoji;
        const setName = sticker.set_name ?? cached.setName;
        if (fileId !== cached.fileId || emoji !== cached.emoji || setName !== cached.setName) {
          // Refresh cached sticker metadata on hits so sends/searches use latest file_id.
          cacheSticker({
            ...cached,
            fileId,
            emoji,
            setName,
          });
        }
        return {
          path: saved.path,
          contentType: saved.contentType,
          placeholder: "<media:sticker>",
          stickerMetadata: {
            emoji,
            setName,
            fileId,
            fileUniqueId: sticker.file_unique_id,
            cachedDescription: cached.description,
          },
        };
      }

      // Cache miss - return metadata for vision processing
      return {
        path: saved.path,
        contentType: saved.contentType,
        placeholder: "<media:sticker>",
        stickerMetadata: {
          emoji: sticker.emoji ?? undefined,
          setName: sticker.set_name ?? undefined,
          fileId: sticker.file_id,
          fileUniqueId: sticker.file_unique_id,
        },
      };
    } catch (err) {
      logVerbose(`telegram: failed to process sticker: ${String(err)}`);
      return null;
    }
  }

  const m =
    msg.photo?.[msg.photo.length - 1] ??
    msg.video ??
    msg.video_note ??
    msg.document ??
    msg.audio ??
    msg.voice;
  if (!m?.file_id) {
    return null;
  }
  const file = await ctx.getFile();
  if (!file.file_path) {
    throw new Error("Telegram getFile returned no file_path");
  }
  const fetchImpl = proxyFetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error("fetch is not available; set channels.telegram.proxy in config");
  }
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const fetched = await fetchRemoteMedia({
    url,
    fetchImpl,
    filePathHint: file.file_path,
  });
  const originalName = fetched.fileName ?? file.file_path;
  const saved = await saveMediaBuffer(
    fetched.buffer,
    fetched.contentType,
    "inbound",
    maxBytes,
    originalName,
  );
  let placeholder = "<media:document>";
  if (msg.photo) {
    placeholder = "<media:image>";
  } else if (msg.video) {
    placeholder = "<media:video>";
  } else if (msg.video_note) {
    placeholder = "<media:video>";
  } else if (msg.audio || msg.voice) {
    placeholder = "<media:audio>";
  }
  return { path: saved.path, contentType: saved.contentType, placeholder };
}

function isVoiceMessagesForbidden(err: unknown): boolean {
  if (err instanceof GrammyError) {
    return VOICE_FORBIDDEN_RE.test(err.description);
  }
  return VOICE_FORBIDDEN_RE.test(formatErrorMessage(err));
}

async function sendTelegramVoiceFallbackText(opts: {
  bot: Bot;
  chatId: string;
  runtime: RuntimeEnv;
  text: string;
  chunkText: (markdown: string) => ReturnType<typeof markdownToTelegramChunks>;
  replyToId?: number;
  replyToMode: ReplyToMode;
  hasReplied: boolean;
  messageThreadId?: number;
  linkPreview?: boolean;
  replyMarkup?: ReturnType<typeof buildInlineKeyboard>;
  replyQuoteText?: string;
}): Promise<boolean> {
  const chunks = opts.chunkText(opts.text);
  let hasReplied = opts.hasReplied;
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    await sendTelegramText(opts.bot, opts.chatId, chunk.html, opts.runtime, {
      replyToMessageId:
        opts.replyToId && (opts.replyToMode === "all" || !hasReplied) ? opts.replyToId : undefined,
      replyQuoteText: opts.replyQuoteText,
      messageThreadId: opts.messageThreadId,
      textMode: "html",
      plainText: chunk.text,
      linkPreview: opts.linkPreview,
      replyMarkup: i === 0 ? opts.replyMarkup : undefined,
    });
    if (opts.replyToId && !hasReplied) {
      hasReplied = true;
    }
  }
  return hasReplied;
}

function buildTelegramSendParams(opts?: {
  replyToMessageId?: number;
  messageThreadId?: number;
  replyQuoteText?: string;
}): Record<string, unknown> {
  const threadParams = buildTelegramThreadParams(opts?.messageThreadId);
  const params: Record<string, unknown> = {};
  const quoteText = opts?.replyQuoteText?.trim();
  if (opts?.replyToMessageId) {
    if (quoteText) {
      params.reply_parameters = {
        message_id: Math.trunc(opts.replyToMessageId),
        quote: quoteText,
      };
    } else {
      params.reply_to_message_id = opts.replyToMessageId;
    }
  }
  if (threadParams) {
    params.message_thread_id = threadParams.message_thread_id;
  }
  return params;
}

async function sendTelegramText(
  bot: Bot,
  chatId: string,
  text: string,
  runtime: RuntimeEnv,
  opts?: {
    replyToMessageId?: number;
    replyQuoteText?: string;
    messageThreadId?: number;
    textMode?: "markdown" | "html";
    plainText?: string;
    linkPreview?: boolean;
    replyMarkup?: ReturnType<typeof buildInlineKeyboard>;
  },
): Promise<number | undefined> {
  const baseParams = buildTelegramSendParams({
    replyToMessageId: opts?.replyToMessageId,
    replyQuoteText: opts?.replyQuoteText,
    messageThreadId: opts?.messageThreadId,
  });
  // Add link_preview_options when link preview is disabled.
  const linkPreviewEnabled = opts?.linkPreview ?? true;
  const linkPreviewOptions = linkPreviewEnabled ? undefined : { is_disabled: true };
  const textMode = opts?.textMode ?? "markdown";
  const htmlText = textMode === "html" ? text : markdownToTelegramHtml(text);
  try {
    const res = await withTelegramApiErrorLogging({
      operation: "sendMessage",
      runtime,
      shouldLog: (err) => !PARSE_ERR_RE.test(formatErrorMessage(err)),
      fn: () =>
        bot.api.sendMessage(chatId, htmlText, {
          parse_mode: "HTML",
          ...(linkPreviewOptions ? { link_preview_options: linkPreviewOptions } : {}),
          ...(opts?.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
          ...baseParams,
        }),
    });
    return res.message_id;
  } catch (err) {
    const errText = formatErrorMessage(err);
    if (PARSE_ERR_RE.test(errText)) {
      runtime.log?.(`telegram HTML parse failed; retrying without formatting: ${errText}`);
      const fallbackText = opts?.plainText ?? text;
      const res = await withTelegramApiErrorLogging({
        operation: "sendMessage",
        runtime,
        fn: () =>
          bot.api.sendMessage(chatId, fallbackText, {
            ...(linkPreviewOptions ? { link_preview_options: linkPreviewOptions } : {}),
            ...(opts?.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
            ...baseParams,
          }),
      });
      return res.message_id;
    }
    throw err;
  }
}
```

## src/telegram/sent-message-cache.ts
```typescript
/**
 * In-memory cache of sent message IDs per chat.
 * Used to identify bot's own messages for reaction filtering ("own" mode).
 */

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

type CacheEntry = {
  messageIds: Set<number>;
  timestamps: Map<number, number>;
};

const sentMessages = new Map<string, CacheEntry>();

function getChatKey(chatId: number | string): string {
  return String(chatId);
}

function cleanupExpired(entry: CacheEntry): void {
  const now = Date.now();
  for (const [msgId, timestamp] of entry.timestamps) {
    if (now - timestamp > TTL_MS) {
      entry.messageIds.delete(msgId);
      entry.timestamps.delete(msgId);
    }
  }
}

/**
 * Record a message ID as sent by the bot.
 */
export function recordSentMessage(chatId: number | string, messageId: number): void {
  const key = getChatKey(chatId);
  let entry = sentMessages.get(key);
  if (!entry) {
    entry = { messageIds: new Set(), timestamps: new Map() };
    sentMessages.set(key, entry);
  }
  entry.messageIds.add(messageId);
  entry.timestamps.set(messageId, Date.now());
  // Periodic cleanup
  if (entry.messageIds.size > 100) {
    cleanupExpired(entry);
  }
}

/**
 * Check if a message was sent by the bot.
 */
export function wasSentByBot(chatId: number | string, messageId: number): boolean {
  const key = getChatKey(chatId);
  const entry = sentMessages.get(key);
  if (!entry) {
    return false;
  }
  // Clean up expired entries on read
  cleanupExpired(entry);
  return entry.messageIds.has(messageId);
}

/**
 * Clear all cached entries (for testing).
 */
export function clearSentMessageCache(): void {
  sentMessages.clear();
}
```

## src/telegram/allowed-updates.ts
```typescript
import { API_CONSTANTS } from "grammy";

type TelegramUpdateType = (typeof API_CONSTANTS.ALL_UPDATE_TYPES)[number];

export function resolveTelegramAllowedUpdates(): ReadonlyArray<TelegramUpdateType> {
  const updates = [...API_CONSTANTS.DEFAULT_UPDATE_TYPES] as TelegramUpdateType[];
  if (!updates.includes("message_reaction")) {
    updates.push("message_reaction");
  }
  return updates;
}
```
## src/telegram/bot-message-context.ts
```typescript
import type { Bot } from "grammy";

import { resolveAckReaction } from "../agents/identity.js";
import {
  findModelInCatalog,
  loadModelCatalog,
  modelSupportsVision,
} from "../agents/model-catalog.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { hasControlCommand } from "../auto-reply/command-detection.js";
import { normalizeCommandBody } from "../auto-reply/commands-registry.js";
import { formatInboundEnvelope, resolveEnvelopeFormatOptions } from "../auto-reply/envelope.js";
import {
  buildPendingHistoryContextFromMap,
  recordPendingHistoryEntryIfEnabled,
  type HistoryEntry,
} from "../auto-reply/reply/history.js";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import { buildMentionRegexes, matchesMentionWithExplicit } from "../auto-reply/reply/mentions.js";
import { formatLocationText, toLocationContext } from "../channels/location.js";
import { recordInboundSession } from "../channels/session.js";
import { formatCliCommand } from "../cli/command-format.js";
import { readSessionUpdatedAt, resolveStorePath } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/config.js";
import type { DmPolicy, TelegramGroupConfig, TelegramTopicConfig } from "../config/types.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { recordChannelActivity } from "../infra/channel-activity.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import { resolveThreadSessionKeys } from "../routing/session-key.js";
import { shouldAckReaction as shouldAckReactionGate } from "../channels/ack-reactions.js";
import { resolveMentionGatingWithBypass } from "../channels/mention-gating.js";
import { resolveControlCommandGate } from "../channels/command-gating.js";
import { logInboundDrop } from "../channels/logging.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import {
  buildGroupLabel,
  buildSenderLabel,
  buildSenderName,
  buildTelegramGroupFrom,
  buildTelegramGroupPeerId,
  buildTypingThreadParams,
  expandTextLinks,
  normalizeForwardedContext,
  describeReplyTarget,
  extractTelegramLocation,
  hasBotMention,
  resolveTelegramForumThreadId,
} from "./bot/helpers.js";
import {
  firstDefined,
  isSenderAllowed,
  normalizeAllowFromWithStore,
  resolveSenderAllowMatch,
} from "./bot-access.js";
import { upsertTelegramPairingRequest } from "./pairing-store.js";
import type { TelegramContext } from "./bot/types.js";

type TelegramMediaRef = {
  path: string;
  contentType?: string;
  stickerMetadata?: {
    emoji?: string;
    setName?: string;
    fileId?: string;
    fileUniqueId?: string;
    cachedDescription?: string;
  };
};

type TelegramMessageContextOptions = {
  forceWasMentioned?: boolean;
  messageIdOverride?: string;
};

type TelegramLogger = {
  info: (obj: Record<string, unknown>, msg: string) => void;
};

type ResolveTelegramGroupConfig = (
  chatId: string | number,
  messageThreadId?: number,
) => { groupConfig?: TelegramGroupConfig; topicConfig?: TelegramTopicConfig };

type ResolveGroupActivation = (params: {
  chatId: string | number;
  agentId?: string;
  messageThreadId?: number;
  sessionKey?: string;
}) => boolean | undefined;

type ResolveGroupRequireMention = (chatId: string | number) => boolean;

type BuildTelegramMessageContextParams = {
  primaryCtx: TelegramContext;
  allMedia: TelegramMediaRef[];
  storeAllowFrom: string[];
  options?: TelegramMessageContextOptions;
  bot: Bot;
  cfg: OpenClawConfig;
  account: { accountId: string };
  historyLimit: number;
  groupHistories: Map<string, HistoryEntry[]>;
  dmPolicy: DmPolicy;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  ackReactionScope: "off" | "group-mentions" | "group-all" | "direct" | "all";
  logger: TelegramLogger;
  resolveGroupActivation: ResolveGroupActivation;
  resolveGroupRequireMention: ResolveGroupRequireMention;
  resolveTelegramGroupConfig: ResolveTelegramGroupConfig;
};

async function resolveStickerVisionSupport(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): Promise<boolean> {
  try {
    const catalog = await loadModelCatalog({ config: params.cfg });
    const defaultModel = resolveDefaultModelForAgent({
      cfg: params.cfg,
      agentId: params.agentId,
    });
    const entry = findModelInCatalog(catalog, defaultModel.provider, defaultModel.model);
    if (!entry) {
      return false;
    }
    return modelSupportsVision(entry);
  } catch {
    return false;
  }
}

export const buildTelegramMessageContext = async ({
  primaryCtx,
  allMedia,
  storeAllowFrom,
  options,
  bot,
  cfg,
  account,
  historyLimit,
  groupHistories,
  dmPolicy,
  allowFrom,
  groupAllowFrom,
  ackReactionScope,
  logger,
  resolveGroupActivation,
  resolveGroupRequireMention,
  resolveTelegramGroupConfig,
}: BuildTelegramMessageContextParams) => {
  const msg = primaryCtx.message;
  recordChannelActivity({
    channel: "telegram",
    accountId: account.accountId,
    direction: "inbound",
  });
  const chatId = msg.chat.id;
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  const messageThreadId = (msg as { message_thread_id?: number }).message_thread_id;
  const isForum = (msg.chat as { is_forum?: boolean }).is_forum === true;
  const resolvedThreadId = resolveTelegramForumThreadId({
    isForum,
    messageThreadId,
  });
  const replyThreadId = isGroup ? resolvedThreadId : messageThreadId;
  const { groupConfig, topicConfig } = resolveTelegramGroupConfig(chatId, resolvedThreadId);
  const peerId = isGroup ? buildTelegramGroupPeerId(chatId, resolvedThreadId) : String(chatId);
  const route = resolveAgentRoute({
    cfg,
    channel: "telegram",
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "dm",
      id: peerId,
    },
  });
  const baseSessionKey = route.sessionKey;
  // DMs: use raw messageThreadId for thread sessions (not resolvedThreadId which is for forums)
  const dmThreadId = !isGroup ? messageThreadId : undefined;
  const threadKeys =
    dmThreadId != null
      ? resolveThreadSessionKeys({ baseSessionKey, threadId: String(dmThreadId) })
      : null;
  const sessionKey = threadKeys?.sessionKey ?? baseSessionKey;
  const mentionRegexes = buildMentionRegexes(cfg, route.agentId);
  const effectiveDmAllow = normalizeAllowFromWithStore({ allowFrom, storeAllowFrom });
  const groupAllowOverride = firstDefined(topicConfig?.allowFrom, groupConfig?.allowFrom);
  const effectiveGroupAllow = normalizeAllowFromWithStore({
    allowFrom: groupAllowOverride ?? groupAllowFrom,
    storeAllowFrom,
  });
  const hasGroupAllowOverride = typeof groupAllowOverride !== "undefined";

  if (isGroup && groupConfig?.enabled === false) {
    logVerbose(`Blocked telegram group ${chatId} (group disabled)`);
    return null;
  }
  if (isGroup && topicConfig?.enabled === false) {
    logVerbose(
      `Blocked telegram topic ${chatId} (${resolvedThreadId ?? "unknown"}) (topic disabled)`,
    );
    return null;
  }

  const sendTyping = async () => {
    await withTelegramApiErrorLogging({
      operation: "sendChatAction",
      fn: () => bot.api.sendChatAction(chatId, "typing", buildTypingThreadParams(replyThreadId)),
    });
  };

  const sendRecordVoice = async () => {
    try {
      await withTelegramApiErrorLogging({
        operation: "sendChatAction",
        fn: () =>
          bot.api.sendChatAction(chatId, "record_voice", buildTypingThreadParams(replyThreadId)),
      });
    } catch (err) {
      logVerbose(`telegram record_voice cue failed for chat ${chatId}: ${String(err)}`);
    }
  };

  // DM access control (secure defaults): "pairing" (default) / "allowlist" / "open" / "disabled"
  if (!isGroup) {
    if (dmPolicy === "disabled") {
      return null;
    }

    if (dmPolicy !== "open") {
      const candidate = String(chatId);
      const senderUsername = msg.from?.username ?? "";
      const allowMatch = resolveSenderAllowMatch({
        allow: effectiveDmAllow,
        senderId: candidate,
        senderUsername,
      });
      const allowMatchMeta = `matchKey=${allowMatch.matchKey ?? "none"} matchSource=${
        allowMatch.matchSource ?? "none"
      }`;
      const allowed =
        effectiveDmAllow.hasWildcard || (effectiveDmAllow.hasEntries && allowMatch.allowed);
      if (!allowed) {
        if (dmPolicy === "pairing") {
          try {
            const from = msg.from as
              | {
                  first_name?: string;
                  last_name?: string;
                  username?: string;
                  id?: number;
                }
              | undefined;
            const telegramUserId = from?.id ? String(from.id) : candidate;
            const { code, created } = await upsertTelegramPairingRequest({
              chatId: candidate,
              username: from?.username,
              firstName: from?.first_name,
              lastName: from?.last_name,
            });
            if (created) {
              logger.info(
                {
                  chatId: candidate,
                  username: from?.username,
                  firstName: from?.first_name,
                  lastName: from?.last_name,
                  matchKey: allowMatch.matchKey ?? "none",
                  matchSource: allowMatch.matchSource ?? "none",
                },
                "telegram pairing request",
              );
              await withTelegramApiErrorLogging({
                operation: "sendMessage",
                fn: () =>
                  bot.api.sendMessage(
                    chatId,
                    [
                      "OpenClaw: access not configured.",
                      "",
                      `Your Telegram user id: ${telegramUserId}`,
                      "",
                      `Pairing code: ${code}`,
                      "",
                      "Ask the bot owner to approve with:",
                      formatCliCommand("openclaw pairing approve telegram <code>"),
                    ].join("\n"),
                  ),
              });
            }
          } catch (err) {
            logVerbose(`telegram pairing reply failed for chat ${chatId}: ${String(err)}`);
          }
        } else {
          logVerbose(
            `Blocked unauthorized telegram sender ${candidate} (dmPolicy=${dmPolicy}, ${allowMatchMeta})`,
          );
        }
        return null;
      }
    }
  }

  const botUsername = primaryCtx.me?.username?.toLowerCase();
  const senderId = msg.from?.id ? String(msg.from.id) : "";
  const senderUsername = msg.from?.username ?? "";
  if (isGroup && hasGroupAllowOverride) {
    const allowed = isSenderAllowed({
      allow: effectiveGroupAllow,
      senderId,
      senderUsername,
    });
    if (!allowed) {
      logVerbose(
        `Blocked telegram group sender ${senderId || "unknown"} (group allowFrom override)`,
      );
      return null;
    }
  }
  const allowForCommands = isGroup ? effectiveGroupAllow : effectiveDmAllow;
  const senderAllowedForCommands = isSenderAllowed({
    allow: allowForCommands,
    senderId,
    senderUsername,
  });
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const hasControlCommandInMessage = hasControlCommand(msg.text ?? msg.caption ?? "", cfg, {
    botUsername,
  });
  const commandGate = resolveControlCommandGate({
    useAccessGroups,
    authorizers: [{ configured: allowForCommands.hasEntries, allowed: senderAllowedForCommands }],
    allowTextCommands: true,
    hasControlCommand: hasControlCommandInMessage,
  });
  const commandAuthorized = commandGate.commandAuthorized;
  const historyKey = isGroup ? buildTelegramGroupPeerId(chatId, resolvedThreadId) : undefined;

  let placeholder = "";
  if (msg.photo) {
    placeholder = "<media:image>";
  } else if (msg.video) {
    placeholder = "<media:video>";
  } else if (msg.video_note) {
    placeholder = "<media:video>";
  } else if (msg.audio || msg.voice) {
    placeholder = "<media:audio>";
  } else if (msg.document) {
    placeholder = "<media:document>";
  } else if (msg.sticker) {
    placeholder = "<media:sticker>";
  }

  // Check if sticker has a cached description - if so, use it instead of sending the image
  const cachedStickerDescription = allMedia[0]?.stickerMetadata?.cachedDescription;
  const stickerSupportsVision = msg.sticker
    ? await resolveStickerVisionSupport({ cfg, agentId: route.agentId })
    : false;
  const stickerCacheHit = Boolean(cachedStickerDescription) && !stickerSupportsVision;
  if (stickerCacheHit) {
    // Format cached description with sticker context
    const emoji = allMedia[0]?.stickerMetadata?.emoji;
    const setName = allMedia[0]?.stickerMetadata?.setName;
    const stickerContext = [emoji, setName ? `from "${setName}"` : null].filter(Boolean).join(" ");
    placeholder = `[Sticker${stickerContext ? ` ${stickerContext}` : ""}] ${cachedStickerDescription}`;
  }

  const locationData = extractTelegramLocation(msg);
  const locationText = locationData ? formatLocationText(locationData) : undefined;
  const rawTextSource = msg.text ?? msg.caption ?? "";
  const rawText = expandTextLinks(rawTextSource, msg.entities ?? msg.caption_entities).trim();
  let rawBody = [rawText, locationText].filter(Boolean).join("\n").trim();
  if (!rawBody) {
    rawBody = placeholder;
  }
  if (!rawBody && allMedia.length === 0) {
    return null;
  }

  let bodyText = rawBody;
  if (!bodyText && allMedia.length > 0) {
    bodyText = `<media:image>${allMedia.length > 1 ? ` (${allMedia.length} images)` : ""}`;
  }
  const hasAnyMention = (msg.entities ?? msg.caption_entities ?? []).some(
    (ent) => ent.type === "mention",
  );
  const explicitlyMentioned = botUsername ? hasBotMention(msg, botUsername) : false;
  const computedWasMentioned = matchesMentionWithExplicit({
    text: msg.text ?? msg.caption ?? "",
    mentionRegexes,
    explicit: {
      hasAnyMention,
      isExplicitlyMentioned: explicitlyMentioned,
      canResolveExplicit: Boolean(botUsername),
    },
  });
  const wasMentioned = options?.forceWasMentioned === true ? true : computedWasMentioned;
  if (isGroup && commandGate.shouldBlock) {
    logInboundDrop({
      log: logVerbose,
      channel: "telegram",
      reason: "control command (unauthorized)",
      target: senderId ?? "unknown",
    });
    return null;
  }
  const activationOverride = resolveGroupActivation({
    chatId,
    messageThreadId: resolvedThreadId,
    sessionKey: sessionKey,
    agentId: route.agentId,
  });
  const baseRequireMention = resolveGroupRequireMention(chatId);
  const requireMention = firstDefined(
    activationOverride,
    topicConfig?.requireMention,
    groupConfig?.requireMention,
    baseRequireMention,
  );
  // Reply-chain detection: replying to a bot message acts like an implicit mention.
  const botId = primaryCtx.me?.id;
  const replyFromId = msg.reply_to_message?.from?.id;
  const implicitMention = botId != null && replyFromId === botId;
  const canDetectMention = Boolean(botUsername) || mentionRegexes.length > 0;
  const mentionGate = resolveMentionGatingWithBypass({
    isGroup,
    requireMention: Boolean(requireMention),
    canDetectMention,
    wasMentioned,
    implicitMention: isGroup && Boolean(requireMention) && implicitMention,
    hasAnyMention,
    allowTextCommands: true,
    hasControlCommand: hasControlCommandInMessage,
    commandAuthorized,
  });
  const effectiveWasMentioned = mentionGate.effectiveWasMentioned;
  if (isGroup && requireMention && canDetectMention) {
    if (mentionGate.shouldSkip) {
      logger.info({ chatId, reason: "no-mention" }, "skipping group message");
      recordPendingHistoryEntryIfEnabled({
        historyMap: groupHistories,
        historyKey: historyKey ?? "",
        limit: historyLimit,
        entry: historyKey
          ? {
              sender: buildSenderLabel(msg, senderId || chatId),
              body: rawBody,
              timestamp: msg.date ? msg.date * 1000 : undefined,
              messageId: typeof msg.message_id === "number" ? String(msg.message_id) : undefined,
            }
          : null,
      });
      return null;
    }
  }

  // ACK reactions
  const ackReaction = resolveAckReaction(cfg, route.agentId);
  const removeAckAfterReply = cfg.messages?.removeAckAfterReply ?? false;
  const shouldAckReaction = () =>
    Boolean(
      ackReaction &&
      shouldAckReactionGate({
        scope: ackReactionScope,
        isDirect: !isGroup,
        isGroup,
        isMentionableGroup: isGroup,
        requireMention: Boolean(requireMention),
        canDetectMention,
        effectiveWasMentioned,
        shouldBypassMention: mentionGate.shouldBypassMention,
      }),
    );
  const api = bot.api as unknown as {
    setMessageReaction?: (
      chatId: number | string,
      messageId: number,
      reactions: Array<{ type: "emoji"; emoji: string }>,
    ) => Promise<void>;
  };
  const reactionApi =
    typeof api.setMessageReaction === "function" ? api.setMessageReaction.bind(api) : null;
  const ackReactionPromise =
    shouldAckReaction() && msg.message_id && reactionApi
      ? withTelegramApiErrorLogging({
          operation: "setMessageReaction",
          fn: () => reactionApi(chatId, msg.message_id, [{ type: "emoji", emoji: ackReaction }]),
        }).then(
          () => true,
          (err) => {
            logVerbose(`telegram react failed for chat ${chatId}: ${String(err)}`);
            return false;
          },
        )
      : null;

  const replyTarget = describeReplyTarget(msg);
  const forwardOrigin = normalizeForwardedContext(msg);
  const replySuffix = replyTarget
    ? replyTarget.kind === "quote"
      ? `\n\n[Quoting ${replyTarget.sender}${
          replyTarget.id ? ` id:${replyTarget.id}` : ""
        }]\n"${replyTarget.body}"\n[/Quoting]`
      : `\n\n[Replying to ${replyTarget.sender}${
          replyTarget.id ? ` id:${replyTarget.id}` : ""
        }]\n${replyTarget.body}\n[/Replying]`
    : "";
  const forwardPrefix = forwardOrigin
    ? `[Forwarded from ${forwardOrigin.from}${
        forwardOrigin.date ? ` at ${new Date(forwardOrigin.date * 1000).toISOString()}` : ""
      }]\n`
    : "";
  const groupLabel = isGroup ? buildGroupLabel(msg, chatId, resolvedThreadId) : undefined;
  const senderName = buildSenderName(msg);
  const conversationLabel = isGroup
    ? (groupLabel ?? `group:${chatId}`)
    : buildSenderLabel(msg, senderId || chatId);
  const storePath = resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = resolveEnvelopeFormatOptions(cfg);
  const previousTimestamp = readSessionUpdatedAt({
    storePath,
    sessionKey: sessionKey,
  });
  const body = formatInboundEnvelope({
    channel: "Telegram",
    from: conversationLabel,
    timestamp: msg.date ? msg.date * 1000 : undefined,
    body: `${forwardPrefix}${bodyText}${replySuffix}`,
    chatType: isGroup ? "group" : "direct",
    sender: {
      name: senderName,
      username: senderUsername || undefined,
      id: senderId || undefined,
    },
    previousTimestamp,
    envelope: envelopeOptions,
  });
  let combinedBody = body;
  if (isGroup && historyKey && historyLimit > 0) {
    combinedBody = buildPendingHistoryContextFromMap({
      historyMap: groupHistories,
      historyKey,
      limit: historyLimit,
      currentMessage: combinedBody,
      formatEntry: (entry) =>
        formatInboundEnvelope({
          channel: "Telegram",
          from: groupLabel ?? `group:${chatId}`,
          timestamp: entry.timestamp,
          body: `${entry.body} [id:${entry.messageId ?? "unknown"} chat:${chatId}]`,
          chatType: "group",
          senderLabel: entry.sender,
          envelope: envelopeOptions,
        }),
    });
  }

  const skillFilter = firstDefined(topicConfig?.skills, groupConfig?.skills);
  const systemPromptParts = [
    groupConfig?.systemPrompt?.trim() || null,
    topicConfig?.systemPrompt?.trim() || null,
  ].filter((entry): entry is string => Boolean(entry));
  const groupSystemPrompt =
    systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : undefined;
  const commandBody = normalizeCommandBody(rawBody, { botUsername });
  const ctxPayload = finalizeInboundContext({
    Body: combinedBody,
    RawBody: rawBody,
    CommandBody: commandBody,
    From: isGroup ? buildTelegramGroupFrom(chatId, resolvedThreadId) : `telegram:${chatId}`,
    To: `telegram:${chatId}`,
    SessionKey: sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: conversationLabel,
    GroupSubject: isGroup ? (msg.chat.title ?? undefined) : undefined,
    GroupSystemPrompt: isGroup ? groupSystemPrompt : undefined,
    SenderName: senderName,
    SenderId: senderId || undefined,
    SenderUsername: senderUsername || undefined,
    Provider: "telegram",
    Surface: "telegram",
    MessageSid: options?.messageIdOverride ?? String(msg.message_id),
    ReplyToId: replyTarget?.id,
    ReplyToBody: replyTarget?.body,
    ReplyToSender: replyTarget?.sender,
    ReplyToIsQuote: replyTarget?.kind === "quote" ? true : undefined,
    ForwardedFrom: forwardOrigin?.from,
    ForwardedFromType: forwardOrigin?.fromType,
    ForwardedFromId: forwardOrigin?.fromId,
    ForwardedFromUsername: forwardOrigin?.fromUsername,
    ForwardedFromTitle: forwardOrigin?.fromTitle,
    ForwardedFromSignature: forwardOrigin?.fromSignature,
    ForwardedDate: forwardOrigin?.date ? forwardOrigin.date * 1000 : undefined,
    Timestamp: msg.date ? msg.date * 1000 : undefined,
    WasMentioned: isGroup ? effectiveWasMentioned : undefined,
    // Filter out cached stickers from media - their description is already in the message body
    MediaPath: stickerCacheHit ? undefined : allMedia[0]?.path,
    MediaType: stickerCacheHit ? undefined : allMedia[0]?.contentType,
    MediaUrl: stickerCacheHit ? undefined : allMedia[0]?.path,
    MediaPaths: stickerCacheHit
      ? undefined
      : allMedia.length > 0
        ? allMedia.map((m) => m.path)
        : undefined,
    MediaUrls: stickerCacheHit
      ? undefined
      : allMedia.length > 0
        ? allMedia.map((m) => m.path)
        : undefined,
    MediaTypes: stickerCacheHit
      ? undefined
      : allMedia.length > 0
        ? (allMedia.map((m) => m.contentType).filter(Boolean) as string[])
        : undefined,
    Sticker: allMedia[0]?.stickerMetadata,
    ...(locationData ? toLocationContext(locationData) : undefined),
    CommandAuthorized: commandAuthorized,
    // For groups: use resolvedThreadId (forum topics only); for DMs: use raw messageThreadId
    MessageThreadId: isGroup ? resolvedThreadId : messageThreadId,
    IsForum: isForum,
    // Originating channel for reply routing.
    OriginatingChannel: "telegram" as const,
    OriginatingTo: `telegram:${chatId}`,
  });

  await recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? sessionKey,
    ctx: ctxPayload,
    updateLastRoute: !isGroup
      ? {
          sessionKey: route.mainSessionKey,
          channel: "telegram",
          to: String(chatId),
          accountId: route.accountId,
        }
      : undefined,
    onRecordError: (err) => {
      logVerbose(`telegram: failed updating session meta: ${String(err)}`);
    },
  });

  if (replyTarget && shouldLogVerbose()) {
    const preview = replyTarget.body.replace(/\s+/g, " ").slice(0, 120);
    logVerbose(
      `telegram reply-context: replyToId=${replyTarget.id} replyToSender=${replyTarget.sender} replyToBody="${preview}"`,
    );
  }

  if (forwardOrigin && shouldLogVerbose()) {
    logVerbose(
      `telegram forward-context: forwardedFrom="${forwardOrigin.from}" type=${forwardOrigin.fromType}`,
    );
  }

  if (shouldLogVerbose()) {
    const preview = body.slice(0, 200).replace(/\n/g, "\\n");
    const mediaInfo = allMedia.length > 1 ? ` mediaCount=${allMedia.length}` : "";
    const topicInfo = resolvedThreadId != null ? ` topic=${resolvedThreadId}` : "";
    logVerbose(
      `telegram inbound: chatId=${chatId} from=${ctxPayload.From} len=${body.length}${mediaInfo}${topicInfo} preview="${preview}"`,
    );
  }

  return {
    ctxPayload,
    primaryCtx,
    msg,
    chatId,
    isGroup,
    resolvedThreadId,
    replyThreadId,
    isForum,
    historyKey,
    historyLimit,
    groupHistories,
    route,
    skillFilter,
    sendTyping,
    sendRecordVoice,
    ackReactionPromise,
    reactionApi,
    removeAckAfterReply,
    accountId: account.accountId,
  };
};
```

## src/telegram/bot-message-dispatch.ts
```typescript
// @ts-nocheck
import {
  findModelInCatalog,
  loadModelCatalog,
  modelSupportsVision,
} from "../agents/model-catalog.js";
import { EmbeddedBlockChunker } from "../agents/pi-embedded-block-chunker.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { resolveChunkMode } from "../auto-reply/chunk.js";
import { clearHistoryEntriesIfEnabled } from "../auto-reply/reply/history.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../auto-reply/reply/provider-dispatcher.js";
import { removeAckReactionAfterReply } from "../channels/ack-reactions.js";
import { logAckFailure, logTypingFailure } from "../channels/logging.js";
import { createReplyPrefixContext } from "../channels/reply-prefix.js";
import { createTypingCallbacks } from "../channels/typing.js";
import { danger, logVerbose } from "../globals.js";
import { resolveMarkdownTableMode } from "../config/markdown-tables.js";
import { deliverReplies } from "./bot/delivery.js";
import { resolveTelegramDraftStreamingChunking } from "./draft-chunking.js";
import { createTelegramDraftStream } from "./draft-stream.js";
import { cacheSticker, describeStickerImage } from "./sticker-cache.js";
import { resolveAgentDir } from "../agents/agent-scope.js";

const EMPTY_RESPONSE_FALLBACK = "No response generated. Please try again.";

async function resolveStickerVisionSupport(cfg, agentId) {
  try {
    const catalog = await loadModelCatalog({ config: cfg });
    const defaultModel = resolveDefaultModelForAgent({ cfg, agentId });
    const entry = findModelInCatalog(catalog, defaultModel.provider, defaultModel.model);
    if (!entry) {
      return false;
    }
    return modelSupportsVision(entry);
  } catch {
    return false;
  }
}

export const dispatchTelegramMessage = async ({
  context,
  bot,
  cfg,
  runtime,
  replyToMode,
  streamMode,
  textLimit,
  telegramCfg,
  opts,
  resolveBotTopicsEnabled,
}) => {
  const {
    ctxPayload,
    primaryCtx,
    msg,
    chatId,
    isGroup,
    replyThreadId,
    historyKey,
    historyLimit,
    groupHistories,
    route,
    skillFilter,
    sendTyping,
    sendRecordVoice,
    ackReactionPromise,
    reactionApi,
    removeAckAfterReply,
  } = context;

  const isPrivateChat = msg.chat.type === "private";
  const messageThreadId = (msg as { message_thread_id?: number }).message_thread_id;
  const draftThreadId = replyThreadId ?? messageThreadId;
  const draftMaxChars = Math.min(textLimit, 4096);
  const canStreamDraft =
    streamMode !== "off" &&
    isPrivateChat &&
    typeof draftThreadId === "number" &&
    (await resolveBotTopicsEnabled(primaryCtx));
  const draftStream = canStreamDraft
    ? createTelegramDraftStream({
        api: bot.api,
        chatId,
        draftId: msg.message_id || Date.now(),
        maxChars: draftMaxChars,
        messageThreadId: draftThreadId,
        log: logVerbose,
        warn: logVerbose,
      })
    : undefined;
  const draftChunking =
    draftStream && streamMode === "block"
      ? resolveTelegramDraftStreamingChunking(cfg, route.accountId)
      : undefined;
  const draftChunker = draftChunking ? new EmbeddedBlockChunker(draftChunking) : undefined;
  let lastPartialText = "";
  let draftText = "";
  const updateDraftFromPartial = (text?: string) => {
    if (!draftStream || !text) {
      return;
    }
    if (text === lastPartialText) {
      return;
    }
    if (streamMode === "partial") {
      lastPartialText = text;
      draftStream.update(text);
      return;
    }
    let delta = text;
    if (text.startsWith(lastPartialText)) {
      delta = text.slice(lastPartialText.length);
    } else {
      // Streaming buffer reset (or non-monotonic stream). Start fresh.
      draftChunker?.reset();
      draftText = "";
    }
    lastPartialText = text;
    if (!delta) {
      return;
    }
    if (!draftChunker) {
      draftText = text;
      draftStream.update(draftText);
      return;
    }
    draftChunker.append(delta);
    draftChunker.drain({
      force: false,
      emit: (chunk) => {
        draftText += chunk;
        draftStream.update(draftText);
      },
    });
  };
  const flushDraft = async () => {
    if (!draftStream) {
      return;
    }
    if (draftChunker?.hasBuffered()) {
      draftChunker.drain({
        force: true,
        emit: (chunk) => {
          draftText += chunk;
        },
      });
      draftChunker.reset();
      if (draftText) {
        draftStream.update(draftText);
      }
    }
    await draftStream.flush();
  };

  const disableBlockStreaming =
    Boolean(draftStream) ||
    (typeof telegramCfg.blockStreaming === "boolean" ? !telegramCfg.blockStreaming : undefined);

  const prefixContext = createReplyPrefixContext({ cfg, agentId: route.agentId });
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "telegram",
    accountId: route.accountId,
  });
  const chunkMode = resolveChunkMode(cfg, "telegram", route.accountId);

  // Handle uncached stickers: get a dedicated vision description before dispatch
  // This ensures we cache a raw description rather than a conversational response
  const sticker = ctxPayload.Sticker;
  if (sticker?.fileUniqueId && ctxPayload.MediaPath) {
    const agentDir = resolveAgentDir(cfg, route.agentId);
    const stickerSupportsVision = await resolveStickerVisionSupport(cfg, route.agentId);
    let description = sticker.cachedDescription ?? null;
    if (!description) {
      description = await describeStickerImage({
        imagePath: ctxPayload.MediaPath,
        cfg,
        agentDir,
        agentId: route.agentId,
      });
    }
    if (description) {
      // Format the description with sticker context
      const stickerContext = [sticker.emoji, sticker.setName ? `from "${sticker.setName}"` : null]
        .filter(Boolean)
        .join(" ");
      const formattedDesc = `[Sticker${stickerContext ? ` ${stickerContext}` : ""}] ${description}`;

      sticker.cachedDescription = description;
      if (!stickerSupportsVision) {
        // Update context to use description instead of image
        ctxPayload.Body = formattedDesc;
        ctxPayload.BodyForAgent = formattedDesc;
        // Clear media paths so native vision doesn't process the image again
        ctxPayload.MediaPath = undefined;
        ctxPayload.MediaType = undefined;
        ctxPayload.MediaUrl = undefined;
        ctxPayload.MediaPaths = undefined;
        ctxPayload.MediaUrls = undefined;
        ctxPayload.MediaTypes = undefined;
      }

      // Cache the description for future encounters
      cacheSticker({
        fileId: sticker.fileId,
        fileUniqueId: sticker.fileUniqueId,
        emoji: sticker.emoji,
        setName: sticker.setName,
        description,
        cachedAt: new Date().toISOString(),
        receivedFrom: ctxPayload.From,
      });
      logVerbose(`telegram: cached sticker description for ${sticker.fileUniqueId}`);
    }
  }

  const replyQuoteText =
    ctxPayload.ReplyToIsQuote && ctxPayload.ReplyToBody
      ? ctxPayload.ReplyToBody.trim() || undefined
      : undefined;
  const deliveryState = {
    delivered: false,
    skippedNonSilent: 0,
  };

  const { queuedFinal } = await dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      deliver: async (payload, info) => {
        if (info.kind === "final") {
          await flushDraft();
          draftStream?.stop();
        }
        const result = await deliverReplies({
          replies: [payload],
          chatId: String(chatId),
          token: opts.token,
          runtime,
          bot,
          replyToMode,
          textLimit,
          messageThreadId: replyThreadId,
          tableMode,
          chunkMode,
          onVoiceRecording: sendRecordVoice,
          linkPreview: telegramCfg.linkPreview,
          replyQuoteText,
        });
        if (result.delivered) {
          deliveryState.delivered = true;
        }
      },
      onSkip: (_payload, info) => {
        if (info.reason !== "silent") {
          deliveryState.skippedNonSilent += 1;
        }
      },
      onError: (err, info) => {
        runtime.error?.(danger(`telegram ${info.kind} reply failed: ${String(err)}`));
      },
      onReplyStart: createTypingCallbacks({
        start: sendTyping,
        onStartError: (err) => {
          logTypingFailure({
            log: logVerbose,
            channel: "telegram",
            target: String(chatId),
            error: err,
          });
        },
      }).onReplyStart,
    },
    replyOptions: {
      skillFilter,
      disableBlockStreaming,
      onPartialReply: draftStream ? (payload) => updateDraftFromPartial(payload.text) : undefined,
      onModelSelected: (ctx) => {
        prefixContext.onModelSelected(ctx);
      },
    },
  });
  draftStream?.stop();
  let sentFallback = false;
  if (!deliveryState.delivered && deliveryState.skippedNonSilent > 0) {
    const result = await deliverReplies({
      replies: [{ text: EMPTY_RESPONSE_FALLBACK }],
      chatId: String(chatId),
      token: opts.token,
      runtime,
      bot,
      replyToMode,
      textLimit,
      messageThreadId: replyThreadId,
      tableMode,
      chunkMode,
      linkPreview: telegramCfg.linkPreview,
      replyQuoteText,
    });
    sentFallback = result.delivered;
  }

  const hasFinalResponse = queuedFinal || sentFallback;
  if (!hasFinalResponse) {
    if (isGroup && historyKey) {
      clearHistoryEntriesIfEnabled({ historyMap: groupHistories, historyKey, limit: historyLimit });
    }
    return;
  }
  removeAckReactionAfterReply({
    removeAfterReply: removeAckAfterReply,
    ackReactionPromise,
    ackReactionValue: ackReactionPromise ? "ack" : null,
    remove: () => reactionApi?.(chatId, msg.message_id ?? 0, []) ?? Promise.resolve(),
    onError: (err) => {
      if (!msg.message_id) {
        return;
      }
      logAckFailure({
        log: logVerbose,
        channel: "telegram",
        target: `${chatId}/${msg.message_id}`,
        error: err,
      });
    },
  });
  if (isGroup && historyKey) {
    clearHistoryEntriesIfEnabled({ historyMap: groupHistories, historyKey, limit: historyLimit });
  }
};
```
## src/telegram/bot-native-commands.ts
```typescript
import type { Bot, Context } from "grammy";

import { resolveEffectiveMessagesConfig } from "../agents/identity.js";
import { resolveChunkMode } from "../auto-reply/chunk.js";
import {
  buildCommandTextFromArgs,
  findCommandByNativeName,
  listNativeCommandSpecs,
  listNativeCommandSpecsForConfig,
  parseCommandArgs,
  resolveCommandArgMenu,
} from "../auto-reply/commands-registry.js";
import { listSkillCommandsForAgents } from "../auto-reply/skill-commands.js";
import type { CommandArgs } from "../auto-reply/commands-registry.js";
import { resolveTelegramCustomCommands } from "../config/telegram-custom-commands.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../auto-reply/reply/provider-dispatcher.js";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import { danger, logVerbose } from "../globals.js";
import { resolveMarkdownTableMode } from "../config/markdown-tables.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import {
  normalizeTelegramCommandName,
  TELEGRAM_COMMAND_NAME_PATTERN,
} from "../config/telegram-custom-commands.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import { resolveThreadSessionKeys } from "../routing/session-key.js";
import { resolveCommandAuthorizedFromAuthorizers } from "../channels/command-gating.js";
import {
  executePluginCommand,
  getPluginCommandSpecs,
  matchPluginCommand,
} from "../plugins/commands.js";
import type { ChannelGroupPolicy } from "../config/group-policy.js";
import type {
  ReplyToMode,
  TelegramAccountConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "../config/types.js";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { deliverReplies } from "./bot/delivery.js";
import { buildInlineKeyboard } from "./send.js";
import {
  buildSenderName,
  buildTelegramGroupFrom,
  buildTelegramGroupPeerId,
  resolveTelegramForumThreadId,
} from "./bot/helpers.js";
import { firstDefined, isSenderAllowed, normalizeAllowFromWithStore } from "./bot-access.js";
import { readTelegramAllowFromStore } from "./pairing-store.js";

const EMPTY_RESPONSE_FALLBACK = "No response generated. Please try again.";

type TelegramNativeCommandContext = Context & { match?: string };

type TelegramCommandAuthResult = {
  chatId: number;
  isGroup: boolean;
  isForum: boolean;
  resolvedThreadId?: number;
  senderId: string;
  senderUsername: string;
  groupConfig?: TelegramGroupConfig;
  topicConfig?: TelegramTopicConfig;
  commandAuthorized: boolean;
};

type RegisterTelegramNativeCommandsParams = {
  bot: Bot;
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  accountId: string;
  telegramCfg: TelegramAccountConfig;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  replyToMode: ReplyToMode;
  textLimit: number;
  useAccessGroups: boolean;
  nativeEnabled: boolean;
  nativeSkillsEnabled: boolean;
  nativeDisabledExplicit: boolean;
  resolveGroupPolicy: (chatId: string | number) => ChannelGroupPolicy;
  resolveTelegramGroupConfig: (
    chatId: string | number,
    messageThreadId?: number,
  ) => { groupConfig?: TelegramGroupConfig; topicConfig?: TelegramTopicConfig };
  shouldSkipUpdate: (ctx: unknown) => boolean;
  opts: { token: string };
};

async function resolveTelegramCommandAuth(params: {
  msg: NonNullable<TelegramNativeCommandContext["message"]>;
  bot: Bot;
  cfg: OpenClawConfig;
  telegramCfg: TelegramAccountConfig;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  useAccessGroups: boolean;
  resolveGroupPolicy: (chatId: string | number) => ChannelGroupPolicy;
  resolveTelegramGroupConfig: (
    chatId: string | number,
    messageThreadId?: number,
  ) => { groupConfig?: TelegramGroupConfig; topicConfig?: TelegramTopicConfig };
  requireAuth: boolean;
}): Promise<TelegramCommandAuthResult | null> {
  const {
    msg,
    bot,
    cfg,
    telegramCfg,
    allowFrom,
    groupAllowFrom,
    useAccessGroups,
    resolveGroupPolicy,
    resolveTelegramGroupConfig,
    requireAuth,
  } = params;
  const chatId = msg.chat.id;
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  const messageThreadId = (msg as { message_thread_id?: number }).message_thread_id;
  const isForum = (msg.chat as { is_forum?: boolean }).is_forum === true;
  const resolvedThreadId = resolveTelegramForumThreadId({
    isForum,
    messageThreadId,
  });
  const storeAllowFrom = await readTelegramAllowFromStore().catch(() => []);
  const { groupConfig, topicConfig } = resolveTelegramGroupConfig(chatId, resolvedThreadId);
  const groupAllowOverride = firstDefined(topicConfig?.allowFrom, groupConfig?.allowFrom);
  const effectiveGroupAllow = normalizeAllowFromWithStore({
    allowFrom: groupAllowOverride ?? groupAllowFrom,
    storeAllowFrom,
  });
  const hasGroupAllowOverride = typeof groupAllowOverride !== "undefined";
  const senderIdRaw = msg.from?.id;
  const senderId = senderIdRaw ? String(senderIdRaw) : "";
  const senderUsername = msg.from?.username ?? "";

  if (isGroup && groupConfig?.enabled === false) {
    await withTelegramApiErrorLogging({
      operation: "sendMessage",
      fn: () => bot.api.sendMessage(chatId, "This group is disabled."),
    });
    return null;
  }
  if (isGroup && topicConfig?.enabled === false) {
    await withTelegramApiErrorLogging({
      operation: "sendMessage",
      fn: () => bot.api.sendMessage(chatId, "This topic is disabled."),
    });
    return null;
  }
  if (requireAuth && isGroup && hasGroupAllowOverride) {
    if (
      senderIdRaw == null ||
      !isSenderAllowed({
        allow: effectiveGroupAllow,
        senderId: String(senderIdRaw),
        senderUsername,
      })
    ) {
      await withTelegramApiErrorLogging({
        operation: "sendMessage",
        fn: () => bot.api.sendMessage(chatId, "You are not authorized to use this command."),
      });
      return null;
    }
  }

  if (isGroup && useAccessGroups) {
    const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
    const groupPolicy = telegramCfg.groupPolicy ?? defaultGroupPolicy ?? "open";
    if (groupPolicy === "disabled") {
      await withTelegramApiErrorLogging({
        operation: "sendMessage",
        fn: () => bot.api.sendMessage(chatId, "Telegram group commands are disabled."),
      });
      return null;
    }
    if (groupPolicy === "allowlist" && requireAuth) {
      if (
        senderIdRaw == null ||
        !isSenderAllowed({
          allow: effectiveGroupAllow,
          senderId: String(senderIdRaw),
          senderUsername,
        })
      ) {
        await withTelegramApiErrorLogging({
          operation: "sendMessage",
          fn: () => bot.api.sendMessage(chatId, "You are not authorized to use this command."),
        });
        return null;
      }
    }
    const groupAllowlist = resolveGroupPolicy(chatId);
    if (groupAllowlist.allowlistEnabled && !groupAllowlist.allowed) {
      await withTelegramApiErrorLogging({
        operation: "sendMessage",
        fn: () => bot.api.sendMessage(chatId, "This group is not allowed."),
      });
      return null;
    }
  }

  const dmAllow = normalizeAllowFromWithStore({
    allowFrom: allowFrom,
    storeAllowFrom,
  });
  const senderAllowed = isSenderAllowed({
    allow: dmAllow,
    senderId,
    senderUsername,
  });
  const commandAuthorized = resolveCommandAuthorizedFromAuthorizers({
    useAccessGroups,
    authorizers: [{ configured: dmAllow.hasEntries, allowed: senderAllowed }],
    modeWhenAccessGroupsOff: "configured",
  });
  if (requireAuth && !commandAuthorized) {
    await withTelegramApiErrorLogging({
      operation: "sendMessage",
      fn: () => bot.api.sendMessage(chatId, "You are not authorized to use this command."),
    });
    return null;
  }

  return {
    chatId,
    isGroup,
    isForum,
    resolvedThreadId,
    senderId,
    senderUsername,
    groupConfig,
    topicConfig,
    commandAuthorized,
  };
}

export const registerTelegramNativeCommands = ({
  bot,
  cfg,
  runtime,
  accountId,
  telegramCfg,
  allowFrom,
  groupAllowFrom,
  replyToMode,
  textLimit,
  useAccessGroups,
  nativeEnabled,
  nativeSkillsEnabled,
  nativeDisabledExplicit,
  resolveGroupPolicy,
  resolveTelegramGroupConfig,
  shouldSkipUpdate,
  opts,
}: RegisterTelegramNativeCommandsParams) => {
  const boundRoute =
    nativeEnabled && nativeSkillsEnabled
      ? resolveAgentRoute({ cfg, channel: "telegram", accountId })
      : null;
  const boundAgentIds =
    boundRoute && boundRoute.matchedBy.startsWith("binding.") ? [boundRoute.agentId] : null;
  const skillCommands =
    nativeEnabled && nativeSkillsEnabled
      ? listSkillCommandsForAgents(boundAgentIds ? { cfg, agentIds: boundAgentIds } : { cfg })
      : [];
  const nativeCommands = nativeEnabled
    ? listNativeCommandSpecsForConfig(cfg, { skillCommands, provider: "telegram" })
    : [];
  const reservedCommands = new Set(
    listNativeCommandSpecs().map((command) => command.name.toLowerCase()),
  );
  for (const command of skillCommands) {
    reservedCommands.add(command.name.toLowerCase());
  }
  const customResolution = resolveTelegramCustomCommands({
    commands: telegramCfg.customCommands,
    reservedCommands,
  });
  for (const issue of customResolution.issues) {
    runtime.error?.(danger(issue.message));
  }
  const customCommands = customResolution.commands;
  const pluginCommandSpecs = getPluginCommandSpecs();
  const pluginCommands: Array<{ command: string; description: string }> = [];
  const existingCommands = new Set(
    [
      ...nativeCommands.map((command) => command.name),
      ...customCommands.map((command) => command.command),
    ].map((command) => command.toLowerCase()),
  );
  const pluginCommandNames = new Set<string>();
  for (const spec of pluginCommandSpecs) {
    const normalized = normalizeTelegramCommandName(spec.name);
    if (!normalized || !TELEGRAM_COMMAND_NAME_PATTERN.test(normalized)) {
      runtime.error?.(
        danger(
          `Plugin command "/${spec.name}" is invalid for Telegram (use a-z, 0-9, underscore; max 32 chars).`,
        ),
      );
      continue;
    }
    const description = spec.description.trim();
    if (!description) {
      runtime.error?.(danger(`Plugin command "/${normalized}" is missing a description.`));
      continue;
    }
    if (existingCommands.has(normalized)) {
      runtime.error?.(
        danger(`Plugin command "/${normalized}" conflicts with an existing Telegram command.`),
      );
      continue;
    }
    if (pluginCommandNames.has(normalized)) {
      runtime.error?.(danger(`Plugin command "/${normalized}" is duplicated.`));
      continue;
    }
    pluginCommandNames.add(normalized);
    existingCommands.add(normalized);
    pluginCommands.push({ command: normalized, description });
  }
  const allCommands: Array<{ command: string; description: string }> = [
    ...nativeCommands.map((command) => ({
      command: command.name,
      description: command.description,
    })),
    ...pluginCommands,
    ...customCommands,
  ];

  if (allCommands.length > 0) {
    withTelegramApiErrorLogging({
      operation: "setMyCommands",
      runtime,
      fn: () => bot.api.setMyCommands(allCommands),
    }).catch(() => {});

    if (typeof (bot as unknown as { command?: unknown }).command !== "function") {
      logVerbose("telegram: bot.command unavailable; skipping native handlers");
    } else {
      for (const command of nativeCommands) {
        bot.command(command.name, async (ctx: TelegramNativeCommandContext) => {
          const msg = ctx.message;
          if (!msg) {
            return;
          }
          if (shouldSkipUpdate(ctx)) {
            return;
          }
          const auth = await resolveTelegramCommandAuth({
            msg,
            bot,
            cfg,
            telegramCfg,
            allowFrom,
            groupAllowFrom,
            useAccessGroups,
            resolveGroupPolicy,
            resolveTelegramGroupConfig,
            requireAuth: true,
          });
          if (!auth) {
            return;
          }
          const {
            chatId,
            isGroup,
            isForum,
            resolvedThreadId,
            senderId,
            senderUsername,
            groupConfig,
            topicConfig,
            commandAuthorized,
          } = auth;
          const messageThreadId = (msg as { message_thread_id?: number }).message_thread_id;
          const threadIdForSend = isGroup ? resolvedThreadId : messageThreadId;

          const commandDefinition = findCommandByNativeName(command.name, "telegram");
          const rawText = ctx.match?.trim() ?? "";
          const commandArgs = commandDefinition
            ? parseCommandArgs(commandDefinition, rawText)
            : rawText
              ? ({ raw: rawText } satisfies CommandArgs)
              : undefined;
          const prompt = commandDefinition
            ? buildCommandTextFromArgs(commandDefinition, commandArgs)
            : rawText
              ? `/${command.name} ${rawText}`
              : `/${command.name}`;
          const menu = commandDefinition
            ? resolveCommandArgMenu({
                command: commandDefinition,
                args: commandArgs,
                cfg,
              })
            : null;
          if (menu && commandDefinition) {
            const title =
              menu.title ??
              `Choose ${menu.arg.description || menu.arg.name} for /${commandDefinition.nativeName ?? commandDefinition.key}.`;
            const rows: Array<Array<{ text: string; callback_data: string }>> = [];
            for (let i = 0; i < menu.choices.length; i += 2) {
              const slice = menu.choices.slice(i, i + 2);
              rows.push(
                slice.map((choice) => {
                  const args: CommandArgs = {
                    values: { [menu.arg.name]: choice.value },
                  };
                  return {
                    text: choice.label,
                    callback_data: buildCommandTextFromArgs(commandDefinition, args),
                  };
                }),
              );
            }
            const replyMarkup = buildInlineKeyboard(rows);
            await withTelegramApiErrorLogging({
              operation: "sendMessage",
              runtime,
              fn: () =>
                bot.api.sendMessage(chatId, title, {
                  ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
                  ...(threadIdForSend != null ? { message_thread_id: threadIdForSend } : {}),
                }),
            });
            return;
          }
          const route = resolveAgentRoute({
            cfg,
            channel: "telegram",
            accountId,
            peer: {
              kind: isGroup ? "group" : "dm",
              id: isGroup ? buildTelegramGroupPeerId(chatId, resolvedThreadId) : String(chatId),
            },
          });
          const baseSessionKey = route.sessionKey;
          // DMs: use raw messageThreadId for thread sessions (not resolvedThreadId which is for forums)
          const dmThreadId = !isGroup ? messageThreadId : undefined;
          const threadKeys =
            dmThreadId != null
              ? resolveThreadSessionKeys({ baseSessionKey, threadId: String(dmThreadId) })
              : null;
          const sessionKey = threadKeys?.sessionKey ?? baseSessionKey;
          const tableMode = resolveMarkdownTableMode({
            cfg,
            channel: "telegram",
            accountId: route.accountId,
          });
          const skillFilter = firstDefined(topicConfig?.skills, groupConfig?.skills);
          const systemPromptParts = [
            groupConfig?.systemPrompt?.trim() || null,
            topicConfig?.systemPrompt?.trim() || null,
          ].filter((entry): entry is string => Boolean(entry));
          const groupSystemPrompt =
            systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : undefined;
          const conversationLabel = isGroup
            ? msg.chat.title
              ? `${msg.chat.title} id:${chatId}`
              : `group:${chatId}`
            : (buildSenderName(msg) ?? String(senderId || chatId));
          const ctxPayload = finalizeInboundContext({
            Body: prompt,
            RawBody: prompt,
            CommandBody: prompt,
            CommandArgs: commandArgs,
            From: isGroup ? buildTelegramGroupFrom(chatId, resolvedThreadId) : `telegram:${chatId}`,
            To: `slash:${senderId || chatId}`,
            ChatType: isGroup ? "group" : "direct",
            ConversationLabel: conversationLabel,
            GroupSubject: isGroup ? (msg.chat.title ?? undefined) : undefined,
            GroupSystemPrompt: isGroup ? groupSystemPrompt : undefined,
            SenderName: buildSenderName(msg),
            SenderId: senderId || undefined,
            SenderUsername: senderUsername || undefined,
            Surface: "telegram",
            MessageSid: String(msg.message_id),
            Timestamp: msg.date ? msg.date * 1000 : undefined,
            WasMentioned: true,
            CommandAuthorized: commandAuthorized,
            CommandSource: "native" as const,
            SessionKey: `telegram:slash:${senderId || chatId}`,
            AccountId: route.accountId,
            CommandTargetSessionKey: sessionKey,
            MessageThreadId: threadIdForSend,
            IsForum: isForum,
            // Originating context for sub-agent announce routing
            OriginatingChannel: "telegram" as const,
            OriginatingTo: `telegram:${chatId}`,
          });

          const disableBlockStreaming =
            typeof telegramCfg.blockStreaming === "boolean"
              ? !telegramCfg.blockStreaming
              : undefined;
          const chunkMode = resolveChunkMode(cfg, "telegram", route.accountId);

          const deliveryState = {
            delivered: false,
            skippedNonSilent: 0,
          };

          await dispatchReplyWithBufferedBlockDispatcher({
            ctx: ctxPayload,
            cfg,
            dispatcherOptions: {
              responsePrefix: resolveEffectiveMessagesConfig(cfg, route.agentId).responsePrefix,
              deliver: async (payload, _info) => {
                const result = await deliverReplies({
                  replies: [payload],
                  chatId: String(chatId),
                  token: opts.token,
                  runtime,
                  bot,
                  replyToMode,
                  textLimit,
                  messageThreadId: threadIdForSend,
                  tableMode,
                  chunkMode,
                  linkPreview: telegramCfg.linkPreview,
                });
                if (result.delivered) {
                  deliveryState.delivered = true;
                }
              },
              onSkip: (_payload, info) => {
                if (info.reason !== "silent") {
                  deliveryState.skippedNonSilent += 1;
                }
              },
              onError: (err, info) => {
                runtime.error?.(danger(`telegram slash ${info.kind} reply failed: ${String(err)}`));
              },
            },
            replyOptions: {
              skillFilter,
              disableBlockStreaming,
            },
          });
          if (!deliveryState.delivered && deliveryState.skippedNonSilent > 0) {
            await deliverReplies({
              replies: [{ text: EMPTY_RESPONSE_FALLBACK }],
              chatId: String(chatId),
              token: opts.token,
              runtime,
              bot,
              replyToMode,
              textLimit,
              messageThreadId: threadIdForSend,
              tableMode,
              chunkMode,
              linkPreview: telegramCfg.linkPreview,
            });
          }
        });
      }

      for (const pluginCommand of pluginCommands) {
        bot.command(pluginCommand.command, async (ctx: TelegramNativeCommandContext) => {
          const msg = ctx.message;
          if (!msg) {
            return;
          }
          if (shouldSkipUpdate(ctx)) {
            return;
          }
          const chatId = msg.chat.id;
          const rawText = ctx.match?.trim() ?? "";
          const commandBody = `/${pluginCommand.command}${rawText ? ` ${rawText}` : ""}`;
          const match = matchPluginCommand(commandBody);
          if (!match) {
            await withTelegramApiErrorLogging({
              operation: "sendMessage",
              runtime,
              fn: () => bot.api.sendMessage(chatId, "Command not found."),
            });
            return;
          }
          const auth = await resolveTelegramCommandAuth({
            msg,
            bot,
            cfg,
            telegramCfg,
            allowFrom,
            groupAllowFrom,
            useAccessGroups,
            resolveGroupPolicy,
            resolveTelegramGroupConfig,
            requireAuth: match.command.requireAuth !== false,
          });
          if (!auth) {
            return;
          }
          const { resolvedThreadId, senderId, commandAuthorized, isGroup } = auth;
          const messageThreadId = (msg as { message_thread_id?: number }).message_thread_id;
          const threadIdForSend = isGroup ? resolvedThreadId : messageThreadId;

          const result = await executePluginCommand({
            command: match.command,
            args: match.args,
            senderId,
            channel: "telegram",
            isAuthorizedSender: commandAuthorized,
            commandBody,
            config: cfg,
          });
          const tableMode = resolveMarkdownTableMode({
            cfg,
            channel: "telegram",
            accountId,
          });
          const chunkMode = resolveChunkMode(cfg, "telegram", accountId);

          await deliverReplies({
            replies: [result],
            chatId: String(chatId),
            token: opts.token,
            runtime,
            bot,
            replyToMode,
            textLimit,
            messageThreadId: threadIdForSend,
            tableMode,
            chunkMode,
            linkPreview: telegramCfg.linkPreview,
          });
        });
      }
    }
  } else if (nativeDisabledExplicit) {
    withTelegramApiErrorLogging({
      operation: "setMyCommands",
      runtime,
      fn: () => bot.api.setMyCommands([]),
    }).catch(() => {});
  }
};
```

## src/telegram/inline-buttons.ts
```typescript
import type { OpenClawConfig } from "../config/config.js";
import type { TelegramInlineButtonsScope } from "../config/types.telegram.js";
import { listTelegramAccountIds, resolveTelegramAccount } from "./accounts.js";
import { parseTelegramTarget } from "./targets.js";

const DEFAULT_INLINE_BUTTONS_SCOPE: TelegramInlineButtonsScope = "allowlist";

function normalizeInlineButtonsScope(value: unknown): TelegramInlineButtonsScope | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  if (
    trimmed === "off" ||
    trimmed === "dm" ||
    trimmed === "group" ||
    trimmed === "all" ||
    trimmed === "allowlist"
  ) {
    return trimmed as TelegramInlineButtonsScope;
  }
  return undefined;
}

function resolveInlineButtonsScopeFromCapabilities(
  capabilities: unknown,
): TelegramInlineButtonsScope {
  if (!capabilities) {
    return DEFAULT_INLINE_BUTTONS_SCOPE;
  }
  if (Array.isArray(capabilities)) {
    const enabled = capabilities.some(
      (entry) => String(entry).trim().toLowerCase() === "inlinebuttons",
    );
    return enabled ? "all" : "off";
  }
  if (typeof capabilities === "object") {
    const inlineButtons = (capabilities as { inlineButtons?: unknown }).inlineButtons;
    return normalizeInlineButtonsScope(inlineButtons) ?? DEFAULT_INLINE_BUTTONS_SCOPE;
  }
  return DEFAULT_INLINE_BUTTONS_SCOPE;
}

export function resolveTelegramInlineButtonsScope(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): TelegramInlineButtonsScope {
  const account = resolveTelegramAccount({ cfg: params.cfg, accountId: params.accountId });
  return resolveInlineButtonsScopeFromCapabilities(account.config.capabilities);
}

export function isTelegramInlineButtonsEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  if (params.accountId) {
    return resolveTelegramInlineButtonsScope(params) !== "off";
  }
  const accountIds = listTelegramAccountIds(params.cfg);
  if (accountIds.length === 0) {
    return resolveTelegramInlineButtonsScope(params) !== "off";
  }
  return accountIds.some(
    (accountId) => resolveTelegramInlineButtonsScope({ cfg: params.cfg, accountId }) !== "off",
  );
}

export function resolveTelegramTargetChatType(target: string): "direct" | "group" | "unknown" {
  if (!target.trim()) {
    return "unknown";
  }
  const parsed = parseTelegramTarget(target);
  const chatId = parsed.chatId.trim();
  if (!chatId) {
    return "unknown";
  }
  if (/^-?\d+$/.test(chatId)) {
    return chatId.startsWith("-") ? "group" : "direct";
  }
  return "unknown";
}
```
## src/telegram/accounts.ts
```typescript
import type { OpenClawConfig } from "../config/config.js";
import type { TelegramAccountConfig } from "../config/types.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { listBoundAccountIds, resolveDefaultAgentBoundAccountId } from "../routing/bindings.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
import { resolveTelegramToken } from "./token.js";

const debugAccounts = (...args: unknown[]) => {
  if (isTruthyEnvValue(process.env.OPENCLAW_DEBUG_TELEGRAM_ACCOUNTS)) {
    console.warn("[telegram:accounts]", ...args);
  }
};

export type ResolvedTelegramAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  token: string;
  tokenSource: "env" | "tokenFile" | "config" | "none";
  config: TelegramAccountConfig;
};

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
  const accounts = cfg.channels?.telegram?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  const ids = new Set<string>();
  for (const key of Object.keys(accounts)) {
    if (!key) {
      continue;
    }
    ids.add(normalizeAccountId(key));
  }
  return [...ids];
}

export function listTelegramAccountIds(cfg: OpenClawConfig): string[] {
  const ids = Array.from(
    new Set([...listConfiguredAccountIds(cfg), ...listBoundAccountIds(cfg, "telegram")]),
  );
  debugAccounts("listTelegramAccountIds", ids);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultTelegramAccountId(cfg: OpenClawConfig): string {
  const boundDefault = resolveDefaultAgentBoundAccountId(cfg, "telegram");
  if (boundDefault) {
    return boundDefault;
  }
  const ids = listTelegramAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): TelegramAccountConfig | undefined {
  const accounts = cfg.channels?.telegram?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  const direct = accounts[accountId] as TelegramAccountConfig | undefined;
  if (direct) {
    return direct;
  }
  const normalized = normalizeAccountId(accountId);
  const matchKey = Object.keys(accounts).find((key) => normalizeAccountId(key) === normalized);
  return matchKey ? (accounts[matchKey] as TelegramAccountConfig | undefined) : undefined;
}

function mergeTelegramAccountConfig(cfg: OpenClawConfig, accountId: string): TelegramAccountConfig {
  const { accounts: _ignored, ...base } = (cfg.channels?.telegram ??
    {}) as TelegramAccountConfig & { accounts?: unknown };
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

export function resolveTelegramAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedTelegramAccount {
  const hasExplicitAccountId = Boolean(params.accountId?.trim());
  const baseEnabled = params.cfg.channels?.telegram?.enabled !== false;

  const resolve = (accountId: string) => {
    const merged = mergeTelegramAccountConfig(params.cfg, accountId);
    const accountEnabled = merged.enabled !== false;
    const enabled = baseEnabled && accountEnabled;
    const tokenResolution = resolveTelegramToken(params.cfg, { accountId });
    debugAccounts("resolve", {
      accountId,
      enabled,
      tokenSource: tokenResolution.source,
    });
    return {
      accountId,
      enabled,
      name: merged.name?.trim() || undefined,
      token: tokenResolution.token,
      tokenSource: tokenResolution.source,
      config: merged,
    } satisfies ResolvedTelegramAccount;
  };

  const normalized = normalizeAccountId(params.accountId);
  const primary = resolve(normalized);
  if (hasExplicitAccountId) {
    return primary;
  }
  if (primary.tokenSource !== "none") {
    return primary;
  }

  // If accountId is omitted, prefer a configured account token over failing on
  // the implicit "default" account. This keeps env-based setups working while
  // making config-only tokens work for things like heartbeats.
  const fallbackId = resolveDefaultTelegramAccountId(params.cfg);
  if (fallbackId === primary.accountId) {
    return primary;
  }
  const fallback = resolve(fallbackId);
  if (fallback.tokenSource === "none") {
    return primary;
  }
  return fallback;
}

export function listEnabledTelegramAccounts(cfg: OpenClawConfig): ResolvedTelegramAccount[] {
  return listTelegramAccountIds(cfg)
    .map((accountId) => resolveTelegramAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
```

## src/telegram/targets.ts
```typescript
export type TelegramTarget = {
  chatId: string;
  messageThreadId?: number;
};

export function stripTelegramInternalPrefixes(to: string): string {
  let trimmed = to.trim();
  let strippedTelegramPrefix = false;
  while (true) {
    const next = (() => {
      if (/^(telegram|tg):/i.test(trimmed)) {
        strippedTelegramPrefix = true;
        return trimmed.replace(/^(telegram|tg):/i, "").trim();
      }
      // Legacy internal form: `telegram:group:<id>` (still emitted by session keys).
      if (strippedTelegramPrefix && /^group:/i.test(trimmed)) {
        return trimmed.replace(/^group:/i, "").trim();
      }
      return trimmed;
    })();
    if (next === trimmed) {
      return trimmed;
    }
    trimmed = next;
  }
}

/**
 * Parse a Telegram delivery target into chatId and optional topic/thread ID.
 *
 * Supported formats:
 * - `chatId` (plain chat ID, t.me link, @username, or internal prefixes like `telegram:...`)
 * - `chatId:topicId` (numeric topic/thread ID)
 * - `chatId:topic:topicId` (explicit topic marker; preferred)
 */
export function parseTelegramTarget(to: string): TelegramTarget {
  const normalized = stripTelegramInternalPrefixes(to);

  const topicMatch = /^(.+?):topic:(\d+)$/.exec(normalized);
  if (topicMatch) {
    return {
      chatId: topicMatch[1],
      messageThreadId: Number.parseInt(topicMatch[2], 10),
    };
  }

  const colonMatch = /^(.+):(\d+)$/.exec(normalized);
  if (colonMatch) {
    return {
      chatId: colonMatch[1],
      messageThreadId: Number.parseInt(colonMatch[2], 10),
    };
  }

  return { chatId: normalized };
}
```

## src/telegram/voice.ts
```typescript
import { isVoiceCompatibleAudio } from "../media/audio.js";

export function isTelegramVoiceCompatible(opts: {
  contentType?: string | null;
  fileName?: string | null;
}): boolean {
  return isVoiceCompatibleAudio(opts);
}

export function resolveTelegramVoiceDecision(opts: {
  wantsVoice: boolean;
  contentType?: string | null;
  fileName?: string | null;
}): { useVoice: boolean; reason?: string } {
  if (!opts.wantsVoice) {
    return { useVoice: false };
  }
  if (isTelegramVoiceCompatible(opts)) {
    return { useVoice: true };
  }
  const contentType = opts.contentType ?? "unknown";
  const fileName = opts.fileName ?? "unknown";
  return {
    useVoice: false,
    reason: `media is ${contentType} (${fileName})`,
  };
}

export function resolveTelegramVoiceSend(opts: {
  wantsVoice: boolean;
  contentType?: string | null;
  fileName?: string | null;
  logFallback?: (message: string) => void;
}): { useVoice: boolean } {
  const decision = resolveTelegramVoiceDecision(opts);
  if (decision.reason && opts.logFallback) {
    opts.logFallback(
      `Telegram voice requested but ${decision.reason}; sending as audio file instead.`,
    );
  }
  return { useVoice: decision.useVoice };
}
```

## src/telegram/network-config.ts
```typescript
import process from "node:process";

import { isTruthyEnvValue } from "../infra/env.js";
import type { TelegramNetworkConfig } from "../config/types.telegram.js";

export const TELEGRAM_DISABLE_AUTO_SELECT_FAMILY_ENV =
  "OPENCLAW_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY";
export const TELEGRAM_ENABLE_AUTO_SELECT_FAMILY_ENV = "OPENCLAW_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY";

export type TelegramAutoSelectFamilyDecision = {
  value: boolean | null;
  source?: string;
};

export function resolveTelegramAutoSelectFamilyDecision(params?: {
  network?: TelegramNetworkConfig;
  env?: NodeJS.ProcessEnv;
  nodeMajor?: number;
}): TelegramAutoSelectFamilyDecision {
  const env = params?.env ?? process.env;
  const nodeMajor =
    typeof params?.nodeMajor === "number"
      ? params.nodeMajor
      : Number(process.versions.node.split(".")[0]);

  if (isTruthyEnvValue(env[TELEGRAM_ENABLE_AUTO_SELECT_FAMILY_ENV])) {
    return { value: true, source: `env:${TELEGRAM_ENABLE_AUTO_SELECT_FAMILY_ENV}` };
  }
  if (isTruthyEnvValue(env[TELEGRAM_DISABLE_AUTO_SELECT_FAMILY_ENV])) {
    return { value: false, source: `env:${TELEGRAM_DISABLE_AUTO_SELECT_FAMILY_ENV}` };
  }
  if (typeof params?.network?.autoSelectFamily === "boolean") {
    return { value: params.network.autoSelectFamily, source: "config" };
  }
  if (Number.isFinite(nodeMajor) && nodeMajor >= 22) {
    return { value: false, source: "default-node22" };
  }
  return { value: null };
}
```
## src/telegram/sticker-cache.ts
```typescript
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { STATE_DIR } from "../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";
import { logVerbose } from "../globals.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import {
  findModelInCatalog,
  loadModelCatalog,
  modelSupportsVision,
} from "../agents/model-catalog.js";
import { resolveApiKeyForProvider } from "../agents/model-auth.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { resolveAutoImageModel } from "../media-understanding/runner.js";

const CACHE_FILE = path.join(STATE_DIR, "telegram", "sticker-cache.json");
const CACHE_VERSION = 1;

export interface CachedSticker {
  fileId: string;
  fileUniqueId: string;
  emoji?: string;
  setName?: string;
  description: string;
  cachedAt: string;
  receivedFrom?: string;
}

interface StickerCache {
  version: number;
  stickers: Record<string, CachedSticker>;
}

function loadCache(): StickerCache {
  const data = loadJsonFile(CACHE_FILE);
  if (!data || typeof data !== "object") {
    return { version: CACHE_VERSION, stickers: {} };
  }
  const cache = data as StickerCache;
  if (cache.version !== CACHE_VERSION) {
    // Future: handle migration if needed
    return { version: CACHE_VERSION, stickers: {} };
  }
  return cache;
}

function saveCache(cache: StickerCache): void {
  saveJsonFile(CACHE_FILE, cache);
}

/**
 * Get a cached sticker by its unique ID.
 */
export function getCachedSticker(fileUniqueId: string): CachedSticker | null {
  const cache = loadCache();
  return cache.stickers[fileUniqueId] ?? null;
}

/**
 * Add or update a sticker in the cache.
 */
export function cacheSticker(sticker: CachedSticker): void {
  const cache = loadCache();
  cache.stickers[sticker.fileUniqueId] = sticker;
  saveCache(cache);
}

/**
 * Search cached stickers by text query (fuzzy match on description + emoji + setName).
 */
export function searchStickers(query: string, limit = 10): CachedSticker[] {
  const cache = loadCache();
  const queryLower = query.toLowerCase();
  const results: Array<{ sticker: CachedSticker; score: number }> = [];

  for (const sticker of Object.values(cache.stickers)) {
    let score = 0;
    const descLower = sticker.description.toLowerCase();

    // Exact substring match in description
    if (descLower.includes(queryLower)) {
      score += 10;
    }

    // Word-level matching
    const queryWords = queryLower.split(/\s+/).filter(Boolean);
    const descWords = descLower.split(/\s+/);
    for (const qWord of queryWords) {
      if (descWords.some((dWord) => dWord.includes(qWord))) {
        score += 5;
      }
    }

    // Emoji match
    if (sticker.emoji && query.includes(sticker.emoji)) {
      score += 8;
    }

    // Set name match
    if (sticker.setName?.toLowerCase().includes(queryLower)) {
      score += 3;
    }

    if (score > 0) {
      results.push({ sticker, score });
    }
  }

  return results
    .toSorted((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.sticker);
}

/**
 * Get all cached stickers (for debugging/listing).
 */
export function getAllCachedStickers(): CachedSticker[] {
  const cache = loadCache();
  return Object.values(cache.stickers);
}

/**
 * Get cache statistics.
 */
export function getCacheStats(): { count: number; oldestAt?: string; newestAt?: string } {
  const cache = loadCache();
  const stickers = Object.values(cache.stickers);
  if (stickers.length === 0) {
    return { count: 0 };
  }
  const sorted = [...stickers].toSorted(
    (a, b) => new Date(a.cachedAt).getTime() - new Date(b.cachedAt).getTime(),
  );
  return {
    count: stickers.length,
    oldestAt: sorted[0]?.cachedAt,
    newestAt: sorted[sorted.length - 1]?.cachedAt,
  };
}

const STICKER_DESCRIPTION_PROMPT =
  "Describe this sticker image in 1-2 sentences. Focus on what the sticker depicts (character, object, action, emotion). Be concise and objective.";
const VISION_PROVIDERS = ["openai", "anthropic", "google", "minimax"] as const;

export interface DescribeStickerParams {
  imagePath: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  agentId?: string;
}

/**
 * Describe a sticker image using vision API.
 * Auto-detects an available vision provider based on configured API keys.
 * Returns null if no vision provider is available.
 */
export async function describeStickerImage(params: DescribeStickerParams): Promise<string | null> {
  const { imagePath, cfg, agentDir, agentId } = params;

  const defaultModel = resolveDefaultModelForAgent({ cfg, agentId });
  let activeModel = undefined as { provider: string; model: string } | undefined;
  let catalog: ModelCatalogEntry[] = [];
  try {
    catalog = await loadModelCatalog({ config: cfg });
    const entry = findModelInCatalog(catalog, defaultModel.provider, defaultModel.model);
    const supportsVision = modelSupportsVision(entry);
    if (supportsVision) {
      activeModel = { provider: defaultModel.provider, model: defaultModel.model };
    }
  } catch {
    // Ignore catalog failures; fall back to auto selection.
  }

  const hasProviderKey = async (provider: string) => {
    try {
      await resolveApiKeyForProvider({ provider, cfg, agentDir });
      return true;
    } catch {
      return false;
    }
  };

  const selectCatalogModel = (provider: string) => {
    const entries = catalog.filter(
      (entry) =>
        entry.provider.toLowerCase() === provider.toLowerCase() && modelSupportsVision(entry),
    );
    if (entries.length === 0) {
      return undefined;
    }
    const defaultId =
      provider === "openai"
        ? "gpt-5-mini"
        : provider === "anthropic"
          ? "claude-opus-4-5"
          : provider === "google"
            ? "gemini-3-flash-preview"
            : "MiniMax-VL-01";
    const preferred = entries.find((entry) => entry.id === defaultId);
    return preferred ?? entries[0];
  };

  let resolved = null as { provider: string; model?: string } | null;
  if (
    activeModel &&
    VISION_PROVIDERS.includes(activeModel.provider as (typeof VISION_PROVIDERS)[number]) &&
    (await hasProviderKey(activeModel.provider))
  ) {
    resolved = activeModel;
  }

  if (!resolved) {
    for (const provider of VISION_PROVIDERS) {
      if (!(await hasProviderKey(provider))) {
        continue;
      }
      const entry = selectCatalogModel(provider);
      if (entry) {
        resolved = { provider, model: entry.id };
        break;
      }
    }
  }

  if (!resolved) {
    resolved = await resolveAutoImageModel({
      cfg,
      agentDir,
      activeModel,
    });
  }

  if (!resolved?.model) {
    logVerbose("telegram: no vision provider available for sticker description");
    return null;
  }

  const { provider, model } = resolved;
  logVerbose(`telegram: describing sticker with ${provider}/${model}`);

  try {
    const buffer = await fs.readFile(imagePath);
    // Dynamic import to avoid circular dependency
    const { describeImageWithModel } = await import("../media-understanding/providers/image.js");
    const result = await describeImageWithModel({
      buffer,
      fileName: "sticker.webp",
      mime: "image/webp",
      prompt: STICKER_DESCRIPTION_PROMPT,
      cfg,
      agentDir: agentDir ?? "",
      provider,
      model,
      maxTokens: 150,
      timeoutMs: 30000,
    });
    return result.text;
  } catch (err) {
    logVerbose(`telegram: failed to describe sticker: ${String(err)}`);
    return null;
  }
}
```

## src/telegram/draft-chunking.ts
```typescript
import { resolveTextChunkLimit } from "../auto-reply/chunk.js";
import { getChannelDock } from "../channels/dock.js";
import type { OpenClawConfig } from "../config/config.js";
import { normalizeAccountId } from "../routing/session-key.js";

const DEFAULT_TELEGRAM_DRAFT_STREAM_MIN = 200;
const DEFAULT_TELEGRAM_DRAFT_STREAM_MAX = 800;

export function resolveTelegramDraftStreamingChunking(
  cfg: OpenClawConfig | undefined,
  accountId?: string | null,
): {
  minChars: number;
  maxChars: number;
  breakPreference: "paragraph" | "newline" | "sentence";
} {
  const providerChunkLimit = getChannelDock("telegram")?.outbound?.textChunkLimit;
  const textLimit = resolveTextChunkLimit(cfg, "telegram", accountId, {
    fallbackLimit: providerChunkLimit,
  });
  const normalizedAccountId = normalizeAccountId(accountId);
  const draftCfg =
    cfg?.channels?.telegram?.accounts?.[normalizedAccountId]?.draftChunk ??
    cfg?.channels?.telegram?.draftChunk;

  const maxRequested = Math.max(
    1,
    Math.floor(draftCfg?.maxChars ?? DEFAULT_TELEGRAM_DRAFT_STREAM_MAX),
  );
  const maxChars = Math.max(1, Math.min(maxRequested, textLimit));
  const minRequested = Math.max(
    1,
    Math.floor(draftCfg?.minChars ?? DEFAULT_TELEGRAM_DRAFT_STREAM_MIN),
  );
  const minChars = Math.min(minRequested, maxChars);
  const breakPreference =
    draftCfg?.breakPreference === "newline" || draftCfg?.breakPreference === "sentence"
      ? draftCfg.breakPreference
      : "paragraph";
  return { minChars, maxChars, breakPreference };
}
```

## src/telegram/draft-stream.ts
```typescript
import type { Bot } from "grammy";
import { buildTelegramThreadParams } from "./bot/helpers.js";

const TELEGRAM_DRAFT_MAX_CHARS = 4096;
const DEFAULT_THROTTLE_MS = 300;

export type TelegramDraftStream = {
  update: (text: string) => void;
  flush: () => Promise<void>;
  stop: () => void;
};

export function createTelegramDraftStream(params: {
  api: Bot["api"];
  chatId: number;
  draftId: number;
  maxChars?: number;
  messageThreadId?: number;
  throttleMs?: number;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}): TelegramDraftStream {
  const maxChars = Math.min(params.maxChars ?? TELEGRAM_DRAFT_MAX_CHARS, TELEGRAM_DRAFT_MAX_CHARS);
  const throttleMs = Math.max(50, params.throttleMs ?? DEFAULT_THROTTLE_MS);
  const rawDraftId = Number.isFinite(params.draftId) ? Math.trunc(params.draftId) : 1;
  const draftId = rawDraftId === 0 ? 1 : Math.abs(rawDraftId);
  const chatId = params.chatId;
  const threadParams = buildTelegramThreadParams(params.messageThreadId);

  let lastSentText = "";
  let lastSentAt = 0;
  let pendingText = "";
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const sendDraft = async (text: string) => {
    if (stopped) {
      return;
    }
    const trimmed = text.trimEnd();
    if (!trimmed) {
      return;
    }
    if (trimmed.length > maxChars) {
      // Drafts are capped at 4096 chars. Stop streaming once we exceed the cap
      // so we don't keep sending failing updates or a truncated preview.
      stopped = true;
      params.warn?.(`telegram draft stream stopped (draft length ${trimmed.length} > ${maxChars})`);
      return;
    }
    if (trimmed === lastSentText) {
      return;
    }
    lastSentText = trimmed;
    lastSentAt = Date.now();
    try {
      await params.api.sendMessageDraft(chatId, draftId, trimmed, threadParams);
    } catch (err) {
      stopped = true;
      params.warn?.(
        `telegram draft stream failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const flush = async () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (inFlight) {
      schedule();
      return;
    }
    const text = pendingText;
    const trimmed = text.trim();
    if (!trimmed) {
      if (pendingText === text) {
        pendingText = "";
      }
      if (pendingText) {
        schedule();
      }
      return;
    }
    pendingText = "";
    inFlight = true;
    try {
      await sendDraft(text);
    } finally {
      inFlight = false;
    }
    if (pendingText) {
      schedule();
    }
  };

  const schedule = () => {
    if (timer) {
      return;
    }
    const delay = Math.max(0, throttleMs - (Date.now() - lastSentAt));
    timer = setTimeout(() => {
      void flush();
    }, delay);
  };

  const update = (text: string) => {
    if (stopped) {
      return;
    }
    pendingText = text;
    if (inFlight) {
      schedule();
      return;
    }
    if (!timer && Date.now() - lastSentAt >= throttleMs) {
      void flush();
      return;
    }
    schedule();
  };

  const stop = () => {
    stopped = true;
    pendingText = "";
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  params.log?.(
    `telegram draft stream ready (draftId=${draftId}, maxChars=${maxChars}, throttleMs=${throttleMs})`,
  );

  return { update, flush, stop };
}
```
## src/telegram/pairing-store.ts
```typescript
import type { OpenClawConfig } from "../config/config.js";
import {
  addChannelAllowFromStoreEntry,
  approveChannelPairingCode,
  listChannelPairingRequests,
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "../pairing/pairing-store.js";

export type TelegramPairingListEntry = {
  chatId: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  code: string;
  createdAt: string;
  lastSeenAt: string;
};

const PROVIDER = "telegram" as const;

export async function readTelegramAllowFromStore(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  return readChannelAllowFromStore(PROVIDER, env);
}

export async function addTelegramAllowFromStoreEntry(params: {
  entry: string | number;
  env?: NodeJS.ProcessEnv;
}): Promise<{ changed: boolean; allowFrom: string[] }> {
  return addChannelAllowFromStoreEntry({
    channel: PROVIDER,
    entry: params.entry,
    env: params.env,
  });
}

export async function listTelegramPairingRequests(
  env: NodeJS.ProcessEnv = process.env,
): Promise<TelegramPairingListEntry[]> {
  const list = await listChannelPairingRequests(PROVIDER, env);
  return list.map((r) => ({
    chatId: r.id,
    code: r.code,
    createdAt: r.createdAt,
    lastSeenAt: r.lastSeenAt,
    username: r.meta?.username,
    firstName: r.meta?.firstName,
    lastName: r.meta?.lastName,
  }));
}

export async function upsertTelegramPairingRequest(params: {
  chatId: string | number;
  username?: string;
  firstName?: string;
  lastName?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ code: string; created: boolean }> {
  return upsertChannelPairingRequest({
    channel: PROVIDER,
    id: String(params.chatId),
    env: params.env,
    meta: {
      username: params.username,
      firstName: params.firstName,
      lastName: params.lastName,
    },
  });
}

export async function approveTelegramPairingCode(params: {
  code: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ chatId: string; entry?: TelegramPairingListEntry } | null> {
  const res = await approveChannelPairingCode({
    channel: PROVIDER,
    code: params.code,
    env: params.env,
  });
  if (!res) {
    return null;
  }
  const entry = res.entry
    ? {
        chatId: res.entry.id,
        code: res.entry.code,
        createdAt: res.entry.createdAt,
        lastSeenAt: res.entry.lastSeenAt,
        username: res.entry.meta?.username,
        firstName: res.entry.meta?.firstName,
        lastName: res.entry.meta?.lastName,
      }
    : undefined;
  return { chatId: res.id, entry };
}

export async function resolveTelegramEffectiveAllowFrom(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<{ dm: string[]; group: string[] }> {
  const env = params.env ?? process.env;
  const cfgAllowFrom = (params.cfg.channels?.telegram?.allowFrom ?? [])
    .map((v) => String(v).trim())
    .filter(Boolean)
    .map((v) => v.replace(/^(telegram|tg):/i, ""))
    .filter((v) => v !== "*");
  const cfgGroupAllowFrom = (params.cfg.channels?.telegram?.groupAllowFrom ?? [])
    .map((v) => String(v).trim())
    .filter(Boolean)
    .map((v) => v.replace(/^(telegram|tg):/i, ""))
    .filter((v) => v !== "*");
  const storeAllowFrom = await readTelegramAllowFromStore(env);

  const dm = Array.from(new Set([...cfgAllowFrom, ...storeAllowFrom]));
  const group = Array.from(
    new Set([
      ...(cfgGroupAllowFrom.length > 0 ? cfgGroupAllowFrom : cfgAllowFrom),
      ...storeAllowFrom,
    ]),
  );
  return { dm, group };
}
```

## src/telegram/group-migration.ts
```typescript
import type { OpenClawConfig } from "../config/config.js";
import type { TelegramGroupConfig } from "../config/types.telegram.js";
import { normalizeAccountId } from "../routing/session-key.js";

type TelegramGroups = Record<string, TelegramGroupConfig>;

type MigrationScope = "account" | "global";

export type TelegramGroupMigrationResult = {
  migrated: boolean;
  skippedExisting: boolean;
  scopes: MigrationScope[];
};

function resolveAccountGroups(
  cfg: OpenClawConfig,
  accountId?: string | null,
): { groups?: TelegramGroups } {
  if (!accountId) {
    return {};
  }
  const normalized = normalizeAccountId(accountId);
  const accounts = cfg.channels?.telegram?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return {};
  }
  const exact = accounts[normalized];
  if (exact?.groups) {
    return { groups: exact.groups };
  }
  const matchKey = Object.keys(accounts).find(
    (key) => key.toLowerCase() === normalized.toLowerCase(),
  );
  return { groups: matchKey ? accounts[matchKey]?.groups : undefined };
}

export function migrateTelegramGroupsInPlace(
  groups: TelegramGroups | undefined,
  oldChatId: string,
  newChatId: string,
): { migrated: boolean; skippedExisting: boolean } {
  if (!groups) {
    return { migrated: false, skippedExisting: false };
  }
  if (oldChatId === newChatId) {
    return { migrated: false, skippedExisting: false };
  }
  if (!Object.hasOwn(groups, oldChatId)) {
    return { migrated: false, skippedExisting: false };
  }
  if (Object.hasOwn(groups, newChatId)) {
    return { migrated: false, skippedExisting: true };
  }
  groups[newChatId] = groups[oldChatId];
  delete groups[oldChatId];
  return { migrated: true, skippedExisting: false };
}

export function migrateTelegramGroupConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  oldChatId: string;
  newChatId: string;
}): TelegramGroupMigrationResult {
  const scopes: MigrationScope[] = [];
  let migrated = false;
  let skippedExisting = false;

  const accountGroups = resolveAccountGroups(params.cfg, params.accountId).groups;
  if (accountGroups) {
    const result = migrateTelegramGroupsInPlace(accountGroups, params.oldChatId, params.newChatId);
    if (result.migrated) {
      migrated = true;
      scopes.push("account");
    }
    if (result.skippedExisting) {
      skippedExisting = true;
    }
  }

  const globalGroups = params.cfg.channels?.telegram?.groups;
  if (globalGroups) {
    const result = migrateTelegramGroupsInPlace(globalGroups, params.oldChatId, params.newChatId);
    if (result.migrated) {
      migrated = true;
      scopes.push("global");
    }
    if (result.skippedExisting) {
      skippedExisting = true;
    }
  }

  return { migrated, skippedExisting, scopes };
}
```
