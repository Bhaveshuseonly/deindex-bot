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

function googleApiRequest(query) {
  return new Promise((resolve, reject) => {
    const path = '/customsearch/v1?key=' + GOOGLE_API_KEY + '&cx=' + GOOGLE_CSE_ID + '&q=' + encodeURIComponent(query) + '&num=5';
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
    // Strategy 1: search exact URL in quotes
    const r1 = await googleApiRequest('"'  + url + '"');
    if (r1.items && r1.items.length > 0) {
      const found = r1.items.some(item => item.link && (item.link === url || item.link.startsWith(url)));
      if (found) return { engine: 'Google', indexed: true, method: 'Exact URL (API)', searchUrl: siteSearchUrl, cacheUrl };
    }

    // Strategy 2: site:domain search
    const r2 = await googleApiRequest('site:' + domain);
    if (!r2.items || r2.items.length === 0) {
      return { engine: 'Google', indexed: false, method: 'Domain not indexed', searchUrl: siteSearchUrl, cacheUrl };
    }

    // Strategy 3: site:url search
    const r3 = await googleApiRequest('site:' + url);
    if (r3.items && r3.items.length > 0) {
      return { engine: 'Google', indexed: true, method: 'site: URL (API)', searchUrl: siteSearchUrl, cacheUrl };
    }

    return { engine: 'Google', indexed: false, method: 'Page not in index', searchUrl: siteSearchUrl, cacheUrl };
  } catch (e) {
    return { engine: 'Google', indexed: null, error: e.message, searchUrl: siteSearchUrl, cacheUrl };
  }
}

async function checkBing(url) {
  const domain = getDomain(url);
  const buttonUrl = 'https://www.bing.com/search?q=' + encodeURIComponent('site:' + url);
  return new Promise((resolve) => {
    const req = https.get({
      hostname: 'api.bing.microsoft.com',
      path: '/v7.0/search?q=' + encodeURIComponent('site:' + url) + '&count=5',
      headers: { 'Ocp-Apim-Subscription-Key': process.env.BING_API_KEY || '' }
    }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          const indexed = !!(data.webPages && data.webPages.value && data.webPages.value.length > 0);
          resolve({ engine: 'Bing', indexed, searchUrl: buttonUrl });
        } catch { resolve({ engine: 'Bing', indexed: null, error: 'Parse error', searchUrl: buttonUrl }); }
      });
    });
    req.on('error', e => resolve({ engine: 'Bing', indexed: null, error: e.message, searchUrl: buttonUrl }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ engine: 'Bing', indexed: null, error: 'timeout', searchUrl: buttonUrl }); });
  });
}

function buildEmbed(url, results) {
  const g = results.find(r => r.engine === 'Google');
  const b = results.find(r => r.engine === 'Bing');
  const ok = g?.indexed === true || b?.indexed === true;
  const err = results.every(r => r.indexed === null);
  const color = err ? 0xFFAA00 : ok ? 0x00CC66 : 0xFF4444;
  const icon = err ? '⚠️' : ok ? '🟢' : '🔴';
  const label = err ? 'ERROR' : ok ? 'INDEXED' : 'DEINDEXED';
  const embed = new EmbedBuilder()
    .setColor(color).setTitle(icon + ' ' + label)
    .setDescription('**URL:** `' + url + '`')
    .setTimestamp()
    .setFooter({ text: 'DeIndex Checker • Google Custom Search API' });
  if (g) embed.addFields({ name: '🔍 Google', value: g.indexed === null ? '⚠️ ' + g.error : g.indexed ? '✅ Indexed\n*' + g.method + '*' : '❌ Not found\n*' + (g.method || 'Not indexed') + '*', inline: true });
  if (b) embed.addFields({ name: '🔎 Bing', value: b.indexed === null ? '⚠️ ' + b.error : b.indexed ? '✅ Indexed' : '❌ Not found', inline: true });
  return embed;
}

function buildButtons(url, results) {
  const g = results.find(r => r.engine === 'Google');
  const b = results.find(r => r.engine === 'Bing');
  const row = new ActionRowBuilder();
  if (g?.searchUrl) row.addComponents(new ButtonBuilder().setLabel('Google site:').setStyle(ButtonStyle.Link).setURL(g.searchUrl).setEmoji('🔍'));
  if (g?.cacheUrl) row.addComponents(new ButtonBuilder().setLabel('Google Cache').setStyle(ButtonStyle.Link).setURL(g.cacheUrl).setEmoji('💾'));
  if (b?.searchUrl) row.addComponents(new ButtonBuilder().setLabel('Bing site:').setStyle(ButtonStyle.Link).setURL(b.searchUrl).setEmoji('🔎'));
  return row.components.length ? [row] : [];
}

