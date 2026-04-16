const {
    Client, GatewayIntentBits, EmbedBuilder,
    SlashCommandBuilder, REST, Routes,
    ActionRowBuilder, ButtonBuilder, ButtonStyle,
    AttachmentBuilder, InteractionType
} = require('discord.js');

const https = require('https');
const http = require('http');

const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = '1494232422743806042';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ─── User-Agent pool to rotate ────────────────────────────────────────────────
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
  ];
const randomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

// ─── HTTP fetch helper ─────────────────────────────────────────────────────────
function fetchUrl(url, options = {}) {
    return new Promise((resolve, reject) => {
          const parsed = new URL(url);
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
                            ...options.headers,
                  },
          }, (res) => {
                  let data = '';
                  res.on('data', chunk => { data += chunk; });
                  res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
          });
          req.on('error', reject);
          req.setTimeout(12000, () => { req.destroy(); reject(new Error('timeout')); });
    });
}

// ─── Normalise URL ─────────────────────────────────────────────────────────────
function normalizeUrl(raw) {
    raw = raw.trim();
    if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
    return raw;
}

// ─── Check Google index via site: search ──────────────────────────────────────
async function checkGoogle(url) {
    const siteQuery = encodeURIComponent('site:' + url);
    const searchUrl = `https://www.google.com/search?q=${siteQuery}&num=5&hl=en&gl=us`;
    const cacheUrl  = `https://webcache.googleusercontent.com/search?q=cache:${encodeURIComponent(url)}`;
    let indexed = false;
    let method = 'site: search';

  try {
        const res = await fetchUrl(searchUrl);
        const html = res.body;

      // Google returns "did not match" or "No results" when deindexed
      const noResults =
              html.includes('did not match any documents') ||
              html.includes('No results found for') ||
              /About 0 results/i.test(html) ||
              html.includes('geen resultaten') ||
              html.includes('no results');

      // Positive signals: result stats, data-ved on a result link
      const hasResults =
              html.includes('data-ved') ||
              /About [\d,]+ results/i.test(html) ||
              html.includes('id="search"') && html.includes('/url?q=');

      // CAPTCHA / blocked detection
      const captcha = html.includes('detected unusual traffic') || html.includes('g-recaptcha');

      if (captcha) {
              // Fall back to cache check
          const cacheRes = await fetchUrl(cacheUrl);
              if (cacheRes.status === 200 && !cacheRes.body.includes('404') && cacheRes.body.length > 500) {
                        indexed = true;
                        method = 'Google Cache';
              } else {
                        indexed = false;
                        method = 'Cache fallback (CAPTCHA hit)';
              }
      } else {
              indexed = !noResults && hasResults;
      }
  } catch (e) {
        return { engine: 'Google', indexed: null, error: e.message, searchUrl, cacheUrl };
  }

  return { engine: 'Google', indexed, method, searchUrl, cacheUrl };
}

// ─── Check Bing index via site: search ────────────────────────────────────────
async function checkBing(url) {
    const siteQuery = encodeURIComponent('site:' + url);
    const searchUrl = `https://www.bing.com/search?q=${siteQuery}&count=5`;
    let indexed = false;

  try {
        const res = await fetchUrl(searchUrl);
        const html = res.body;

      const noResults =
              html.includes('No results found for') ||
              html.includes('There are no results') ||
              html.includes('b_no_results') ||
              /0 results/i.test(html);

      const hasResults =
              html.includes('b_algo') ||
              html.includes('b_attribution') ||
              html.includes('/url?q=');

      indexed = !noResults && hasResults;
  } catch (e) {
        return { engine: 'Bing', indexed: null, error: e.message, searchUrl };
  }

  return { engine: 'Bing', indexed, searchUrl };
}

// ─── Build result embed for one URL ───────────────────────────────────────────
function buildEmbed(url, results) {
    const googleResult = results.find(r => r.engine === 'Google');
    const bingResult   = results.find(r => r.engine === 'Bing');

  // Determine overall status
  let overallIndexed = false;
    if (googleResult?.indexed === true || bingResult?.indexed === true) overallIndexed = true;
    const hasError = results.every(r => r.indexed === null);

  let color, statusEmoji, statusText;
    if (hasError)          { color = 0xFFAA00; statusEmoji = '⚠️'; statusText = 'ERROR'; }
    else if (overallIndexed) { color = 0x00CC66; statusEmoji = '🟢'; statusText = 'INDEXED'; }
    else                   { color = 0xFF4444; statusEmoji = '🔴'; statusText = 'DEINDEXED'; }

  const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(`${statusEmoji} ${statusText}`)
      .setDescription(`**URL:** \`${url}\``)
      .setTimestamp()
      .setFooter({ text: 'DeIndex Checker • Powered by site: search' });

  if (googleResult) {
        let val;
        if (googleResult.indexed === null) val = `⚠️ Error: ${googleResult.error}`;
        else if (googleResult.indexed)     val = `✅ Indexed (${googleResult.method || 'site: search'})`;
        else                               val = `❌ Not found in Google`;
        embed.addFields({ name: '🔍 Google', value: val, inline: true });
  }

  if (bingResult) {
        let val;
        if (bingResult.indexed === null) val = `⚠️ Error: ${bingResult.error}`;
        else if (bingResult.indexed)     val = `✅ Indexed`;
        else                             val = `❌ Not found in Bing`;
        embed.addFields({ name: '🔎 Bing', value: val, inline: true });
  }

  return embed;
}

