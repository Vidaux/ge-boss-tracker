import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const commands = [
  // /killed boss [server_time_hhmm]
  new SlashCommandBuilder()
    .setName('killed')
    .setDescription('Record a boss kill (server time in UTC; optional HH:MM)')
    .addStringOption(o =>
      o.setName('boss').setDescription('Boss name').setRequired(true))
    .addStringOption(o =>
      o.setName('server_time_hhmm').setDescription('UTC HH:MM (optional)').setRequired(false)),

  // /status boss
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show respawn window for a boss')
    .addStringOption(o =>
      o.setName('boss').setDescription('Boss name').setRequired(true)),

  // /details boss
  new SlashCommandBuilder()
    .setName('details')
    .setDescription('Boss location & stats')
    .addStringOption(o =>
      o.setName('boss').setDescription('Boss name').setRequired(true)),

  // /drops boss
  new SlashCommandBuilder()
    .setName('drops')
    .setDescription('Boss drop list')
    .addStringOption(o =>
      o.setName('boss').setDescription('Boss name').setRequired(true)),

  // /reset boss (admin only via role)
  new SlashCommandBuilder()
    .setName('reset')
    .setDescription('Reset boss timer to Unknown (admin)')
    .addStringOption(o =>
      o.setName('boss').setDescription('Boss name').setRequired(true)),

  // /setup alert_channel admin_role standard_role
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Configure alerts channel and roles (admin)')
    .addChannelOption(o =>
      o.setName('alert_channel').setDescription('Channel for spawn alerts').setRequired(false))
    .addRoleOption(o =>
      o.setName('admin_role').setDescription('Admin role for /reset and /setup').setRequired(false))
    .addRoleOption(o =>
      o.setName('standard_role').setDescription('Role required for standard commands').setRequired(false)),

  // /setcommandrole command role (admin)
  new SlashCommandBuilder()
    .setName('setcommandrole')
    .setDescription('Gate a specific command behind a role (admin)')
    .addStringOption(o =>
      o.setName('command').setDescription('Command name (killed/status/details/drops)').setRequired(true)
        .addChoices(
          { name: 'killed', value: 'killed' },
          { name: 'status', value: 'status' },
          { name: 'details', value: 'details' },
          { name: 'drops', value: 'drops' }
        ))
    .addRoleOption(o =>
      o.setName('role').setDescription('Role required to use the command').setRequired(true)),

  // /register timezone
  new SlashCommandBuilder()
    .setName('register')
    .setDescription('Enroll in DM notifications with your timezone')
    .addStringOption(o =>
      o.setName('timezone').setDescription('Your timezone (IANA, e.g., America/New_York)').setRequired(true)),

  // /setalert minutes
  new SlashCommandBuilder()
    .setName('setalert')
    .setDescription('Set how many minutes before window you want a DM alert (per user)')
    .addIntegerOption(o =>
      o.setName('minutes').setDescription('Minutes (1-1440)').setRequired(true))
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