const {
  Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder,
  REST, Routes, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  AttachmentBuilder, PermissionFlagsBits, MessageFlags
} = require('discord.js');
const https = require('https');
const fs   = require('fs');

const TOKEN      = process.env.BOT_TOKEN;
const SERPER_KEY = process.env.SERPER_API_KEY;
const CLIENT_ID  = '1494232422743806042';

const MONITOR_FILE       = './monitor.json';
const CHECK_INTERVAL     = 12 * 60 * 60 * 1000; // 12 hours
const MAX_URLS_PER_GUILD = 20;

// Crash-safety: surface async errors instead of letting the process die silently.
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));
process.on('uncaughtException',  err => console.error('Uncaught exception:',  err));

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

// ── monitor storage ────────────────────────────────────────────────────────
function loadMonitorData() {
  try {
    if (fs.existsSync(MONITOR_FILE))
      return JSON.parse(fs.readFileSync(MONITOR_FILE, 'utf8'));
  } catch (e) { console.error('Monitor load error:', e.message); }
  return {};
}
function saveMonitorData(data) {
  try { fs.writeFileSync(MONITOR_FILE, JSON.stringify(data, null, 2)); }
  catch (e) { console.error('Monitor save error:', e.message); }
}
let monitorData = loadMonitorData();

// ── Serper.dev search ──────────────────────────────────────────────────────
// Rejects on HTTP/API failures so callers never mistake an API error for a
// "not indexed" result.
function serperSearch(query) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ q: query, gl: 'us', hl: 'en', num: 10 });
    const req  = https.request({
      hostname: 'google.serper.dev',
      path    : '/search',
      method  : 'POST',
      headers : {
        'X-API-KEY'     : SERPER_KEY,
        'Content-Type'  : 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      res.setEncoding('utf8');
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); }
        catch { return reject(new Error('Invalid JSON from Serper (HTTP ' + res.statusCode + ')')); }
        if (parsed && parsed.message && parsed.statusCode && parsed.statusCode >= 400) {
          return reject(new Error('Serper: ' + parsed.message));
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error('Serper HTTP ' + res.statusCode));
        }
        resolve(parsed);
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

// ── index check logic ──────────────────────────────────────────────────────
async function checkIndexed(url) {
  const domain      = getDomain(url);
  const siteSearchUrl = 'https://www.google.com/search?q=' + encodeURIComponent('site:' + url);

  try {
    const r1 = await serperSearch('site:' + url);
    if (r1.organic && r1.organic.length > 0)
      return { indexed: true, method: 'site:URL found', siteSearchUrl };

    // If URL has query params, also try without them (Google site: ignores query strings)
    let baseUrl = url;
    try { baseUrl = new URL(url).origin + new URL(url).pathname; } catch {}
    if (baseUrl !== url) {
      const r1b = await serperSearch('site:' + baseUrl);
      if (r1b.organic && r1b.organic.length > 0)
        return { indexed: true, method: 'site:path found', siteSearchUrl };
    }

    const r2 = await serperSearch('site:' + domain);
    if (!r2.organic || r2.organic.length === 0)
      return { indexed: false, method: 'Domain not indexed', siteSearchUrl };

    return { indexed: false, method: 'Page not indexed', siteSearchUrl };
  } catch (e) {
    return { indexed: null, error: e.message, siteSearchUrl };
  }
}

// ── embed / buttons ────────────────────────────────────────────────────────
function buildEmbed(url, result) {
  const { indexed, error } = result;
  const isErr = indexed === null;
  const color = isErr ? 0xFFAA00 : indexed ? 0x00CC66 : 0xFF4444;
  const desc  = isErr
    ? `⚠️ **Error**\n\`${url}\`\n${error}`
    : indexed
      ? `🟢 **Indexed**\n\`${url}\``
      : `🔴 **Deindexed**\n\`${url}\``;
  return new EmbedBuilder().setColor(color).setDescription(desc);
}

function buildButtons(result) {
  const row = new ActionRowBuilder();
  if (result.siteSearchUrl)
    row.addComponents(new ButtonBuilder().setLabel('Google site: search').setStyle(ButtonStyle.Link).setURL(result.siteSearchUrl));
  // Google Cache was retired in early 2024; no button for it.
  return row.components.length ? [row] : [];
}

