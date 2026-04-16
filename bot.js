const {
  Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder,
  REST, Routes, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder
} = require('discord.js');
const https = require('https');

const TOKEN        = process.env.BOT_TOKEN;
const SERPER_KEY   = process.env.SERPER_API_KEY;
const CLIENT_ID    = '1494232422743806042';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ── helpers ────────────────────────────────────────────────────────────────
function normalizeUrl(raw) {
  raw = raw.trim();
  if (!/^https?:\/\//.test(raw)) raw = 'https://' + raw;
  return raw;
}
function getDomain(urlStr) {
  try { return new URL(urlStr).hostname.replace(/^www\./, ''); }
  catch { return urlStr; }
}

// ── Serper.dev search ──────────────────────────────────────────────────────
function serperSearch(query) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ q: query, gl: 'us', hl: 'en', num: 10 });
    const req  = https.request({
      hostname : 'google.serper.dev',
      path     : '/search',
      method   : 'POST',
      headers  : {
        'X-API-KEY'    : SERPER_KEY,
        'Content-Type' : 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({}); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

// ── index check logic ──────────────────────────────────────────────────────
async function checkIndexed(url) {
  const domain      = getDomain(url);
  const siteSearchUrl = 'https://www.google.com/search?q=' + encodeURIComponent('site:' + url);
  const cacheUrl    = 'https://webcache.googleusercontent.com/search?q=cache:' + encodeURIComponent(url);

  try {
    // 1) site:exact-URL
    const r1 = await serperSearch('site:' + url);
    if (r1.organic && r1.organic.length > 0)
      return { indexed: true,  method: 'site:URL found',     siteSearchUrl, cacheUrl };

    // 2) site:domain – see if Google knows the domain at all
    const r2 = await serperSearch('site:' + domain);
    if (!r2.organic || r2.organic.length === 0)
      return { indexed: false, method: 'Domain not indexed', siteSearchUrl, cacheUrl };

    // Domain indexed but this page is not
    return { indexed: false, method: 'Page not indexed',   siteSearchUrl, cacheUrl };
  } catch (e) {
    return { indexed: null, error: e.message, siteSearchUrl, cacheUrl };
  }
}

// ── embed / buttons ────────────────────────────────────────────────────────
function buildEmbed(url, result) {
  const { indexed, method, error } = result;
  const isErr  = indexed === null;
  const color  = isErr ? 0xFFAA00 : indexed ? 0x00CC66 : 0xFF4444;
  const icon   = isErr ? '⚠️'    : indexed ? '🟢'     : '🔴';
  const label  = isErr ? 'ERROR' : indexed ? 'INDEXED' : 'DEINDEXED';

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`${icon} ${label}`)
    .setDescription('**URL:** `' + url + '`')
    .addFields({
      name  : '🔍 Google',
      value : isErr
        ? `⚠️ ${error}`
        : indexed
          ? `✅ Indexed\n*${method}*`
          : `❌ Not indexed\n*${method}*`,
      inline: true
    })
    .setTimestamp()
    .setFooter({ text: 'DeIndex Checker • Serper.dev' });
}

function buildButtons(result) {
  const row = new ActionRowBuilder();
  if (result.siteSearchUrl)
    row.addComponents(new ButtonBuilder().setLabel('Google site:').setStyle(ButtonStyle.Link).setURL(result.siteSearchUrl).setEmoji('🔍'));
  if (result.cacheUrl)
    row.addComponents(new ButtonBuilder().setLabel('Google Cache').setStyle(ButtonStyle.Link).setURL(result.cacheUrl).setEmoji('💾'));
  return row.components.length ? [row] : [];
}

// ── command handlers ───────────────────────────────────────────────────────
async function handleCheck(interaction) {
  const url = normalizeUrl(interaction.options.getString('url'));
  await interaction.deferReply();
  const result = await checkIndexed(url);
  await interaction.editReply({ embeds: [buildEmbed(url, result)], components: buildButtons(result) });
}

async function handleBulkCheck(interaction) {
  const urls = interaction.options.getString('urls')
    .split(/[\n,\s]+/).map(u => u.trim()).filter(Boolean).slice(0, 10);
  if (!urls.length) return interaction.reply({ content: '❌ No valid URLs found.', ephemeral: true });

  await interaction.deferReply();
  await interaction.editReply({
    embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('⏳ Checking...')
      .setDescription('Checking **' + urls.length + '** URLs…').setTimestamp()]
  });

  let indexed = 0, deindexed = 0, errors = 0;
  const lines = [];

  for (const raw of urls) {
    const url    = normalizeUrl(raw);
    const result = await checkIndexed(url);
    if (result.indexed === null) { errors++;    lines.push('⚠️ ERROR     | ' + url); }
    else if (result.indexed)    { indexed++;   lines.push('🟢 INDEXED   | ' + url); }
    else                        { deindexed++; lines.push('🔴 DEINDEXED | ' + url); }
    await new Promise(r => setTimeout(r, 500));
  }

  const report = [
    '=== DeIndex Bulk Report ===',
    'Date: ' + new Date().toUTCString(),
    'Total: ' + urls.length, '',
    ...lines
  ];

  await interaction.editReply({
    embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('📊 Bulk Complete')
      .setDescription('**Total:** ' + urls.length + ' URLs')
      .addFields(
        { name: '🟢 Indexed',   value: String(indexed),   inline: true },
        { name: '🔴 Deindexed', value: String(deindexed), inline: true },
        { name: '⚠️ Errors',   value: String(errors),    inline: true }
      ).setTimestamp().setFooter({ text: 'DeIndex Checker' })],
    files: [new AttachmentBuilder(Buffer.from(report.join('\n'), 'utf8'), { name: 'deindex-report.txt' })],
    components: []
  });
}

