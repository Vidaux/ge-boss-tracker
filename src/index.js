// src/index.js
import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events
} from 'discord.js';

import {
  handleListBosses,
  handleSubscribeBoss,
  handleSubscribeAll,
  handleUnsubscribeBoss,
  handleUnsubscribeAll,
  handleSubscriptions,
  handleKilled,
  handleStatus,
  handleDetails,
  handleDrops,
  handleReset,
  handleSetup,
  handleSetCommandRole,
  handleSetAlert
} from './commands/handlers.js';

import { listBosses, listUserSubscriptions } from './db.js'; // include subs for autocomplete

const { DISCORD_TOKEN } = process.env;

if (!DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN in .env');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

// Ready
client.once(Events.ClientReady, (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
});

// Autocomplete for boss names
client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete()) {
    try {
      const focused = interaction.options.getFocused(true);
      if (focused?.name === 'boss') {
        const query = String(focused.value || '').toLowerCase();

        // If the command is /unsubscribe boss, only show bosses THIS user is subscribed to
        let sourceNames;
        if (interaction.commandName === 'unsubscribe') {
          // Avoid throwing if no subcommand (older clients)
          const sub = interaction.options.getSubcommand(false);
          if (!sub || sub === 'boss') {
            sourceNames = listUserSubscriptions(interaction.user.id, interaction.guildId);
          } else {
            sourceNames = listBosses();
          }
        } else {
          sourceNames = listBosses();
        }

        const names = sourceNames
          .filter(n => n.toLowerCase().includes(query))
          .slice(0, 25);
        return interaction.respond(names.map(n => ({ name: n, value: n })));
      }
    } catch (err) {
      console.warn('Autocomplete error:', err);
    }
    return;
  }
});

// Slash commands
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    switch (interaction.commandName) {
      case 'listbosses':
        await handleListBosses(interaction);
        break;

      case 'subscribe': {
        const sub = interaction.options.getSubcommand();
        if (sub === 'boss') await handleSubscribeBoss(interaction);
        else if (sub === 'all') await handleSubscribeAll(interaction);
        else await interaction.reply({ ephemeral: true, content: 'Unknown /subscribe subcommand.' });
        break;
      }

      case 'unsubscribe': {
        const sub = interaction.options.getSubcommand();
        if (sub === 'boss') await handleUnsubscribeBoss(interaction);
        else if (sub === 'all') await handleUnsubscribeAll(interaction);
        else await interaction.reply({ ephemeral: true, content: 'Unknown /unsubscribe subcommand.' });
        break;
      }

      case 'subscriptions':
        await handleSubscriptions(interaction);
        break;

      case 'killed':
        await handleKilled(interaction);
        break;

      case 'status':
        await handleStatus(interaction);
        break;

      case 'details':
        await handleDetails(interaction);
        break;

      case 'drops':
        await handleDrops(interaction);
        break;

      case 'reset':
        await handleReset(interaction);
        break;

      case 'setup':
        await handleSetup(interaction);
        break;

      case 'setcommandrole':
        await handleSetCommandRole(interaction);
        break;

      case 'setalert':
        await handleSetAlert(interaction);
        break;

      default:
        await interaction.reply({ ephemeral: true, content: 'Unknown command.' });
    }
  } catch (err) {
    console.error(`Error handling /${interaction.commandName}:`, err);
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ ephemeral: true, content: 'Something went wrong executing that command.' }).catch(() => {});
    } else {
      await interaction.reply({ ephemeral: true, content: 'Something went wrong executing that command.' }).catch(() => {});
    }
  }
});

process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err);
});

client.login(DISCORD_TOKEN);