// ── /check ─────────────────────────────────────────────────────────────────
async function handleCheck(interaction) {
  const url = normalizeUrl(interaction.options.getString('url'));
  await interaction.deferReply();
  const result = await checkIndexed(url);
  await interaction.editReply({ embeds: [buildEmbed(url, result)], components: buildButtons(result) });
}

// ── /bulkcheck ─────────────────────────────────────────────────────────────
async function handleBulkCheck(interaction) {
  const urls = interaction.options.getString('urls')
    .split(/[\n,\s]+/).map(u => u.trim()).filter(Boolean).slice(0, 10);

  if (!urls.length) return interaction.reply({ content: '❌ No valid URLs found.', flags: MessageFlags.Ephemeral });

  await interaction.deferReply();
  await interaction.editReply({
    embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('⏳ Checking...').setDescription('Checking **' + urls.length + '** URLs…').setTimestamp()]
  });

  let indexed = 0, deindexed = 0, errors = 0;
  const lines = [];

  for (let i = 0; i < urls.length; i++) {
    const url = normalizeUrl(urls[i]);
    const result = await checkIndexed(url);
    if      (result.indexed === null) { errors++;    lines.push('⚠️ ERROR     | ' + url + ' | ' + (result.error || 'unknown')); }
    else if (result.indexed)          { indexed++;   lines.push('🟢 INDEXED   | ' + url); }
    else                              { deindexed++; lines.push('🔴 DEINDEXED | ' + url); }
    if (i < urls.length - 1) await new Promise(r => setTimeout(r, 500));
  }

  const report = [
    '=== DeIndex Bulk Report ===',
    'Date: ' + new Date().toUTCString(),
    'Total: ' + urls.length,
    '',
    ...lines
  ];

  await interaction.editReply({
    embeds: [new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('📊 Bulk Complete')
      .setDescription('**Total:** ' + urls.length + ' URLs')
      .addFields(
        { name: '🟢 Indexed',   value: String(indexed),   inline: true },
        { name: '🔴 Deindexed', value: String(deindexed), inline: true },
        { name: '⚠️ Errors',    value: String(errors),    inline: true }
      ).setTimestamp().setFooter({ text: 'DeIndex Checker' })],
    files: [new AttachmentBuilder(Buffer.from(report.join('\n'), 'utf8'), { name: 'deindex-report.txt' })],
    components: []
  });
}

