const {
  Client, GatewayIntentBits, EmbedBuilder,
  SlashCommandBuilder, REST, Routes,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  AttachmentBuilder
} = require('discord.js');
const https = require('https');
const TOKEN = process.env.BOT_TOKEN;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_CSE_ID = process.env.GOOGLE_CSE_ID;
const CLIENT_ID = '1494232422743806042';
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
function normalizeUrl(raw) {
  raw = raw.trim();
  if (!/^https?:\/\//.test(raw)) raw = 'https://' + raw;
  return raw;
}
function getDomain(urlStr) {
  try { return new URL(urlStr).hostname.replace(/^www\./, ''); }
  catch { return urlStr; }
}
function apiRequest(query) {
  return new Promise((resolve, reject) => {
    const path = '/customsearch/v1?key=' + GOOGLE_API_KEY + '&cx=' + GOOGLE_CSE_ID + '&q=' + encodeURIComponent(query) + '&num=10&siteSearch=' + encodeURIComponent(getDomain(query.replace(/^site:/,'')));
    const req = https.get({ hostname: 'www.googleapis.com', path, headers: { 'Accept': 'application/json' } }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}
function apiRequestRaw(query) {
  return new Promise((resolve, reject) => {
    const path = '/customsearch/v1?key=' + GOOGLE_API_KEY + '&cx=' + GOOGLE_CSE_ID + '&q=' + encodeURIComponent(query) + '&num=10';
    const req = https.get({ hostname: 'www.googleapis.com', path, headers: { 'Accept': 'application/json' } }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}
async function checkGoogle(url) {
  const domain = getDomain(url);
  const siteSearchUrl = 'https://www.google.com/search?q=' + encodeURIComponent('site:' + url);
  const cacheUrl = 'https://webcache.googleusercontent.com/search?q=cache:' + encodeURIComponent(url);
  try {
    // Search 1: exact URL in quotes with siteSearch override
    const r1 = await apiRequestRaw('"'  + url + '"');
    if (r1.items && r1.items.length > 0) {
      return { engine: 'Google', indexed: true, method: 'Exact URL found', searchUrl: siteSearchUrl, cacheUrl };
    }
    // Search 2: site:url using siteSearch parameter
    const r2 = await apiRequestRaw('site:' + url);
    if (r2.items && r2.items.length > 0) {
      return { engine: 'Google', indexed: true, method: 'site:URL found', searchUrl: siteSearchUrl, cacheUrl };
    }
    // Search 3: site:domain to check if domain is even indexed
    const r3 = await apiRequestRaw('site:' + domain);
    if (!r3.items || r3.items.length === 0) {
      return { engine: 'Google', indexed: false, method: 'Domain not indexed', searchUrl: siteSearchUrl, cacheUrl };
    }
    // Domain is indexed but this URL not found
    return { engine: 'Google', indexed: false, method: 'Page not indexed', searchUrl: siteSearchUrl, cacheUrl };
  } catch (e) {
    return { engine: 'Google', indexed: null, error: e.message, searchUrl: siteSearchUrl, cacheUrl };
  }
}
function buildEmbed(url, results) {
  const g = results.find(r => r.engine === 'Google');
  const ok = g?.indexed === true;
  const err = g?.indexed === null;
  const color = err ? 0xFFAA00 : ok ? 0x00CC66 : 0xFF4444;
  const icon = err ? '⚠️' : ok ? '🟢' : '🔴';
  const label = err ? 'ERROR' : ok ? 'INDEXED' : 'DEINDEXED';
  const embed = new EmbedBuilder()
    .setColor(color).setTitle(icon + ' ' + label)
    .setDescription('**URL:** `' + url + '`')
    .setTimestamp()
    .setFooter({ text: 'DeIndex Checker • Google Custom Search API' });
  if (g) embed.addFields({ name: '🔍 Google', value: g.indexed === null ? '⚠️ ' + g.error : g.indexed ? '✅ Indexed\n*' + g.method + '*' : '❌ Not indexed\n*' + (g.method||'Not found') + '*', inline: true });
  return embed;
}
function buildButtons(url, results) {
  const g = results.find(r => r.engine === 'Google');
  const row = new ActionRowBuilder();
  if (g?.searchUrl) row.addComponents(new ButtonBuilder().setLabel('Google site:').setStyle(ButtonStyle.Link).setURL(g.searchUrl).setEmoji('🔍'));
  if (g?.cacheUrl) row.addComponents(new ButtonBuilder().setLabel('Google Cache').setStyle(ButtonStyle.Link).setURL(g.cacheUrl).setEmoji('💾'));
  return row.components.length ? [row] : [];
}
async function handleCheck(interaction) {
  const url = normalizeUrl(interaction.options.getString('url'));
  await interaction.deferReply();
  const results = [await checkGoogle(url)];
  await interaction.editReply({ embeds: [buildEmbed(url, results)], components: buildButtons(url, results) });
}
async function handleBulkCheck(interaction) {
  const urls = interaction.options.getString('urls').split(/[\n,\s]+/).map(u => u.trim()).filter(Boolean).slice(0, 10);
  if (!urls.length) return interaction.reply({ content: '❌ No valid URLs found.', ephemeral: true });
  await interaction.deferReply();
  await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('⏳ Checking...').setDescription('Checking **' + urls.length + '** URLs...').setTimestamp()] });
  const allResults = [];
  for (const raw of urls) {
    const url = normalizeUrl(raw);
    const result = await checkGoogle(url);
    allResults.push({ url, result });
    await new Promise(r => setTimeout(r, 500));
  }
  let indexed = 0, deindexed = 0, errors = 0;
  const lines = [];
  for (const { url, result } of allResults) {
    if (result.indexed === null) { errors++; lines.push('⚠️ ERROR | ' + url); }
    else if (result.indexed) { indexed++; lines.push('🟢 INDEXED | ' + url); }
    else { deindexed++; lines.push('🔴 DEINDEXED | ' + url); }
  }
  const rep = ['=== DeIndex Bulk Report ===', 'Date: ' + new Date().toUTCString(), 'Total: ' + urls.length, '', ...lines];
  await interaction.editReply({
    embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('📊 Bulk Complete').setDescription('**Total:** ' + urls.length + ' URLs').addFields({ name: '🟢 Indexed', value: String(indexed), inline: true }, { name: '🔴 Deindexed', value: String(deindexed), inline: true }, { name: '⚠️ Errors', value: String(errors), inline: true }).setTimestamp().setFooter({ text: 'DeIndex Checker' })],
    files: [new AttachmentBuilder(Buffer.from(rep.join('\n'), 'utf8'), { name: 'deindex-report.txt' })],
    components: []
  });
}
async function handleHelp(interaction) {
  await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('📖 Help').addFields({ name: '`/check <url>`', value: 'Check single URL' }, { name: '`/bulkcheck <urls>`', value: 'Up to 10 URLs + .txt report' }).setTimestamp()], ephemeral: true });
}
async function registerCommands() {
  const cmds = [
    new SlashCommandBuilder().setName('check').setDescription('Check if a URL is indexed').addStringOption(o => o.setName('url').setDescription('URL to check').setRequired(true)),
    new SlashCommandBuilder().setName('bulkcheck').setDescription('Check up to 10 URLs').addStringOption(o => o.setName('urls').setDescription('URLs (up to 10)').setRequired(true)),
    new SlashCommandBuilder().setName('help').setDescription('How to use DeIndex Checker'),
  ].map(c => c.toJSON());
  await new REST({ version: '10' }).setToken(TOKEN).put(Routes.applicationCommands(CLIENT_ID), { body: cmds });
  console.log('Commands registered!');
}
client.once('clientReady', async () => {
  console.log('Online as ' + client.user.tag);
  client.user.setActivity('/check <url>', { type: 3 });
  await registerCommands();
});
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  try {
    if (interaction.commandName === 'check') await handleCheck(interaction);
    else if (interaction.commandName === 'bulkcheck') await handleBulkCheck(interaction);
    else if (interaction.commandName === 'help') await handleHelp(interaction);
  } catch (err) {
    console.error('Interaction error:', err);
    const msg = { content: '❌ Unexpected error.', ephemeral: true };
    if (interaction.deferred) await interaction.editReply(msg).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
  }
});
client.login(TOKEN);
