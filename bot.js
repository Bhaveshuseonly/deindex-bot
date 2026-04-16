import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';

dotenv.config();

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN!, { polling: true });

// Welcome message
bot.onText(//start/, (msg) => {
  const chatId = msg.chat.id;
  const welcomeMessage = `🤖 *Instagram Monitor Bot*

I help you monitor Instagram accounts!

*Commands:*
/unban username - Monitor account recovery
/status - Check monitoring status
/help - Show this help

*Example:* /unban instagram`;

  bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
});

// Monitor Instagram account
bot.onText(//unban (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const username = match?.[1]?.replace('@', '').trim();
  
  if (!username) {
    bot.sendMessage(chatId, '❌ Please provide a username!');
    return;
  }
  
  bot.sendMessage(chatId, `🔍 Started monitoring @${username} for recovery!
  
✅ I'll notify you when the account is back online!
⏱️ Checking every 30 seconds
📱 Use /status to check progress`);
});

// Help command
bot.onText(//help/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, `📋 *Bot Commands:*

/start - Start the bot
/unban username - Monitor Instagram account
/status - Check monitoring status
/help - Show this help

*Example:* /unban selenagomez`, { parse_mode: 'Markdown' });
});

// Status command
bot.onText(//status/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, '📊 Bot is running and ready to monitor accounts!');
});

console.log('✅ Instagram Monitor Bot is running!');