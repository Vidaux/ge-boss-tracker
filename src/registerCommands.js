// registerCommands.js
import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';

const {
  DISCORD_TOKEN,
  DISCORD_CLIENT_ID,
  TEST_GUILD_ID
} = process.env;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in .env');
  process.exit(1);
}

// Reusable boss option with autocomplete
const bossOption = (opt) =>
  opt.setName('boss')
     .setDescription('Boss name')
     .setRequired(true)
     .setAutocomplete(true);

const commands = [];

/** /status */
commands.push(
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show status for a boss (last death & respawn)')
    .addStringOption(bossOption)
    .setDMPermission(false)
);

/** /details */
commands.push(
  new SlashCommandBuilder()
    .setName('details')
    .setDescription('Show location, special conditions, and stats for a boss')
    .addStringOption(bossOption)
    .setDMPermission(false)
);

/** /drops */
commands.push(
  new SlashCommandBuilder()
    .setName('drops')
    .setDescription('Show possible drops for a boss')
    .addStringOption(bossOption)
    .setDMPermission(false)
);

/** /killed */
commands.push(
  new SlashCommandBuilder()
    .setName('killed')
    .setDescription('Record a boss kill (server time is UTC)')
    .addStringOption(bossOption)
    .addStringOption(o =>
      o.setName('server_time_hhmm')
       .setDescription('UTC time in HH:MM (24h), e.g., 21:22')
       .setRequired(false)
    )
    .setDMPermission(false)
);

/** /subscribe with subcommands */
commands.push(
  new SlashCommandBuilder()
    .setName('subscribe')
    .setDescription('Subscribe to DM alerts')
    .addSubcommand(sc =>
      sc.setName('boss')
        .setDescription('Subscribe to a single boss')
        .addStringOption(bossOption)
    )
    .addSubcommand(sc =>
      sc.setName('all')
        .setDescription('Subscribe to ALL bosses')
    )
    .setDMPermission(false)
);

/** /unsubscribe with subcommands */
commands.push(
  new SlashCommandBuilder()
    .setName('unsubscribe')
    .setDescription('Unsubscribe from DM alerts')
    .addSubcommand(sc =>
      sc.setName('boss')
        .setDescription('Unsubscribe from a single boss')
        .addStringOption(bossOption)
    )
    .addSubcommand(sc =>
      sc.setName('all')
        .setDescription('Unsubscribe from ALL bosses')
    )
    .setDMPermission(false)
);

/** /subscriptions */
commands.push(
  new SlashCommandBuilder()
    .setName('subscriptions')
    .setDescription('Show all bosses you are currently subscribed to')
    .setDMPermission(false)
);

/** /upcoming - dynamic hours */
commands.push(
  new SlashCommandBuilder()
    .setName('upcoming')
    .setDescription('Upcoming spawns: next 3, or all within N hours (whichever is more)')
    .addIntegerOption(o =>
      o.setName('hours')
       .setDescription('Lookahead window in hours (default 3)')
       .setMinValue(1)
       .setMaxValue(168)
       .setRequired(false)
    )
    .setDMPermission(false)
);

/** /listbosses */
commands.push(
  new SlashCommandBuilder()
    .setName('listbosses')
    .setDescription('List all known bosses')
    .setDMPermission(false)
);

/** /setup - wizard (no args) */
commands.push(
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Configuration wizard: alert channel, ping role, hours & lead minutes')
    .setDMPermission(false)
);

/** /setcommandrole */
const gateableCommands = [
  'status', 'details', 'drops', 'killed',
  'subscribe', 'unsubscribe', 'subscriptions',
  'upcoming', 'reset', 'setup'
];

commands.push(
  new SlashCommandBuilder()
    .setName('setcommandrole')
    .setDescription('Admin: gate a command behind a specific role')
    .addStringOption(o => {
      o.setName('command')
       .setDescription('Command to gate')
       .setRequired(true);
      gateableCommands.forEach(c => o.addChoices({ name: `/${c}`, value: c }));
      return o;
    })
    .addRoleOption(o =>
      o.setName('role')
       .setDescription('Role required to use the command')
       .setRequired(true)
    )
    .setDMPermission(false)
);

/** /setalert (only adjusts minutes, per user) */
commands.push(
  new SlashCommandBuilder()
    .setName('setalert')
    .setDescription('Set how many minutes before window start you want a DM')
    .addIntegerOption(o =>
      o.setName('minutes')
       .setDescription('1–1440 minutes (default is 30)')
       .setMinValue(1)
       .setMaxValue(1440)
       .setRequired(true)
    )
    .setDMPermission(false)
);

/** /reset */
commands.push(
  new SlashCommandBuilder()
    .setName('reset')
    .setDescription('Admin: clear the timer for a boss (sets status to Unknown)')
    .addStringOption(opt =>
      opt.setName('boss')
         .setDescription('Boss name')
         .setRequired(true)
         .setAutocomplete(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild) // hide from non-admins
    .setDMPermission(false)
);

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

async function register() {
  try {
    const body = commands.map(c => c.toJSON());
    if (TEST_GUILD_ID) {
      console.log('Registering GUILD commands to', TEST_GUILD_ID);
      await rest.put(
        Routes.applicationGuildCommands(DISCORD_CLIENT_ID, TEST_GUILD_ID),
        { body }
      );
      console.log('Guild commands registered.');
    } else {
      console.log('Registering GLOBAL commands...');
      await rest.put(
        Routes.applicationCommands(DISCORD_CLIENT_ID),
        { body }
      );
      console.log('Global commands registered.');
    }
  } catch (err) {
    console.error('Failed to register commands:', err);
    process.exit(1);
  }
}

register();
