import TelegramBot from 'node-telegram-bot-api';
import type { Config } from './config.js';
import type { AgentRunner } from './agent-runner.js';
import { processManager } from './process-manager.js';
import {
  buildPromptWithAttachments,
  downloadFile,
  extractFilePaths,
  stripFilePaths,
} from './file-utils.js';
import { loadSettings, saveSettings } from './settings.js';
import { STREAM_UPDATE_INTERVAL_MS } from './constants.js';

const TELEGRAM_SAFE_LENGTH = 4000;
const TYPING_INTERVAL_MS = 4000;

const sessions = new Map<string, string>();
const processingChats = new Set<string>();
const lastBotMessages = new Map<string, { chatId: number; messageId: number }>();

export interface TelegramChannelOptions {
  config: Config;
  agentRunner: AgentRunner;
}

function splitMessage(text: string, maxLength: number = TELEGRAM_SAFE_LENGTH): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  const blocks = text.split('\n');
  let current = '';

  for (const block of blocks) {
    const next = current ? `${current}\n${block}` : block;
    if (next.length <= maxLength) {
      current = next;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = '';
    }

    if (block.length <= maxLength) {
      current = block;
      continue;
    }

    for (let start = 0; start < block.length; start += maxLength) {
      chunks.push(block.slice(start, start + maxLength));
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks.filter(Boolean);
}

function getChannelKey(chatId: number): string {
  return `telegram:${chatId}`;
}

function isAllowedUser(config: Config, userId?: number): boolean {
  if (!userId) return false;
  if (config.telegram.allowedUsers?.includes('*')) return true;
  return config.telegram.allowedUsers?.includes(String(userId)) ?? false;
}

function isNewCommand(text: string): boolean {
  return /^(?:!new|new|\/new(?:@[\w_]+)?|!clear|clear|\/clear(?:@[\w_]+)?)$/i.test(text.trim());
}

function isStopCommand(text: string): boolean {
  return /^(?:!stop|stop|\/stop(?:@[\w_]+)?)$/i.test(text.trim());
}

function handleSystemCommands(text: string): void {
  const commands = text.match(/^SYSTEM_COMMAND:(.+)$/gm);
  if (!commands) return;

  for (const cmd of commands) {
    const action = cmd.replace('SYSTEM_COMMAND:', '').trim();

    if (action === 'restart') {
      const settings = loadSettings();
      if (!settings.autoRestart) {
        console.log('[telegram] Restart requested but autoRestart is disabled');
        continue;
      }
      console.log('[telegram] Restart requested by agent, restarting in 1s...');
      setTimeout(() => process.exit(0), 1000);
      return;
    }

    const setMatch = action.match(/^set\s+(\w+)=(.*)/);
    if (setMatch) {
      const [, key, value] = setMatch;
      if (key === 'autoRestart') {
        const enabled = value === 'true';
        saveSettings({ autoRestart: enabled });
        console.log(`[telegram] autoRestart ${enabled ? 'enabled' : 'disabled'} by agent`);
      }
    }
  }
}

async function editMessageText(
  bot: TelegramBot,
  chatId: number,
  messageId: number,
  text: string
): Promise<void> {
  try {
    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    if (errorMessage.includes('message is not modified')) {
      return;
    }
    throw err;
  }
}

async function sendResultText(
  bot: TelegramBot,
  chatId: number,
  messageId: number,
  result: string,
  replyToMessageId?: number
): Promise<void> {
  const chunks = splitMessage(result || '✅');
  await editMessageText(bot, chatId, messageId, chunks[0] || '✅');

  for (let index = 1; index < chunks.length; index++) {
    await bot.sendMessage(chatId, chunks[index], {
      ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
    });
  }
}

async function downloadTelegramImage(
  bot: TelegramBot,
  fileId: string,
  filename: string
): Promise<string> {
  const fileLink = await bot.getFileLink(fileId);
  return downloadFile(fileLink, filename);
}

async function processMessage(
  bot: TelegramBot,
  agentRunner: AgentRunner,
  config: Config,
  params: {
    chatId: number;
    channelId: string;
    userId: number;
    displayName: string;
    originalMessageId: number;
    prompt: string;
  }
): Promise<void> {
  const { chatId, channelId, userId, displayName, originalMessageId } = params;
  const skipPermissions = config.agent.config.skipPermissions ?? false;
  let prompt = params.prompt;
  let replyMessageId = 0;

  if (prompt.startsWith('!skip')) {
    prompt = prompt.replace(/^!skip\s*/, '').trim();
  }

  prompt = `[プラットフォーム: Telegram]\n[チャットID: ${chatId}]\n[発言者: ${displayName} (ID: ${userId})]\n${prompt}`;

  console.log(`[telegram] Processing message in chat ${chatId}`);

  let typingInterval: ReturnType<typeof setInterval> | undefined;
  const startTyping = () => {
    bot.sendChatAction(chatId, 'typing').catch(() => {});
    typingInterval = setInterval(() => {
      bot.sendChatAction(chatId, 'typing').catch(() => {});
    }, TYPING_INTERVAL_MS);
  };
  const stopTyping = () => {
    if (typingInterval) {
      clearInterval(typingInterval);
      typingInterval = undefined;
    }
  };

  try {
    const sessionId = sessions.get(channelId);
    const useStreaming = config.telegram.streaming ?? true;
    const showThinking = config.telegram.showThinking ?? true;

    const initialResponse = await bot.sendMessage(chatId, '🤔 考え中.', {
      reply_to_message_id: originalMessageId,
    });
    replyMessageId = initialResponse.message_id;
    lastBotMessages.set(channelId, { chatId, messageId: replyMessageId });

    startTyping();

    let result: string;
    let newSessionId: string;

    if (useStreaming && showThinking) {
      let firstTextReceived = false;
      let pendingUpdate = false;
      let lastUpdateTime = 0;
      let dotCount = 1;
      const thinkingInterval = setInterval(() => {
        if (firstTextReceived) return;
        dotCount = (dotCount % 3) + 1;
        editMessageText(bot, chatId, replyMessageId, `🤔 考え中${'.'.repeat(dotCount)}`).catch(
          () => {}
        );
      }, 1000);

      try {
        const streamResult = await agentRunner.runStream(
          prompt,
          {
            onText: (_chunk, fullText) => {
              if (!firstTextReceived) {
                firstTextReceived = true;
                clearInterval(thinkingInterval);
              }
              const now = Date.now();
              if (now - lastUpdateTime < STREAM_UPDATE_INTERVAL_MS || pendingUpdate) {
                return;
              }

              pendingUpdate = true;
              lastUpdateTime = now;
              const streamText = splitMessage(fullText + ' ▌')[0] || '▌';
              editMessageText(bot, chatId, replyMessageId, streamText)
                .catch((err) => {
                  console.error(
                    '[telegram] Failed to edit streaming message:',
                    err instanceof Error ? err.message : String(err)
                  );
                })
                .finally(() => {
                  pendingUpdate = false;
                });
            },
          },
          { skipPermissions, sessionId, channelId }
        );
        result = streamResult.result;
        newSessionId = streamResult.sessionId;
      } finally {
        clearInterval(thinkingInterval);
      }
    } else {
      let dotCount = 1;
      const thinkingInterval = setInterval(() => {
        dotCount = (dotCount % 3) + 1;
        editMessageText(bot, chatId, replyMessageId, `🤔 考え中${'.'.repeat(dotCount)}`).catch(
          () => {}
        );
      }, 1000);

      try {
        const runResult = await agentRunner.run(prompt, { skipPermissions, sessionId, channelId });
        result = runResult.result;
        newSessionId = runResult.sessionId;
      } finally {
        clearInterval(thinkingInterval);
      }
    }

    sessions.set(channelId, newSessionId);
    console.log(`[telegram] Final result length: ${result.length}`);

    const filePaths = extractFilePaths(result);
    let displayText = filePaths.length > 0 ? stripFilePaths(result) : result;
    displayText = displayText.replace(/^SYSTEM_COMMAND:.+$/gm, '').trim();
    handleSystemCommands(result);

    await sendResultText(bot, chatId, replyMessageId, displayText || '✅', originalMessageId);

    for (const filePath of filePaths) {
      await bot.sendDocument(chatId, filePath, {
        reply_to_message_id: originalMessageId,
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes('Request cancelled by user')) {
      console.log('[telegram] Request cancelled by user');
      if (replyMessageId) {
        await editMessageText(bot, chatId, replyMessageId, '🛑 停止しました').catch(() => {});
      }
      return;
    }

    console.error('[telegram] Error:', error);
    const text = `❌ エラーが発生しました: ${errorMessage.slice(0, 200)}`;
    if (replyMessageId) {
      await editMessageText(bot, chatId, replyMessageId, text).catch(() => {});
    } else {
      await bot.sendMessage(chatId, text, {
        reply_to_message_id: originalMessageId,
      });
    }
  } finally {
    stopTyping();
  }
}

export async function startTelegramBot(options: TelegramChannelOptions): Promise<void> {
  const { config, agentRunner } = options;

  if (!config.telegram.token) {
    throw new Error('Telegram token not configured');
  }

  const bot = new TelegramBot(config.telegram.token, {
    polling: {
      autoStart: true,
      interval: 300,
      params: { timeout: 10 },
    },
  });

  bot.on('polling_error', (err) => {
    console.error('[telegram] Polling error:', err.message);
  });

  bot.on('message', async (message) => {
    if (message.from?.is_bot) {
      return;
    }

    const userId = message.from?.id;
    if (!isAllowedUser(config, userId)) {
      console.log(`[telegram] Unauthorized user: ${userId ?? '(unknown)'}`);
      return;
    }

    const chatId = message.chat.id;
    const channelId = getChannelKey(chatId);
    const text = (message.text || message.caption || '').trim();

    if (isNewCommand(text)) {
      sessions.delete(channelId);
      agentRunner.destroy?.(channelId);
      await bot.sendMessage(chatId, '🆕 新しいセッションを開始しました', {
        reply_to_message_id: message.message_id,
      });
      return;
    }

    if (isStopCommand(text)) {
      const stopped = processManager.stop(channelId) || agentRunner.cancel?.(channelId) || false;
      await bot.sendMessage(
        chatId,
        stopped ? '🛑 タスクを停止しました' : '実行中のタスクはありません',
        {
          reply_to_message_id: message.message_id,
        }
      );
      return;
    }

    if (processingChats.has(channelId)) {
      await bot.sendMessage(chatId, '⏳ まだ前のリクエストを処理中です。完了後に送ってください。', {
        reply_to_message_id: message.message_id,
      });
      return;
    }

    const attachmentPaths: string[] = [];

    if (message.photo && message.photo.length > 0) {
      const photo = message.photo[message.photo.length - 1];
      try {
        const filePath = await downloadTelegramImage(
          bot,
          photo.file_id,
          `telegram_${photo.file_unique_id}.jpg`
        );
        attachmentPaths.push(filePath);
      } catch (err) {
        console.error('[telegram] Failed to download photo:', err);
      }
    }

    if (message.document?.mime_type?.startsWith('image/')) {
      try {
        const filePath = await downloadTelegramImage(
          bot,
          message.document.file_id,
          message.document.file_name || `telegram_${message.document.file_unique_id}`
        );
        attachmentPaths.push(filePath);
      } catch (err) {
        console.error('[telegram] Failed to download image document:', err);
      }
    }

    if (!text && attachmentPaths.length === 0) {
      return;
    }

    const prompt = buildPromptWithAttachments(
      text || '添付画像を確認してください',
      attachmentPaths
    );
    const displayName =
      [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ') ||
      message.from?.username ||
      'Telegram User';

    processingChats.add(channelId);
    try {
      await processMessage(bot, agentRunner, config, {
        chatId,
        channelId,
        userId: userId!,
        displayName,
        originalMessageId: message.message_id,
        prompt,
      });
    } finally {
      processingChats.delete(channelId);
    }
  });

  console.log('[telegram] 🤖 Telegram bot is running!');
}
