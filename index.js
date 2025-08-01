require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const cloudinary = require('cloudinary').v2;
const stream = require('stream');
const { promisify } = require('util');
const express = require('express');
const finished = promisify(stream.finished);

// Validate environment variables
const requiredEnvVars = ['BOT_TOKEN', 'SHEET_WEBHOOK_URL', 'ADMIN_CHAT_ID', 'CLOUD_NAME', 'CLOUD_API_KEY', 'CLOUD_API_SECRET', 'WEBHOOK_URL'];
requiredEnvVars.forEach((varName) => {
  if (!process.env[varName]) {
    console.error(`Error: Environment variable ${varName} is not set. For WEBHOOK_URL, use your Vercel deployment URL (e.g., https://your-vercel-app.vercel.app).`);
    process.exit(1);
  }
});

// Config
const bot = new TelegramBot(process.env.BOT_TOKEN);
const SHEET_WEBHOOK_URL = process.env.SHEET_WEBHOOK_URL;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'secret123'; // Fallback secret

// Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.CLOUD_API_KEY,
  api_secret: process.env.CLOUD_API_SECRET
});

// Configure axios with retries and timeout
axiosRetry(axios, {
  retries: 3,
  retryDelay: (retryCount) => retryCount * 1000, // Exponential backoff: 1s, 2s, 3s
  retryCondition: (error) => error.code === 'ECONNABORTED' || error.message.includes('socket hang up')
});

// Express server setup
const app = express();
app.use(express.json()); // Parse JSON bodies for webhook

// Home route
app.get('/', (req, res) => {
  res.status(200).send('SubSplit Telegram Bot Server is running!');
});

// Webhook route with secret token
app.post(`/webhook/${WEBHOOK_SECRET}`, (req, res) => {
  try {
    bot.processUpdate(req.body); // Process incoming Telegram updates
    res.status(200).send('OK');
  } catch (err) {
    console.error('Error processing webhook update:', err.message);
    res.status(500).send('Error processing update');
  }
});

// Retry webhook setup with exponential backoff
const setWebhookWithRetry = async (retries = 3, delay = 1000) => {
  for (let i = 0; i < retries; i++) {
    try {
      await bot.setWebHook(`${WEBHOOK_URL}/webhook/${WEBHOOK_SECRET}`);
      console.log(`Webhook set to ${WEBHOOK_URL}/webhook/${WEBHOOK_SECRET}`);
      return;
    } catch (err) {
      console.error(`Error setting webhook (attempt ${i + 1}/${retries}):`, err.message);
      if (i < retries - 1) await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, i)));
    }
  }
  console.error('Failed to set webhook after retries.');
};

// Set webhook on startup
setWebhookWithRetry();

// Sessions
const userSessions = {};

// Plans
const plans = {
  '🎧 Spotify': { price: 50, duration: 30 },
  '🎬 Netflix': { price: 80, duration: 30 },
  '📦 Amazon Prime': { price: 60, duration: 30 },
  '📺 Hotstar': { price: 500, duration: 365 },
  '🎧 Spotify + 🎬 Netflix': { price: 120, duration: 30 },
  '📦 Prime + 📺 Hotstar': { price: 100, duration: 30 }
};

// Utility Functions
const getExpiryDate = (days) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toLocaleDateString('en-IN');
};

function escapeMarkdownV2(text) {
  const safeText = typeof text === 'string' ? text : '';
  return safeText.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

// Session cleanup (every hour)
setInterval(() => {
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  for (const chatId in userSessions) {
    if (!userSessions[chatId].lastActivity || now - userSessions[chatId].lastActivity > oneHour) {
      delete userSessions[chatId];
    }
  }
}, 60 * 60 * 1000);

// /start command
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const name = msg.from.first_name;
  userSessions[chatId] = { lastActivity: Date.now() };

  const message = `Hey ${name}! 👋\nWelcome to *SubSplit* — save money by sharing streaming subscriptions!\n\nHere are our affordable plans:\n
🎧 *Spotify* — ₹50 (30 days)\n
🎬 *Netflix* — ₹80 (30 days)\n
📦 *Amazon Prime* — ₹60 (30 days)\n
📺 *Hotstar* — ₹500 (1 year)\n
🎧 *Spotify + Netflix* — ₹120 (30 days)\n
📦 *Prime + Hotstar* — ₹100 (30 days)\n
You're saving over 70% compared to personal subscriptions! 🎉\n
Select a plan to continue:`;

  bot.sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    reply_markup: {
      keyboard: [
        ['🎧 Spotify', '🎬 Netflix'],
        ['📦 Amazon Prime', '📺 Hotstar'],
        ['🎧 Spotify + 🎬 Netflix'],
        ['📦 Prime + 📺 Hotstar']
      ],
      resize_keyboard: true,
      one_time_keyboard: true
    }
  });
});