// ─── Build action-link buttons ─────────────────────────────────────────────────
function buildButtons(url, results) {
    const googleResult = results.find(r => r.engine === 'Google');
    const bingResult   = results.find(r => r.engine === 'Bing');
    const row = new ActionRowBuilder();

  if (googleResult?.searchUrl) {
        row.addComponents(
                new ButtonBuilder()
                  .setLabel('Google site:')
                  .setStyle(ButtonStyle.Link)
                  .setURL(googleResult.searchUrl)
                  .setEmoji('🔍')
              );
  }
    if (googleResult?.cacheUrl) {
          row.addComponents(
                  new ButtonBuilder()
                    .setLabel('Google Cache')
                    .setStyle(ButtonStyle.Link)
                    .setURL(googleResult.cacheUrl)
                    .setEmoji('💾')
                );
    }
    if (bingResult?.searchUrl) {
          row.addComponents(
                  new ButtonBuilder()
                    .setLabel('Bing site:')
                    .setStyle(ButtonStyle.Link)
                    .setURL(bingResult.searchUrl)
                    .setEmoji('🔎')
                );
    }

  return row.components.length > 0 ? [row] : [];
}

// ─── /check handler ────────────────────────────────────────────────────────────
async function handleCheck(interaction) {
    const rawUrl = interaction.options.getString('url');
    const engine = interaction.options.getString('engine') || 'google';
    const url = normalizeUrl(rawUrl);

  await interaction.deferReply();

  const checks = [];
    if (engine === 'google' || engine === 'both') checks.push(checkGoogle(url));
    if (engine === 'bing'   || engine === 'both') checks.push(checkBing(url));

  const results = await Promise.all(checks);
    const embed = buildEmbed(url, results);
    const components = buildButtons(url, results);

  await interaction.editReply({ embeds: [embed], components });
}

// ─── /bulkcheck handler ────────────────────────────────────────────────────────
async function handleBulkCheck(interaction) {
    const rawUrls = interaction.options.getString('urls');
    const engine  = interaction.options.getString('engine') || 'google';

  const urls = rawUrls
      .split(/[\n,\s]+/)
      .map(u => u.trim())
      .filter(u => u.length > 0)
      .slice(0, 10);

  if (urls.length === 0) {
        return interaction.reply({ content: '❌ No valid URLs found. Please provide up to 10 URLs separated by commas, spaces, or newlines.', ephemeral: true });
  }

  await interaction.deferReply();

  const statusEmbed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('⏳ Bulk Check Running...')
      .setDescription(`Checking **${urls.length}** URL${urls.length > 1 ? 's' : ''}...\nEngine: **${engine.toUpperCase()}**`)
      .setTimestamp();

  await interaction.editReply({ embeds: [statusEmbed] });

  // Check all URLs (with a small delay to avoid rate limits)
  const allResults = [];
    for (const rawUrl of urls) {
          const url = normalizeUrl(rawUrl);
          const checks = [];
          if (engine === 'google' || engine === 'both') checks.push(checkGoogle(url));
          if (engine === 'bing'   || engine === 'both') checks.push(checkBing(url));
          const results = await Promise.all(checks);
          allResults.push({ url, results });
          await new Promise(r => setTimeout(r, 800)); // polite delay
    }

  // Build summary embed
  let indexed = 0, deindexed = 0, errors = 0;
    const lines = [];
    for (const { url, results } of allResults) {
          const googleR = results.find(r => r.engine === 'Google');
          const bingR   = results.find(r => r.engine === 'Bing');
          const isIndexed = googleR?.indexed === true || bingR?.indexed === true;
          const isError   = results.every(r => r.indexed === null);

      if (isError)        { errors++;    lines.push(`⚠️ ERROR      | ${url}`); }
          else if (isIndexed) { indexed++;   lines.push(`🟢 INDEXED    | ${url}`); }
          else                { deindexed++; lines.push(`🔴 DEINDEXED  | ${url}`); }
    }

  const summaryEmbed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('📊 Bulk Check Complete')
      .setDescription(`**Engine:** ${engine.toUpperCase()}\n**Total:** ${urls.length} URLs`)
      .addFields(
        { name: '🟢 Indexed',    value: String(indexed),   inline: true },
        { name: '🔴 Deindexed',  value: String(deindexed), inline: true },
        { name: '⚠️ Errors',     value: String(errors),    inline: true },
            )
      .setTimestamp()
      .setFooter({ text: 'DeIndex Checker • Download the .txt report below' });

  // Build downloadable .txt report
  const reportLines = [
        '=== DeIndex Checker — Bulk Report ===',
        `Date: ${new Date().toUTCString()}`,
        `Engine: ${engine.toUpperCase()}`,
        `Total URLs: ${urls.length}`,
        '',
        ...lines,
        '',
        '=== Detailed Results ===',
      ];
    for (const { url, results } of allResults) {
          reportLines.push('');
          reportLines.push(`URL: ${url}`);
          for (const r of results) {
                  if (r.indexed === null) reportLines.push(`  ${r.engine}: ERROR — ${r.error}`);
                  else if (r.indexed)     reportLines.push(`  ${r.engine}: INDEXED`);
                  else                    reportLines.push(`  ${r.engine}: DEINDEXED`);
                  if (r.searchUrl) reportLines.push(`  ${r.engine} search: ${r.searchUrl}`);
          }
    }

  const reportBuffer = Buffer.from(reportLines.join('\n'), 'utf8');
    const attachment = new AttachmentBuilder(reportBuffer, { name: 'deindex-report.txt' });

  await interaction.editReply({ embeds: [summaryEmbed], files: [attachment], components: [] });
}

