import 'dotenv/config';
import {
  Client, GatewayIntentBits, Partials,
  Events, EmbedBuilder
} from 'discord.js';
import {
  getAllBossRows, computeWindow, getGuildSettings,
  getUserRegistration, hasUserBeenAlerted, markUserAlerted,
  userHasAnySubscriptions, isUserSubscribedTo
} from './db.js';
import { DateTime } from 'luxon';
import { toUnixSeconds, fmtUtc } from './utils/time.js';
import {
  handleKilled, handleStatus, handleDetails, handleDrops,
  handleReset, handleSetup, handleSetCommandRole,
  handleSetAlert, handleListBosses, handleSubscribe
} from './commands/handlers.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
});

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
      case 'setalert': return handleSetAlert(interaction);
      case 'listbosses': return handleListBosses(interaction);
      case 'subscribe': return handleSubscribe(interaction);
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
// - Uses UTC internally.
// - Sends DM ~X minutes before window start, per-user.
// - If a user has any subscriptions, only alert for subscribed bosses; otherwise alert for all bosses.
setInterval(async () => {
  try {
    const bosses = getAllBossRows();
    const now = DateTime.utc();

    for (const b of bosses) {
      if (!b.last_killed_at_utc) continue;

      const window = computeWindow(b);
      if (!window) continue;

      const windowKey = b.window_notif_key;

      for (const [guildId, guild] of client.guilds.cache) {
        const members = await guild.members.fetch();

        for (const [, member] of members) {
          if (member.user.bot) continue;

          const reg = getUserRegistration(member.id, guildId);
          const minutesBefore = reg?.alert_minutes;
          if (!minutesBefore) continue;

          // Subscription filter
          const hasAny = userHasAnySubscriptions(member.id, guildId);
          if (hasAny && !isUserSubscribedTo(member.id, guildId, b.name)) {
            continue; // user has subs, but not this boss
          }

          const alertTime = window.start.minus({ minutes: minutesBefore });
          if (now >= alertTime && now <= window.end) {
            const already = hasUserBeenAlerted(member.id, guildId, b.name, windowKey);
            if (already) continue;

            const startUnix = toUnixSeconds(window.start);
            const endUnix = toUnixSeconds(window.end);

            const embed = new EmbedBuilder()
              .setTitle(`Spawn Window Incoming: ${b.name}`)
              .setDescription(`Heads up! Spawn window starts in ~${minutesBefore} minutes.`)
              .addFields(
                { name: 'Window Start — Server', value: fmtUtc(window.start), inline: true },
                { name: 'Window Start — Your',   value: `<t:${startUnix}:F>`, inline: true },
                { name: 'Relative to Start', value: `<t:${startUnix}:R>` },
                { name: 'Window End — Server', value: fmtUtc(window.end), inline: true },
                { name: 'Window End — Your',   value: `<t:${endUnix}:F>`, inline: true },
                { name: 'Relative to End', value: `<t:${endUnix}:R>` }
              )
              .setColor(0xFDCB6E);

            try {
              await member.send({ embeds: [embed] });
              markUserAlerted(member.id, guildId, b.name, windowKey);
            } catch {
              // DMs closed; ignore
            }
          }
        }
      }

      // Optional guild alert channel at window start
      for (const [guildId, guild] of client.guilds.cache) {
        const settings = getGuildSettings(guildId);
        if (!settings?.alert_channel_id) continue;
        if (now >= window.start && now < window.start.plus({ minutes: 1 })) {
          const ch = guild.channels.cache.get(settings.alert_channel_id);
          if (!ch?.isTextBased()) continue;
          const startUnix = toUnixSeconds(window.start);
          const endUnix = toUnixSeconds(window.end);
          const embed = new EmbedBuilder()
            .setTitle(`Spawn Window Started: ${b.name}`)
            .setDescription(
              `**Server (UTC):** ${fmtUtc(window.start)} → ${fmtUtc(window.end)}\n` +
              `**Local:** <t:${startUnix}:F> → <t:${endUnix}:F>\n` +
              `**Relative:** <t:${startUnix}:R> → <t:${endUnix}:R>`
            )
            .setColor(0xE1B12C);
          try { await ch.send({ embeds: [embed] }); } catch {}
        }
      }
    }
  } catch (err) {
    console.error('Alert loop error:', err);
  }
}, 60_000);

client.login(process.env.DISCORD_TOKEN);
