/**
 * xangi専用コマンド — プラットフォーム別に組み立て
 */
import { XANGI_COMMANDS_COMMON } from './xangi-commands-common.js';
import { XANGI_COMMANDS_DISCORD } from './xangi-commands-discord.js';
import { XANGI_COMMANDS_SLACK } from './xangi-commands-slack.js';
import { XANGI_COMMANDS_TELEGRAM } from './xangi-commands-telegram.js';

export type ChatPlatform = 'discord' | 'slack' | 'telegram';

/**
 * プラットフォームに応じたXANGI_COMMANDSを構築
 * - discord: 共通 + Discord専用
 * - slack: 共通 + Slack専用
 * - undefined: 共通 + 全プラットフォーム
 */
export function buildXangiCommands(platform?: ChatPlatform): string {
  const parts = [XANGI_COMMANDS_COMMON];

  if (platform === 'discord') {
    parts.push(XANGI_COMMANDS_DISCORD);
  } else if (platform === 'slack') {
    parts.push(XANGI_COMMANDS_SLACK);
  } else if (platform === 'telegram') {
    parts.push(XANGI_COMMANDS_TELEGRAM);
  } else {
    // 両方またはundefined → 全部含める
    parts.push(XANGI_COMMANDS_DISCORD);
    parts.push(XANGI_COMMANDS_SLACK);
    parts.push(XANGI_COMMANDS_TELEGRAM);
  }

  return parts.join('\n\n');
}

// 後方互換: プラットフォーム未指定時は全部入り
export const XANGI_COMMANDS = buildXangiCommands();

export {
  XANGI_COMMANDS_COMMON,
  XANGI_COMMANDS_DISCORD,
  XANGI_COMMANDS_SLACK,
  XANGI_COMMANDS_TELEGRAM,
};