// ── /monitor ───────────────────────────────────────────────────────────────
async function handleMonitor(interaction) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'setchannel') {
    if (!monitorData[interaction.guildId]) monitorData[interaction.guildId] = { notifyChannelId: null, urls: {} };
    monitorData[interaction.guildId].notifyChannelId = interaction.channelId;
    saveMonitorData(monitorData);
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0x00CC66).setTitle('✅ Notification channel set')
        .setDescription('I\'ll send deindex alerts here.')],
      flags: MessageFlags.Ephemeral
    });
  }

  if (sub === 'add') {
    const url = normalizeUrl(interaction.options.getString('url'));
    if (!monitorData[interaction.guildId]) monitorData[interaction.guildId] = { notifyChannelId: null, urls: {} };

    const gData = monitorData[interaction.guildId];
    const urlCount = Object.keys(gData.urls).length;

    if (urlCount >= MAX_URLS_PER_GUILD)
      return interaction.reply({ content: `❌ Max ${MAX_URLS_PER_GUILD} URLs per server. Remove one first.`, flags: MessageFlags.Ephemeral });
    if (gData.urls[url])
      return interaction.reply({ content: '⚠️ That URL is already being monitored.', flags: MessageFlags.Ephemeral });

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Do an initial check to record baseline status
    const result = await checkIndexed(url);
    gData.urls[url] = {
      status     : result.indexed,   // may be null if API errored on add
      addedBy    : interaction.user.id,
      addedAt    : Date.now(),
      lastChecked: Date.now()
    };
    saveMonitorData(monitorData);

    // If already deindexed on add → send instant alert to notification channel
    if (result.indexed === false) {
      const alertChannel = await client.channels.fetch(gData.notifyChannelId).catch(() => null);
      if (alertChannel) {
        const alertEmbed = new EmbedBuilder()
          .setColor(0xFF4444)
          .setDescription(`🔴 **Deindexed**\n\`${url}\`\n[Check on Google](${result.siteSearchUrl})`);
        await alertChannel.send({ content: '@here', embeds: [alertEmbed] }).catch(console.error);
      }
    }

    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(0x00CC66).setDescription(`✅ Started monitoring\n\`${url}\``)]
    });
    return;
  }

  if (sub === 'addmany') {
    const raw  = interaction.options.getString('urls');
    const urls = raw.split(/[\n,\s]+/).map(u => u.trim()).filter(u => u.startsWith('http') || u.includes('.')).map(normalizeUrl);

    if (!urls.length)
      return interaction.reply({ content: '❌ No valid URLs found. Paste one URL per line.', flags: MessageFlags.Ephemeral });

    if (!monitorData[interaction.guildId]) monitorData[interaction.guildId] = { notifyChannelId: null, urls: {} };
    const gData2 = monitorData[interaction.guildId];

    const slotsLeft = MAX_URLS_PER_GUILD - Object.keys(gData2.urls).length;
    if (slotsLeft <= 0)
      return interaction.reply({ content: `❌ No slots left (max ${MAX_URLS_PER_GUILD}). Remove some URLs first.`, flags: MessageFlags.Ephemeral });

    const toAdd = urls.slice(0, slotsLeft);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const alertChannel2 = await client.channels.fetch(gData2.notifyChannelId).catch(() => null);
    const lines = [];
    for (const u of toAdd) {
      if (gData2.urls[u]) { lines.push('⚠️ Already monitored: `' + u + '`'); continue; }
      await new Promise(r => setTimeout(r, 800));

      const res = await checkIndexed(u);
      gData2.urls[u] = { status: res.indexed, addedBy: interaction.user.id, addedAt: Date.now(), lastChecked: Date.now() };
      const icon = res.indexed === null ? '⚠️' : res.indexed ? '🟢' : '🔴';
      lines.push(icon + ' `' + u + '`');

      // Instant alert if already deindexed on add
      if (res.indexed === false && alertChannel2) {
        const alertEmbed = new EmbedBuilder()
          .setColor(0xFF4444)
          .setDescription(`🔴 **Deindexed**\n\`${u}\`\n[Check on Google](${res.siteSearchUrl})`);
        await alertChannel2.send({ content: '@here', embeds: [alertEmbed] }).catch(console.error);
      }
    }
    saveMonitorData(monitorData);

    const added = lines.filter(l => !l.startsWith('⚠️')).length;
    const skipped = urls.length - toAdd.length;
    const skippedNote = skipped ? ` (${skipped} skipped — slot limit)` : '';
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(0x00CC66)
        .setDescription(`✅ Started monitoring ${added} URL(s)${skippedNote}`)]
    });
    return;
  }

  if (sub === 'remove') {
    const url = normalizeUrl(interaction.options.getString('url'));
    const gData = monitorData[interaction.guildId];
    if (!gData || !gData.urls[url])
      return interaction.reply({ content: '❌ That URL isn\'t being monitored.', flags: MessageFlags.Ephemeral });

    delete gData.urls[url];
    saveMonitorData(monitorData);
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0xFF4444).setTitle('🗑️ Removed')
        .setDescription('No longer monitoring `' + url + '`')],
      flags: MessageFlags.Ephemeral
    });
  }

  if (sub === 'removeall' || sub === 'clear') {
    const gData = monitorData[interaction.guildId];
    const count = gData ? Object.keys(gData.urls).length : 0;
    if (!count)
      return interaction.reply({ content: '📋 No URLs are being monitored.', flags: MessageFlags.Ephemeral });

    gData.urls = {};
    saveMonitorData(monitorData);
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0xFF4444).setDescription(`🗑️ Removed all ${count} URL(s) from monitoring`)],
      flags: MessageFlags.Ephemeral
    });
  }

  if (sub === 'testnotify') {
    const gData = monitorData[interaction.guildId];
    const channelId = gData?.notifyChannelId || interaction.channelId;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel)
      return interaction.reply({ content: '❌ Alert channel not found. Run `/monitor setchannel` first.', flags: MessageFlags.Ephemeral });

    const fakeUrl = 'https://example.com/your-monitored-page';
    const alertEmbed = new EmbedBuilder()
      .setColor(0xFF4444)
      .setDescription(`🔴 **Deindexed** *(test)*\n\`${fakeUrl}\`\n[Check on Google](https://www.google.com/search?q=site:${encodeURIComponent(fakeUrl)})`);

    await channel.send({ content: '@here', embeds: [alertEmbed] });
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0x00CC66).setTitle('✅ Test alert sent!')
        .setDescription(`Check <#${channelId}> to see the deindex notification.`)],
      flags: MessageFlags.Ephemeral
    });
  }

  if (sub === 'list') {
    const gData = monitorData[interaction.guildId];
    if (!gData || !Object.keys(gData.urls).length)
      return interaction.reply({ content: '📋 No URLs are being monitored yet. Use `/monitor add <url>`.', flags: MessageFlags.Ephemeral });

    const lines = Object.entries(gData.urls).map(([url, info]) => {
      const icon = info.status === null ? '⚠️' : info.status ? '🟢' : '🔴';
      const lastChecked = info.lastChecked
        ? `<t:${Math.floor(info.lastChecked / 1000)}:R>`
        : 'never';
      return `${icon} \`${url}\`\nLast checked: ${lastChecked}`;
    });

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('👁️ Monitored URLs')
      .setDescription(lines.join('\n\n'))
      .addFields({ name: '🔔 Alert channel', value: gData.notifyChannelId ? `<#${gData.notifyChannelId}>` : 'Not set' })
      .setFooter({ text: `${Object.keys(gData.urls).length}/${MAX_URLS_PER_GUILD} slots used • Checks every 12h` });

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }
}