async function handleHelp(interaction) {
  await interaction.reply({
    embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('📖 Help')
      .addFields(
        { name: '`/check <url>`',    value: 'Check a single URL' },
        { name: '`/bulkcheck <urls>`', value: 'Check up to 10 URLs + .txt report' }
      ).setTimestamp()],
    ephemeral: true
  });
}

// ── register slash commands ────────────────────────────────────────────────
async function registerCommands() {
  const cmds = [
    new SlashCommandBuilder().setName('check').setDescription('Check if a URL is indexed by Google')
      .addStringOption(o => o.setName('url').setDescription('URL to check').setRequired(true)),
    new SlashCommandBuilder().setName('bulkcheck').setDescription('Check up to 10 URLs')
      .addStringOption(o => o.setName('urls').setDescription('URLs (newline/comma/space separated, max 10)').setRequired(true)),
    new SlashCommandBuilder().setName('help').setDescription('How to use DeIndex Checker'),
  ].map(c => c.toJSON());

  await new REST({ version: '10' }).setToken(TOKEN).put(Routes.applicationCommands(CLIENT_ID), { body: cmds });
  console.log('Commands registered!');
}

// ── bot startup ────────────────────────────────────────────────────────────
client.once('clientReady', async () => {
  console.log('Online as ' + client.user.tag);
  client.user.setActivity('/check <url>', { type: 3 });
  await registerCommands();
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  try {
    if      (interaction.commandName === 'check')     await handleCheck(interaction);
    else if (interaction.commandName === 'bulkcheck') await handleBulkCheck(interaction);
    else if (interaction.commandName === 'help')      await handleHelp(interaction);
  } catch (err) {
    console.error('Interaction error:', err);
    const msg = { content: '❌ Unexpected error.', ephemeral: true };
    if (interaction.deferred) await interaction.editReply(msg).catch(() => {});
    else                      await interaction.reply(msg).catch(() => {});
  }
});

client.login(TOKEN);
