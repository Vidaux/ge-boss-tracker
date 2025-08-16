import 'dotenv/config';
import {
  Client, GatewayIntentBits, Partials,
  Events, EmbedBuilder
} from 'discord.js';
import {
  getAllBossRows, computeWindow, getGuildSettings,
  getUserRegistration, hasUserBeenAlerted, markUserAlerted
} from './db.js';
import {
  handleKilled, handleStatus, handleDetails, handleDrops,
  handleReset, handleSetup, handleSetCommandRole,
  handleRegister, handleSetAlert
} from './commands/handlers.js';
import { DateTime } from 'luxon';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
});

// Command router
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    switch (interaction.commandName) {
      case 'killed': return handleKilled(interaction);
      case 'status': return handleStatus(interaction);
      case 'details': return handleDetails(interaction);
      case 'drops':  return handleDrops(interaction);
      case 'reset':  return handleReset(interaction);
      case 'setup':  return handleSetup(interaction);
      case 'setcommandrole': return handleSetCommandRole(interaction);
      case 'register': return handleRegister(interaction);
      case 'setalert': return handleSetAlert(interaction);
      default:
        return interaction.reply({ ephemeral: true, content: 'Unknown command.' });
    }
  } catch (err) {
    console.error(err);
    if (interaction.deferred || interaction.replied) {
      return interaction.followUp({ ephemeral: true, content: 'Error handling the command.' });
    }
    return interaction.reply({ ephemeral: true, content: 'Error handling the command.' });
  }
});

// === Alert loop ===
// Every minute, for each boss with a known kill time,
// notify registered users in that guild when now >= window_start - user.alert_minutes
setInterval(async () => {
  try {
    const bosses = getAllBossRows();
    const now = DateTime.utc();

    for (const b of bosses) {
      if (!b.last_killed_at_utc) continue;

      const window = computeWindow(b);
      if (!window) continue;

      const windowKey = b.window_notif_key; // boss+lastKill token
      const guilds = client.guilds.cache;

      for (const [guildId, guild] of guilds) {
        // We’ll DM registered users in this guild
        // Note: we don’t need channel access to DM.
        const members = await guild.members.fetch();
        for (const [, member] of members) {
          if (member.user.bot) continue;
          const reg = getUserRegistration(member.id, guildId);
          if (!reg) continue;

          const minutesBefore = reg.alert_minutes ?? 15;
          const alertTime = window.start.minus({ minutes: minutesBefore });

          if (now >= alertTime && now <= window.end) {
            const already = hasUserBeenAlerted(member.id, guildId, b.name, windowKey);
            if (already) continue;

            const userTz = reg.timezone || 'UTC';

            const startServer = window.start.setZone('utc').toFormat("yyyy-LL-dd HH:mm 'UTC'");
            const startLocal = window.start.setZone(userTz).toFormat("yyyy-LL-dd HH:mm ZZZZ");
            const endServer = window.end.setZone('utc').toFormat("yyyy-LL-dd HH:mm 'UTC'");
            const endLocal = window.end.setZone(userTz).toFormat("yyyy-LL-dd HH:mm ZZZZ");

            const embed = new EmbedBuilder()
              .setTitle(`Spawn Window Incoming: ${b.name}`)
              .setDescription(`Heads up! Spawn window starts in ~${minutesBefore} minutes.`)
              .addFields(
                { name: 'Window Start — Server', value: startServer, inline: true },
                { name: 'Window Start — Your', value: startLocal, inline: true },
                { name: 'Window End — Server', value: endServer, inline: true },
                { name: 'Window End — Your', value: endLocal, inline: true }
              )
              .setColor(0xFDCB6E);

            try {
              await member.send({ embeds: [embed] });
              markUserAlerted(member.id, guildId, b.name, windowKey);
            } catch (e) {
              // DMs could be closed; ignore
            }
          }
        }
      }

      // Also: optional guild alert channel notification exactly at window start
      for (const [guildId, guild] of client.guilds.cache) {
        const settings = getGuildSettings(guildId);
        if (!settings?.alert_channel_id) continue;
        // If "now" matches the window start (within this minute), push a channel alert
        if (now >= window.start && now < window.start.plus({ minutes: 1 })) {
          const ch = guild.channels.cache.get(settings.alert_channel_id);
          if (!ch?.isTextBased()) continue;
          const msg =
            `**${b.name}** spawn window has started!\n` +
            `Server (UTC): ${window.start.toFormat("yyyy-LL-dd HH:mm 'UTC'")} → ${window.end.toFormat("yyyy-LL-dd HH:mm 'UTC'")}`;
          try { await ch.send(msg); } catch {}
        }
      }
    }
  } catch (err) {
    console.error('Alert loop error:', err);
  }
}, 60_000);

client.login(process.env.DISCORD_TOKEN);