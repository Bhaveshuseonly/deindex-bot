const {
  Client, GatewayIntentBits, EmbedBuilder,
  SlashCommandBuilder, REST, Routes,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  AttachmentBuilder
} = require('discord.js');

const https = require('https');
const http = require('http');

const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = '1494232422743806042';
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0',
];
const randomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

function fetchUrl(urlStr) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: {
        'User-Agent': randomUA(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'identity',
        'Connection': 'close',
      },
    }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function normalizeUrl(raw) {
  raw = raw.trim();
  if (!/^https?:\/\//.test(raw)) raw = 'https://' + raw;
  return raw;
}

function getDomain(urlStr) {
  try { return new URL(urlStr).hostname.replace(/^www\./, ''); }
  catch { return urlStr; }
}

async function checkGoogle(url) {
  const domain = getDomain(url);
  const siteSearchUrl = 'https://www.google.com/search?q=' + encodeURIComponent('site:' + url);
  const cacheUrl = 'https://webcache.googleusercontent.com/search?q=cache:' + encodeURIComponent(url);
  let indexed = false, method = '', captchaHit = false;

  try {
    const exactUrl = 'https://www.google.com/search?q=' + encodeURIComponent('"' + url + '"') + '&num=5&hl=en&gl=us';
    const res = await fetchUrl(exactUrl);
    const html = res.body;
    captchaHit = html.includes('detected unusual traffic') || html.includes('g-recaptcha') || html.includes('/sorry/');
    if (!captchaHit) {
      const noResults = html.includes('did not match any documents') || html.includes('No results found') || /About 0 results/i.test(html);
      const hasHit = html.includes(domain) && (html.includes('data-ved') || html.includes('/url?q='));
      if (!noResults && hasHit) { indexed = true; method = 'Exact URL search'; }
    }
  } catch (_) {}

  if (!indexed && !captchaHit) {
    try {
      const domainUrl = 'https://www.google.com/search?q=' + encodeURIComponent('site:' + domain) + '&num=5&hl=en&gl=us';
      const res2 = await fetchUrl(domainUrl);
      const html2 = res2.body;
      captchaHit = html2.includes('detected unusual traffic') || html2.includes('g-recaptcha') || html2.includes('/sorry/');
      if (!captchaHit) {
        const domainNoResults = html2.includes('did not match any documents') || /About 0 results/i.test(html2);
        const domainHasResults = html2.includes('data-ved') || /About [\d,]+ results/i.test(html2) || html2.includes('/url?q=');
        if (domainNoResults || !domainHasResults) {
          indexed = false; method = 'Domain not in Google';
        } else {
          try {
            const cr = await fetchUrl(cacheUrl);
            if (cr.status === 200 && cr.body.length > 1000 && !cr.body.includes('did not match') && !cr.body.includes('Error 404')) {
              indexed = true; method = 'Google Cache confirmed';
            } else {
              const path = url.replace(/^https?:\/\/[^\/]+/, '');
              indexed = path.length > 3 && html2.includes(path.slice(0, 25));
              method = indexed ? 'Path in domain results' : 'Page not in Google index';
            }
          } catch (_) { indexed = false; method = 'Cache check failed'; }
        }
      }
    } catch (e2) {
      return { engine: 'Google', indexed: null, error: e2.message, searchUrl: siteSearchUrl, cacheUrl };
    }
  }

  if (captchaHit) {
    try {
      const cr = await fetchUrl(cacheUrl);
      if (cr.status === 200 && cr.body.length > 1000 && !cr.body.includes('did not match') && !cr.body.includes('Error 404')) {
        indexed = true; method = 'Cache (CAPTCHA fallback)';
      } else { indexed = false; method = 'CAPTCHA blocked'; }
    } catch (_) {
      return { engine: 'Google', indexed: null, error: 'CAPTCHA+cache failed', searchUrl: siteSearchUrl, cacheUrl };
    }
  }

  return { engine: 'Google', indexed, method, searchUrl: siteSearchUrl, cacheUrl };
}

async function checkBing(url) {
  const domain = getDomain(url);
  const buttonUrl = 'https://www.bing.com/search?q=' + encodeURIComponent('site:' + url) + '&count=5';
  let indexed = false;
  try {
    const r = await fetchUrl('https://www.bing.com/search?q=' + encodeURIComponent('"' + url + '"') + '&count=5');
    if (!r.body.includes('No results found') && !r.body.includes('b_no_results') && (r.body.includes('b_algo') || r.body.includes(domain))) {
      indexed = true;
    } else {
      const r2 = await fetchUrl('https://www.bing.com/search?q=' + encodeURIComponent('site:' + domain) + '&count=5');
      indexed = !r2.body.includes('No results found') && !r2.body.includes('b_no_results') && r2.body.includes('b_algo');
    }
  } catch (e) { return { engine: 'Bing', indexed: null, error: e.message, searchUrl: buttonUrl }; }
  return { engine: 'Bing', indexed, searchUrl: buttonUrl };
}

function buildEmbed(url, results) {
  const g = results.find(r => r.engine === 'Google');
  const b = results.find(r => r.engine === 'Bing');
  const ok = g?.indexed === true || b?.indexed === true;
  const err = results.every(r => r.indexed === null);
  const color = err ? 0xFFAA00 : ok ? 0x00CC66 : 0xFF4444;
  const icon = err ? '\u26a0\ufe0f' : ok ? '\U0001F7E2' : '\U0001F534';
  const label = err ? 'ERROR' : ok ? 'INDEXED' : 'DEINDEXED';
  const embed = new EmbedBuilder()
    .setColor(color).setTitle(icon + ' ' + label)
    .setDescription('**URL:** `' + url + '`')
    .setTimestamp()
    .setFooter({ text: 'DeIndex Checker \u2022 3-strategy detection' });
  if (g) embed.addFields({ name: '\U0001F50D Google', value: g.indexed === null ? '\u26a0\ufe0f ' + g.error : g.indexed ? '\u2705 Indexed\n*' + g.method + '*' : '\u274c Not found\n*' + (g.method || 'Not indexed') + '*', inline: true });
  if (b) embed.addFields({ name: '\U0001F50E Bing', value: b.indexed === null ? '\u26a0\ufe0f ' + b.error : b.indexed ? '\u2705 Indexed' : '\u274c Not found', inline: true });
  return embed;
}

function buildButtons(url, results) {
  const g = results.find(r => r.engine === 'Google');
  const b = results.find(r => r.engine === 'Bing');
  const row = new ActionRowBuilder();
  if (g?.searchUrl) row.addComponents(new ButtonBuilder().setLabel('Google site:').setStyle(ButtonStyle.Link).setURL(g.searchUrl).setEmoji('\U0001F50D'));
  if (g?.cacheUrl) row.addComponents(new ButtonBuilder().setLabel('Google Cache').setStyle(ButtonStyle.Link).setURL(g.cacheUrl).setEmoji('\U0001F4BE'));
  if (b?.searchUrl) row.addComponents(new ButtonBuilder().setLabel('Bing site:').setStyle(ButtonStyle.Link).setURL(b.searchUrl).setEmoji('\U0001F50E'));
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
  if (!urls.length) return interaction.reply({ content: '\u274c No valid URLs found.', ephemeral: true });
  await interaction.deferReply();
  await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('\u23f3 Checking...').setDescription('Checking **' + urls.length + '** URLs\nEngine: **' + engine.toUpperCase() + '**').setTimestamp()] });
  const allResults = [];
  for (const raw of urls) {
    const url = normalizeUrl(raw);
    const checks = [];
    if (engine === 'google' || engine === 'both') checks.push(checkGoogle(url));
    if (engine === 'bing' || engine === 'both') checks.push(checkBing(url));
    allResults.push({ url, results: await Promise.all(checks) });
    await new Promise(r => setTimeout(r, 1200));
  }
  let indexed = 0, deindexed = 0, errors = 0;
  const lines = [];
  for (const { url, results } of allResults) {
    const isOk = results.find(r => r.engine === 'Google')?.indexed === true || results.find(r => r.engine === 'Bing')?.indexed === true;
    const isErr = results.every(r => r.indexed === null);
    if (isErr) { errors++; lines.push('\u26a0\ufe0f ERROR | ' + url); }
    else if (isOk) { indexed++; lines.push('\U0001F7E2 INDEXED | ' + url); }
    else { deindexed++; lines.push('\U0001F534 DEINDEXED | ' + url); }
  }
  const rep = ['=== DeIndex Bulk Report ===', 'Date: ' + new Date().toUTCString(), 'Engine: ' + engine.toUpperCase(), 'Total: ' + urls.length, '', ...lines, '', '=== Detail ==='];
  for (const { url, results } of allResults) {
    rep.push('', 'URL: ' + url);
    for (const r of results) {
      rep.push('  ' + r.engine + ': ' + (r.indexed === null ? 'ERROR - ' + r.error : r.indexed ? 'INDEXED' + (r.method ? ' (' + r.method + ')' : '') : 'DEINDEXED' + (r.method ? ' (' + r.method + ')' : '')));
      if (r.searchUrl) rep.push('  Search: ' + r.searchUrl);
    }
  }
  await interaction.editReply({
    embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('\U0001F4CA Bulk Complete').setDescription('**Engine:** ' + engine.toUpperCase() + '\n**Total:** ' + urls.length + ' URLs').addFields({ name: '\U0001F7E2 Indexed', value: String(indexed), inline: true }, { name: '\U0001F534 Deindexed', value: String(deindexed), inline: true }, { name: '\u26a0\ufe0f Errors', value: String(errors), inline: true }).setTimestamp().setFooter({ text: 'DeIndex Checker' })],
    files: [new AttachmentBuilder(Buffer.from(rep.join('\n'), 'utf8'), { name: 'deindex-report.txt' })],
    components: []
  });
}

async function handleHelp(interaction) {
  await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('\U0001F4D6 Help').setDescription('3-strategy index detection.').addFields({ name: '`/check <url> [engine]`', value: 'Single URL. Engine: `google`|`bing`|`both`' }, { name: '`/bulkcheck <urls> [engine]`', value: 'Up to 10 URLs + .txt report.' }, { name: 'How it works', value: 'Exact URL search \u2192 site:domain \u2192 Google Cache' }).setTimestamp()], ephemeral: true });
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
    const msg = { content: '\u274c Unexpected error. Please try again.', ephemeral: true };
    if (interaction.deferred) await interaction.editReply(msg).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
  }
});

client.login(TOKEN);
