import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const commands = [
  new SlashCommandBuilder()
    .setName('killed')
    .setDescription('Record a boss kill (server time in UTC; optional HH:MM)')
    .addStringOption(o =>
      o.setName('boss').setDescription('Boss name').setRequired(true))
    .addStringOption(o =>
      o.setName('server_time_hhmm').setDescription('UTC HH:MM (optional)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show respawn window for a boss')
    .addStringOption(o =>
      o.setName('boss').setDescription('Boss name').setRequired(true)),

  new SlashCommandBuilder()
    .setName('details')
    .setDescription('Boss location & stats')
    .addStringOption(o =>
      o.setName('boss').setDescription('Boss name').setRequired(true)),

  new SlashCommandBuilder()
    .setName('drops')
    .setDescription('Boss drop list')
    .addStringOption(o =>
      o.setName('boss').setDescription('Boss name').setRequired(true)),

  new SlashCommandBuilder()
    .setName('reset')
    .setDescription('Reset boss timer to Unknown (admin)')
    .addStringOption(o =>
      o.setName('boss').setDescription('Boss name').setRequired(true)),

  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Configure alerts channel and roles (admin)')
    .addChannelOption(o =>
      o.setName('alert_channel').setDescription('Channel for spawn alerts').setRequired(false))
    .addRoleOption(o =>
      o.setName('admin_role').setDescription('Admin role for /reset and /setup').setRequired(false))
    .addRoleOption(o =>
      o.setName('standard_role').setDescription('Role required for standard commands').setRequired(false)),

  new SlashCommandBuilder()
    .setName('setcommandrole')
    .setDescription('Gate a specific command behind a role (admin)')
    .addStringOption(o =>
      o.setName('command').setDescription('Command name (killed/status/details/drops/subscribe)').setRequired(true)
        .addChoices(
          { name: 'killed', value: 'killed' },
          { name: 'status', value: 'status' },
          { name: 'details', value: 'details' },
          { name: 'drops', value: 'drops' },
          { name: 'subscribe', value: 'subscribe' }
        ))
    .addRoleOption(o =>
      o.setName('role').setDescription('Role required to use the command').setRequired(true)),

  new SlashCommandBuilder()
    .setName('setalert')
    .setDescription('Set how many minutes before window you want a DM alert')
    .addIntegerOption(o =>
      o.setName('minutes').setDescription('Minutes (1-1440)').setRequired(true)),

  // NEW: listbosses
  new SlashCommandBuilder()
    .setName('listbosses')
    .setDescription('List all known bosses'),

  // NEW: subscribe
  new SlashCommandBuilder()
    .setName('subscribe')
    .setDescription('Subscribe to alerts for a specific boss')
    .addStringOption(o =>
      o.setName('boss').setDescription('Boss name').setRequired(true))
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

async function main() {
  if (process.env.TEST_GUILD_ID) {
    await rest.put(
      Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.TEST_GUILD_ID),
      { body: commands }
    );
    console.log('Registered commands to TEST guild.');
  } else {
    await rest.put(
      Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
      { body: commands }
    );
    console.log('Registered GLOBAL commands.');
  }
}
main().catch(console.error);
