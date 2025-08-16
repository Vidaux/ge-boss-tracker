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
  handleSubscribe,
  handleKilled,
  handleStatus,
  handleDetails,
  handleDrops,
  handleReset,
  handleSetup,
  handleSetCommandRole,
  handleSetAlert
} from './commands/handlers.js';

import { listBosses } from './db.js';

const { DISCORD_TOKEN } = process.env;

if (!DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN in .env');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,   // useful for future DM features
    GatewayIntentBits.DirectMessages  // allow receiving DM interactions (best practice)
  ],
  partials: [Partials.Channel]        // required for DMs
});

// Ready
client.once(Events.ClientReady, (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
});

// Autocomplete responder (boss list)
client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete()) {
    try {
      const focused = interaction.options.getFocused(true);
      if (focused?.name === 'boss') {
        const query = String(focused.value || '').toLowerCase();
        const names = listBosses()
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

// Slash command router
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    switch (interaction.commandName) {
      case 'listbosses':
        await handleListBosses(interaction);
        break;

      case 'subscribe':
        await handleSubscribe(interaction);
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
    // Try to respond gracefully; respect already-replied state
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ ephemeral: true, content: 'Something went wrong executing that command.' })
        .catch(() => {});
    } else {
      await interaction.reply({ ephemeral: true, content: 'Something went wrong executing that command.' })
        .catch(() => {});
    }
  }
});

process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err);
});

client.login(DISCORD_TOKEN);