// ── background monitor loop ────────────────────────────────────────────────
async function runMonitorCycle() {
  const guilds = Object.keys(monitorData);
  if (!guilds.length) return;

  console.log(`[Monitor] Running check cycle for ${guilds.length} guild(s)…`);

  for (const guildId of guilds) {
    const gData = monitorData[guildId];
    if (!gData.notifyChannelId || !Object.keys(gData.urls).length) continue;

    const channel = await client.channels.fetch(gData.notifyChannelId).catch(() => null);
    if (!channel) continue;

    for (const [url, info] of Object.entries(gData.urls)) {
      // stagger requests
      await new Promise(r => setTimeout(r, 1500));

      const result = await checkIndexed(url);

      const prevStatus = info.status;
      // Only overwrite status when we have a real result. On API error keep
      // last-known status so a Serper hiccup doesn't look like a deindex.
      if (result.indexed !== null) {
        info.status = result.indexed;
      }
      info.lastChecked = Date.now();

      // Alerts only fire on confirmed transitions (ignore null/error results).
      if (result.indexed !== null && prevStatus === true && result.indexed === false) {
        const alertEmbed = new EmbedBuilder()
          .setColor(0xFF4444)
          .setDescription(`🔴 **Deindexed**\n\`${url}\`\n[Check on Google](${result.siteSearchUrl})`);
        await channel.send({ content: '@here', embeds: [alertEmbed] }).catch(console.error);
      }
      if (result.indexed !== null && prevStatus === false && result.indexed === true) {
        const recoverEmbed = new EmbedBuilder()
          .setColor(0x00CC66)
          .setDescription(`🟢 **Re-indexed**\n\`${url}\``);
        await channel.send({ embeds: [recoverEmbed] }).catch(console.error);
      }
    }

    saveMonitorData(monitorData);
  }

  console.log('[Monitor] Cycle complete.');
}