// /help command
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  const message = `📚 *SubSplit Help*\n\nAvailable commands:\n
/start — View plans and start subscription process\n
/status — Check your active subscription status\n
/plans — List available plans\n
/contact — Get support contact information\n
/cancel — Cancel current subscription process\n
/help — Show this help message\n\n
For support, contact the admin at subsplithub@gmail.com.`;

  bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

// /status command
bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  const session = userSessions[chatId];

  if (!session || !session.expiryDate) {
    return bot.sendMessage(chatId, `ℹ️ No active subscription found. Start with /start.`);
  }

  return bot.sendMessage(chatId,
    `📦 *Current Plan:* ${session.platform}\n💰 *Price:* ₹${session.price}\n📅 *Valid Till:* ${session.expiryDate}`,
    { parse_mode: 'Markdown' }
  );
});

// /plans command
bot.onText(/\/plans/, (msg) => {
  const chatId = msg.chat.id;
  const message = `📋 *Available Plans*\n\n
🎧 *Spotify* — ₹50 (30 days)\n
🎬 *Netflix* — ₹80 (30 days)\n
📦 *Amazon Prime* — ₹60 (30 days)\n
📺 *Hotstar* — ₹500 (1 year)\n
🎧 *Spotify + Netflix* — ₹120 (30 days)\n
📦 *Prime + Hotstar* — ₹100 (30 days)\n
Use /start to subscribe!`;

  bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

// /contact command
bot.onText(/\/contact/, (msg) => {
  const chatId = msg.chat.id;
  const message = `📞 *Contact Support*\n\nFor any issues or questions, reach out to our admin at subsplithub@gmail.com.`;

  bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

// /cancel command
bot.onText(/\/cancel/, (msg) => {
  const chatId = msg.chat.id;
  if (userSessions[chatId]) {
    delete userSessions[chatId];
    bot.sendMessage(chatId, `🗑️ Subscription process canceled. Use /start to begin again.`, { parse_mode: 'Markdown' });
  } else {
    bot.sendMessage(chatId, `ℹ️ No active subscription process to cancel.`, { parse_mode: 'Markdown' });
  }
});

// /list_users command (admin-only)
bot.onText(/\/list_users/, async (msg) => {
  const chatId = msg.chat.id;
  if (chatId.toString() !== ADMIN_CHAT_ID) {
    return bot.sendMessage(chatId, '🚫 Unauthorized: Only admins can use this command.', { parse_mode: 'Markdown' });
  }
  const activeUsers = Object.entries(userSessions)
    .filter(([_, session]) => session.expiryDate)
    .map(([chatId, session]) => `Chat ID: ${chatId}, Plan: ${session.platform}, Expires: ${session.expiryDate}`)
    .join('\n');
  await bot.sendMessage(chatId, activeUsers || 'No active users.', { parse_mode: 'Markdown' });
});

// Handle messages
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const name = msg.from.first_name;
  const username = msg.from.username || 'N/A';

  // Initialize session if not exists
  if (!userSessions[chatId]) userSessions[chatId] = {};
  userSessions[chatId].lastActivity = Date.now();

  // Plan selected
  if (plans[text]) {
    userSessions[chatId].platform = text;
    userSessions[chatId].price = plans[text].price;
    userSessions[chatId].duration = plans[text].duration;

    await bot.sendMessage(chatId, `🎟️ You've selected *${text}*\nPlease pay *₹${plans[text].price}* to UPI: manicdon7@okhdfcbank\n\nAfter payment, *send a screenshot* of your UPI transaction.`, {
      parse_mode: 'Markdown'
    });
    return;
  }

  if (msg.photo) {
    const photo = msg.photo[msg.photo.length - 1];
    const fileId = photo.file_id;

    try {
      const file = await bot.getFile(fileId);
      const fileExtension = file.file_path.split('.').pop().toLowerCase();
      if (!['jpg', 'jpeg', 'png'].includes(fileExtension)) {
        await bot.sendMessage(chatId, '⚠️ Please upload a valid image (JPG or PNG).', { parse_mode: 'Markdown' });
        return;
      }

      const fileLink = await bot.getFileLink(fileId);
      const response = await axios({
        method: 'get',
        url: fileLink,
        responseType: 'stream',
        timeout: 30000
      });

      const cloudinaryUpload = cloudinary.uploader.upload_stream(
        { folder: 'SubSplitHub' },
        async (error, result) => {
          if (error) {
            console.error('Cloudinary upload error:', error.message);
            return bot.sendMessage(chatId, '❌ Failed to upload image. Try again.', { parse_mode: 'Markdown' });
          }

          userSessions[chatId].screenshotUrl = result.secure_url;
          await bot.sendMessage(chatId, '📝 Now, enter your *UPI name* or *transaction ID*:', { parse_mode: 'Markdown' });
        }
      );

      response.data.pipe(cloudinaryUpload);
      await finished(cloudinaryUpload);
    } catch (err) {
      console.error('Image download error:', err.message);
      await bot.sendMessage(chatId, '⚠️ Could not fetch your image. Try again later.', { parse_mode: 'Markdown' });
    }
    return;
  }

  // UPI Info
  if (userSessions[chatId]?.screenshotUrl && !userSessions[chatId]?.upiInfo && text) {
    const upiInfo = text.trim();

    // Validate UPI info
    if (!upiInfo) {
      await bot.sendMessage(chatId, '⚠️ Please provide a valid UPI name or transaction ID.', { parse_mode: 'Markdown' });
      return;
    }

    userSessions[chatId].upiInfo = upiInfo;

    const { platform, price, duration, screenshotUrl } = userSessions[chatId];
    const expiryDate = getExpiryDate(duration);
    userSessions[chatId].expiryDate = expiryDate;

    try {
      // Save to webhook
      await axios.post(SHEET_WEBHOOK_URL, {
        name,
        username,
        chatId,
        subscription: platform,
        upiInfo,
        screenshot: screenshotUrl,
        expiryDate
      }, { timeout: 30000 });

      await bot.sendMessage(chatId,
        `✅ *Thank you!* Your subscription has been recorded.\nWe'll verify and add you shortly.\nYour plan is valid until *${expiryDate}* 📅`,
        { parse_mode: 'Markdown' }
      );

      // Notify admin with properly escaped message
      const adminMessage =
        `📢 *New Payment Submitted\\!*\n\n` +
        `👤 Name: *${escapeMarkdownV2(name)}*\n` +
        `🔗 Username: @${escapeMarkdownV2(username)}\n` +
        `💳 Platform: *${escapeMarkdownV2(platform)}*\n` +
        `💰 Amount: ₹${escapeMarkdownV2(String(price))}\n` +
        `🧾 UPI Info: \`${escapeMarkdownV2(upiInfo)}\`\n` +
        `⏳ Valid Till: *${escapeMarkdownV2(expiryDate)}*`;

      await bot.sendPhoto(ADMIN_CHAT_ID, screenshotUrl, {
        caption: adminMessage,
        parse_mode: 'MarkdownV2'
      });

    } catch (err) {
      console.error('Webhook error:', err.message);
      await bot.sendMessage(chatId, '⚠️ Error saving your data. Please contact admin.', { parse_mode: 'Markdown' });
    }
  }
});

// Error handling for bot
bot.on('webhook_error', (error) => {
  console.error('Webhook error:', error.message);
});

// Export for Vercel
module.exports = app;