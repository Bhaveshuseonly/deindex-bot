const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder, REST, Routes } = require('discord.js');
const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = '1494232422743806042';
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
async function checkIndexed(url) {
  try {
    if (!url.startsWith('http')) url = 'https://' + url;
    const googleUrl = 'https://www.google.com/search?q=' + encodeURIComponent('site:' + url);
    const bingUrl = 'https://www.bing.com/search?q=' + encodeURIComponent('site:' + url);
    const res = await fetch('https://www.google.com/search?q=' + encodeURIComponent('site:' + url) + '&num=5', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
    });
    const html = await res.text();
    const noResults = html.includes('did not match any documents') || /About 0 results/i.test(html);
    const hasResults = html.includes('/url?q=') || html.includes('data-ved');
    const indexed = !noResults && hasResults;
    return { status: indexed ? 'INDEXED' : 'DEINDEXED', color: indexed ? 0x00CC66 : 0xFF4444, emoji: indexed ? '🟢' : '🔴', googleUrl, bingUrl, url };
  } catch(err) { return { status: 'ERROR', color: 0xFFAA00, emoji: '⚠️', error: err.message, url }; }
}
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder().setName('check').setDescription('Check if a URL is deindexed').addStringOption(o=>o.setName('url').setDescription('URL to check').setRequired(true)),
    new SlashCommandBuilder().setName('bulkcheck').setDescription('Check up to 5 URLs').addStringOption(o=>o.setName('urls').setDescription('URLs comma/space separated').setRequired(true)),
    new SlashCommandBuilder().setName('help').setDescription('How to use DeIndex Checker'),
  ].map(c=>c.toJSON());
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log('Slash commands registered!');
}
client.once('clientReady', async () => {
  console.log('DeIndex Checker online as ' + client.user.tag);
  client.user.setActivity('/check <url>', { type: 3 });
  await registerCommands();
});
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'help') {
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle('DeIndex Checker').setColor(0x5865F2).addFields({name:'/check <url>',value:'Check a URL'},{name:'/bulkcheck <urls>',value:'Check up to 5 URLs'},{name:'🟢 INDEXED',value:'Found in Google',inline:true},{name:'🔴 DEINDEXED',value:'Not in Google',inline:true})] });
  }
  if (interaction.commandName === 'check') {
    await interaction.deferReply();
    const r = await checkIndexed(interaction.options.getString('url'));
    const e = new EmbedBuilder().setTitle(r.emoji+' DeIndex Check').setColor(r.color).addFields({name:'URL',value:r.url.slice(0,100)},{name:'Status',value:'**'+r.status+'**',inline:true}).setTimestamp();
    if (!r.error) e.addFields({name:'Verify',value:'[Google]('+r.googleUrl+') | [Bing]('+r.bingUrl+')',inline:true});
    return interaction.editReply({ embeds: [e] });
  }
  if (interaction.commandName === 'bulkcheck') {
    await interaction.deferReply();
    const urls = interaction.options.getString('urls').split(/[\s,]+/).filter(Boolean).slice(0,5);
    const results = await Promise.all(urls.map(checkIndexed));
    const e = new EmbedBuilder().setTitle('Bulk Check — '+urls.length+' URLs').setColor(0x5865F2).setTimestamp();
    results.forEach(r=>e.addFields({name:r.emoji+' '+(r.url.length>50?r.url.slice(0,47)+'...':r.url),value:'**'+r.status+'** | [Google]('+r.googleUrl+') | [Bing]('+r.bingUrl+')'}));
    return interaction.editReply({ embeds: [e] });
  }
});
client.login(TOKEN);