async function handleCheck(interaction) {
  const url = normalizeUrl(interaction.options.getString('url'));
  const engine = interaction.options.getString('engine') || 'google';
  await interaction.deferReply();
  const checks = [];
  if (engine === 'google' || engine === 'both') checks.push(checkGoogle(url));
  if (engine === 'bing' || engine === 'both') checks.push(checkBing(url));
  const results = await Promise.all(checks);
  await interaction.editReply({ embeds: [buildEmbed(url, results)], components: buildButtons(url, results) });
}

async function handleBulkCheck(interaction) {
  const engine = interaction.options.getString('engine') || 'google';
  const urls = interaction.options.getString('urls').split(/[\n,\s]+/).map(u => u.trim()).filter(Boolean).slice(0, 10);
  if (!urls.length) return interaction.reply({ content: '❌ No valid URLs found.', ephemeral: true });
  await interaction.deferReply();
  await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('⏳ Checking...').setDescription('Checking **' + urls.length + '** URLs\nEngine: **' + engine.toUpperCase() + '**').setTimestamp()] });
  const allResults = [];
  for (const raw of urls) {
    const url = normalizeUrl(raw);
    const checks = [];
    if (engine === 'google' || engine === 'both') checks.push(checkGoogle(url));
    if (engine === 'bing' || engine === 'both') checks.push(checkBing(url));
    allResults.push({ url, results: await Promise.all(checks) });
    await new Promise(r => setTimeout(r, 500));
  }
  let indexed = 0, deindexed = 0, errors = 0;
  const lines = [];
  for (const { url, results } of allResults) {
    const isOk = results.find(r => r.engine === 'Google')?.indexed === true || results.find(r => r.engine === 'Bing')?.indexed === true;
    const isErr = results.every(r => r.indexed === null);
    if (isErr) { errors++; lines.push('⚠️ ERROR | ' + url); }
    else if (isOk) { indexed++; lines.push('🟢 INDEXED | ' + url); }
    else { deindexed++; lines.push('🔴 DEINDEXED | ' + url); }
  }
  const rep = ['=== DeIndex Bulk Report ===', 'Date: ' + new Date().toUTCString(), 'Engine: ' + engine.toUpperCase(), 'Total: ' + urls.length, '', ...lines];
  await interaction.editReply({
    embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('📊 Bulk Complete').setDescription('**Engine:** ' + engine.toUpperCase() + '\n**Total:** ' + urls.length + ' URLs').addFields({ name: '🟢 Indexed', value: String(indexed), inline: true }, { name: '🔴 Deindexed', value: String(deindexed), inline: true }, { name: '⚠️ Errors', value: String(errors), inline: true }).setTimestamp().setFooter({ text: 'DeIndex Checker' })],
    files: [new AttachmentBuilder(Buffer.from(rep.join('\n'), 'utf8'), { name: 'deindex-report.txt' })],
    components: []
  });
}

async function handleHelp(interaction) {
  await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('📖 Help').setDescription('Accurate index checking via Google Custom Search API.').addFields({ name: '`/check <url> [engine]`', value: 'Single URL. Engine: `google`|`bing`|`both`' }, { name: '`/bulkcheck <urls> [engine]`', value: 'Up to 10 URLs + .txt report.' }).setTimestamp()], ephemeral: true });
}

async function registerCommands() {
  const eng = o => o.setName('engine').setDescription('Engine').addChoices({ name: 'Google (default)', value: 'google' }, { name: 'Bing', value: 'bing' }, { name: 'Both', value: 'both' });
  const cmds = [
    new SlashCommandBuilder().setName('check').setDescription('Check if a URL is indexed').addStringOption(o => o.setName('url').setDescription('URL to check').setRequired(true)).addStringOption(eng),
    new SlashCommandBuilder().setName('bulkcheck').setDescription('Check up to 10 URLs').addStringOption(o => o.setName('urls').setDescription('URLs (up to 10)').setRequired(true)).addStringOption(eng),
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
    const msg = { content: '❌ Unexpected error. Please try again.', ephemeral: true };
    if (interaction.deferred) await interaction.editReply(msg).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
  }
});

client.login(TOKEN);