// ─── /help handler ─────────────────────────────────────────────────────────────
async function handleHelp(interaction) {
    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('📖 DeIndex Checker — Help')
      .setDescription('Check whether URLs are indexed in Google and/or Bing.')
      .addFields(
        { name: '`/check <url> [engine]`',     value: 'Check a single URL.\nEngine: `google` (default) | `bing` | `both`' },
        { name: '`/bulkcheck <urls> [engine]`', value: 'Check up to **10** URLs at once.\nSeparate by commas, spaces, or newlines.\nDownloads a `.txt` report.' },
        { name: '`/help`',                     value: 'Show this help message.' },
        { name: '🟢 INDEXED',    value: 'URL appears in search engine results.' },
        { name: '🔴 DEINDEXED',  value: 'URL not found in search engine.' },
            )
      .setFooter({ text: 'DeIndex Checker' })
      .setTimestamp();

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// ─── Register slash commands ───────────────────────────────────────────────────
async function registerCommands() {
    const engineOption = o => o
      .setName('engine')
      .setDescription('Search engine to use')
      .addChoices(
        { name: 'Google (default)', value: 'google' },
        { name: 'Bing',             value: 'bing' },
        { name: 'Both',             value: 'both' },
            );

  const commands = [
        new SlashCommandBuilder()
          .setName('check')
          .setDescription('Check if a URL is indexed by search engines')
          .addStringOption(o => o.setName('url').setDescription('URL to check').setRequired(true))
          .addStringOption(engineOption),

        new SlashCommandBuilder()
          .setName('bulkcheck')
          .setDescription('Check up to 10 URLs (comma/space/newline separated)')
          .addStringOption(o => o.setName('urls').setDescription('URLs to check (up to 10)').setRequired(true))
          .addStringOption(engineOption),

        new SlashCommandBuilder()
          .setName('help')
          .setDescription('How to use DeIndex Checker'),
      ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(TOKEN);
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('Slash commands registered!');
}

// ─── Bot startup ───────────────────────────────────────────────────────────────
client.once('clientReady', async () => {
    console.log('DeIndex Checker online as ' + client.user.tag);
    client.user.setActivity('/check <url>', { type: 3 });
    await registerCommands();
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    try {
          if (interaction.commandName === 'check')     await handleCheck(interaction);
          else if (interaction.commandName === 'bulkcheck') await handleBulkCheck(interaction);
          else if (interaction.commandName === 'help')      await handleHelp(interaction);
    } catch (err) {
          console.error('Interaction error:', err);
          const msg = { content: '❌ An unexpected error occurred. Please try again.', ephemeral: true };
          if (interaction.deferred) await interaction.editReply(msg).catch(() => {});
          else await interaction.reply(msg).catch(() => {});
    }
});

client.login(TOKEN);