// ── /help ──────────────────────────────────────────────────────────────────
async function handleHelp(interaction) {
  await interaction.reply({
    embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('📖 Help')
      .addFields(
        { name: '`/check <url>`',              value: 'Check if a single URL is indexed'                     },
        { name: '`/bulkcheck <urls>`',         value: 'Check up to 10 URLs + .txt report'                   },
        { name: '`/monitor add <url>`',          value: 'Add a single URL to 12h monitoring'                  },
        { name: '`/monitor addmany <urls>`',   value: 'Add multiple URLs at once — paste them all in'       },
        { name: '`/monitor remove <url>`',     value: 'Stop monitoring a URL'                               },
        { name: '`/monitor list`',             value: 'Show all monitored URLs and their status'            },
        { name: '`/monitor setchannel`',       value: 'Set current channel as alert destination'            },
        { name: '`/monitor testnotify`',       value: 'Send a test alert to see what deindex noti looks like' },
        { name: '`/monitor removeall` / `/monitor clear`', value: 'Remove all monitored URLs at once' }
      ).setTimestamp()],
    flags: MessageFlags.Ephemeral
  });
}

// ── register slash commands ────────────────────────────────────────────────
async function registerCommands() {
  const monitorCmd = new SlashCommandBuilder()
    .setName('monitor')
    .setDescription('Monitor URLs and get alerted when they get deindexed')
    .addSubcommand(sub => sub.setName('add').setDescription('Start monitoring a single URL')
      .addStringOption(o => o.setName('url').setDescription('URL to monitor').setRequired(true)))
    .addSubcommand(sub => sub.setName('addmany').setDescription('Add multiple URLs at once (paste one per line)')
      .addStringOption(o => o.setName('urls').setDescription('URLs separated by newlines, spaces, or commas').setRequired(true)))
    .addSubcommand(sub => sub.setName('remove').setDescription('Stop monitoring a URL')
      .addStringOption(o => o.setName('url').setDescription('URL to remove').setRequired(true)))
    .addSubcommand(sub => sub.setName('list').setDescription('List all monitored URLs'))
    .addSubcommand(sub => sub.setName('setchannel').setDescription('Set this channel as the alert destination'))
    .addSubcommand(sub => sub.setName('testnotify').setDescription('Send a test deindex alert to the notification channel'))
    .addSubcommand(sub => sub.setName('removeall').setDescription('Remove all monitored URLs at once'))
    .addSubcommand(sub => sub.setName('clear').setDescription('Clear all monitored URLs (same as removeall)'));

  const cmds = [
    new SlashCommandBuilder().setName('check').setDescription('Check if a URL is indexed by Google')
      .addStringOption(o => o.setName('url').setDescription('URL to check').setRequired(true)),
    new SlashCommandBuilder().setName('bulkcheck').setDescription('Check up to 10 URLs')
      .addStringOption(o => o.setName('urls').setDescription('URLs (newline/comma/space separated, max 10)').setRequired(true)),
    new SlashCommandBuilder().setName('help').setDescription('How to use DeIndex Checker'),
    monitorCmd,
  ].map(c => c.toJSON());

  await new REST({ version: '10' }).setToken(TOKEN).put(Routes.applicationCommands(CLIENT_ID), { body: cmds });
  console.log('Commands registered!');
}

// ── bot startup ────────────────────────────────────────────────────────────
client.once('clientReady', async () => {
  console.log('Online as ' + client.user.tag);
  client.user.setActivity('/check <url>', { type: 3 });
  await registerCommands();

  // Start monitor cycle immediately, then repeat every 12h
  setTimeout(async () => {
    await runMonitorCycle();
    setInterval(runMonitorCycle, CHECK_INTERVAL);
  }, 60 * 1000); // wait 1 min after startup before first cycle
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  try {
    if      (interaction.commandName === 'check')     await handleCheck(interaction);
    else if (interaction.commandName === 'bulkcheck') await handleBulkCheck(interaction);
    else if (interaction.commandName === 'monitor')   await handleMonitor(interaction);
    else if (interaction.commandName === 'help')      await handleHelp(interaction);
  } catch (err) {
    console.error('Interaction error:', err);
    const msg = { content: '❌ Unexpected error.', flags: MessageFlags.Ephemeral };
    if (interaction.deferred) await interaction.editReply(msg).catch(() => {});
    else                      await interaction.reply(msg).catch(() => {});
  }
});

client.login(TOKEN).catch(err => {
  console.error('Login failed:', err);
  process.exit(1);
});
