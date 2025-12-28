require('dotenv').config();
const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js');
const mysql = require('mysql2/promise');
// Cooldown tracking: userId -> timestamp of last +rep/-rep
const cooldowns = new Map();
const COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

let db;

/* ---------- DATABASE ---------- */
async function initDB() {
  db = await mysql.createPool({
    host: process.env.MYSQLHOST,
    user: process.env.MYSQLUSER,
    password: process.env.MYSQLPASSWORD,
    database: process.env.MYSQLDATABASE,
    port: process.env.MYSQLPORT
  });
}

/* ---------- NICKNAME UPDATE ---------- */
async function updateNickname(member) {
  const [rows] = await db.execute(
    `SELECT
      SUM(type='positive') AS pos,
      SUM(type='negative') AS neg
     FROM reputations WHERE target_id = ?`,
    [member.id]
  );

  const pos = rows[0].pos || 0;
  const neg = rows[0].neg || 0;

  const base = member.displayName.replace(/^\(\+\d+ \| -\d+\)\s*/, '');
  const nick = `(+${pos} | -${neg}) ${base}`.slice(0, 32);

  if (member.manageable && member.displayName !== nick) {
    await member.setNickname(nick);
  }

  // Trusted role
  if (pos - neg >= 15) {
    const role = member.guild.roles.cache.find(r => r.name === 'Trusted');
    if (role && !member.roles.cache.has(role.id)) {
      await member.roles.add(role);
    }
  }
}

/* ---------- READY ---------- */
client.once('ready', async () => {
  await initDB();
  console.log(`Logged in as ${client.user.tag}`);
});

/* ---------- MEMBER JOIN ---------- */
client.on('guildMemberAdd', async member => {
  if (member.manageable) {
    const nick = `(+0 | -0) ${member.user.username}`.slice(0, 32);
    await member.setNickname(nick);
  }
});

/* ---------- COMMANDS ---------- */
client.on('messageCreate', async message => {
  if (!message.guild || message.author.bot) return;

  const args = message.content.trim().split(/ +/);
  const cmd = args.shift()?.toLowerCase();

  /* +rep / -rep */
if (cmd === '+rep' || cmd === '-rep') {
  const target = message.mentions.members.first();
  if (!target) return message.reply('Mention a user.');
  if (target.id === message.author.id)
    return message.reply('You cannot rep yourself.');

  const reason = args.slice(1).join(' ') || null;

  // Admins are exempt from cooldown
  const isAdmin = message.member.permissions.has(PermissionsBitField.Flags.Administrator);

  if (!isAdmin) {
    const lastTime = cooldowns.get(message.author.id) || 0;
    const now = Date.now();
    if (now - lastTime < COOLDOWN_MS) {
      const remaining = Math.ceil((COOLDOWN_MS - (now - lastTime)) / 1000);
      return message.reply(`You are on cooldown. Wait ${remaining}s before reping again.`);
    }
    cooldowns.set(message.author.id, now);
  }

  // Check if user already reped this target
  const [existing] = await db.execute(
    `SELECT id FROM reputations WHERE target_id = ? AND giver_id = ?`,
    [target.id, message.author.id]
  );
  if (existing.length > 0 && !isAdmin) {
    return message.reply('You have already repped this user.');
  }

  await db.execute(
    `INSERT INTO reputations (target_id, giver_id, type, reason)
     VALUES (?, ?, ?, ?)`,
    [
      target.id,
      message.author.id,
      cmd === '+rep' ? 'positive' : 'negative',
      reason
    ]
  );

  await updateNickname(target);
  message.reply(`Reputation ${cmd === '+rep' ? 'added' : 'added'} for ${target.displayName}`);
}

  /* !profile */
  if (cmd === '!profile') {
    const target = message.mentions.members.first() || message.member;

    const [rows] = await db.execute(
      `SELECT id, giver_id, type, reason, created_at
       FROM reputations WHERE target_id = ?`,
      [target.id]
    );

    if (!rows.length) {
      return message.reply('No reputation records.');
    }

    let text = `**Reputation for ${target.user.tag}:**\n`;
    for (const r of rows) {
      text += `ID ${r.id} | ${r.type === 'positive' ? '+' : '-'} | <@${r.giver_id}> | ${r.reason || 'No reason'}\n`;
    }

    message.reply({ content: text.slice(0, 2000) });
  }

  /* -repid (admin only) */
  if (cmd === '-repid') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator))
      return message.reply('Invalid permissions.');

    const id = parseInt(args[1]);
    if (!id) return message.reply('Provide a rep ID.');

    const [[rep]] = await db.execute(
      `SELECT target_id FROM reputations WHERE id = ?`,
      [id]
    );

    if (!rep) return message.reply('Rep not found.');

    await db.execute(`DELETE FROM reputations WHERE id = ?`, [id]);

    const member = await message.guild.members.fetch(rep.target_id).catch(() => null);
    if (member) await updateNickname(member);

    message.reply(`Reputation ID ${id} removed.`);
  }

  /* -repres (admin only) */
  if (cmd === '-repres') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator))
      return message.reply('Invalid permissions.');

    const target = message.mentions.members.first();
    if (!target) return message.reply('Mention a user.');

    await db.execute(`DELETE FROM reputations WHERE target_id = ?`, [target.id]);
    await updateNickname(target);

    message.reply(`Reputation reset for ${target.displayName}`);
  }
});

client.login(process.env.BOT_TOKEN);