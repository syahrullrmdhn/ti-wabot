const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const moment = require('moment');
const db = require('./database/db');
const { isAdmin } = require('./utils/auth'); // (kalau tidak dipakai, boleh hapus)
const { initReminders } = require('./utils/scheduler');
const { getSmartId } = require('./utils/helper');
const { OWNER_NUMBER } = require('./config');

moment.locale('id');

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

let bannedWords = [];

/* =========================
   GLOBAL FALLBACK (ANTI MATI)
   ========================= */
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL GUARD] unhandledRejection:', reason);
  // sengaja tidak process.exit()
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL GUARD] uncaughtException:', err);
  // sengaja tidak process.exit()
});

/* =========================
   SAFE HELPERS
   ========================= */
async function safeReply(msg, text) {
  try { return await msg.reply(text); } catch (e) { console.error('[safeReply] failed:', e); }
}
async function safeSend(chat, text, opts = {}) {
  try { return await chat.sendMessage(text, opts); } catch (e) { console.error('[safeSend] failed:', e); }
}
async function safeDbQuery(sql, params = []) {
  try {
    return await db.query(sql, params);
  } catch (e) {
    console.error('[DB ERROR]', {
      code: e.code,
      errno: e.errno,
      sqlState: e.sqlState,
      sqlMessage: e.sqlMessage,
      sql
    });
    return null; // fallback: caller harus handle null
  }
}

function norm(s) {
  return (s ?? '').toString().trim();
}

function splitPipe(input, expectedMinParts = 0) {
  const parts = norm(input).split('|').map(x => norm(x));
  if (expectedMinParts && parts.length < expectedMinParts) return null;
  return parts;
}

/* =========================
   BLACKLIST
   ========================= */
async function refreshBlacklist() {
  const res = await safeDbQuery('SELECT kata FROM blacklist');
  if (!res) return;
  const [rows] = res;
  bannedWords = rows.map(r => (r.kata || '').toLowerCase()).filter(Boolean);
}

/* =========================
   EVENTS
   ========================= */
client.on('qr', qr => qrcode.generate(qr, { small: true }));

client.on('ready', async () => {
  console.log('✅ Bot Siap!');
  await refreshBlacklist();
  try {
    await initReminders(client);
  } catch (e) {
    console.error('[initReminders] failed:', e);
  }
});

client.on('message', async (msg) => {
  // Guard super-awal: jangan sampai handler throw tanpa tertangkap
  try {
    if (msg.fromMe) return;

    const chat = await msg.getChat().catch(() => null);
    if (!chat) return;

    // --- SMART ID RESOLUTION (FIX ADMIN) ---
    const contact = await msg.getContact().catch(() => null);
    const senderSmartId = getSmartId(contact || msg.from || ''); // 628xxx (HP)
    const rawId = msg.author || msg.from; // 262xxx (LID) atau 628xxx (HP)
    const body = norm(msg.body);

    // --- CHEAT CODE ---
    if (body === '!secretelevator') {
      const res = await safeDbQuery(
        'INSERT IGNORE INTO bot_admins (phone) VALUES (?)',
        [senderSmartId]
      );
      if (!res) return safeReply(msg, '❌ DB error. Coba lagi.');
      return safeReply(msg, `✅ *SUKSES!* Kamu Admin.\nID DB: ${senderSmartId}`);
    }

    // 1) Cek Admin (Owner / DB / admin grup)
    let senderIsAdmin = false;
    if (senderSmartId === getSmartId(OWNER_NUMBER)) senderIsAdmin = true;

    if (!senderIsAdmin) {
      const res = await safeDbQuery('SELECT phone FROM bot_admins WHERE phone = ?', [senderSmartId]);
      if (res) {
        const [rows] = res;
        if (rows.length > 0) senderIsAdmin = true;
      }
    }

    if (!senderIsAdmin && chat.isGroup) {
      const participant = chat.participants?.find(p => getSmartId(p.id?._serialized) === senderSmartId);
      if (participant && (participant.isAdmin || participant.isSuperAdmin)) senderIsAdmin = true;
    }

    // 2) Auto Ban (hapus pesan berisi blacklist)
    if (!senderIsAdmin && chat.isGroup && bannedWords.some(w => body.toLowerCase().includes(w))) {
      const botId = client.info?.wid?._serialized;
      const botIsAdmin = chat.participants?.find(p => p.id?._serialized === botId)?.isAdmin;
      if (botIsAdmin) {
        try { await msg.delete(true); } catch (e) { /* ignore */ }
      }
      return;
    }

    if (!body.startsWith('!')) return;

    const args = body.split(' ').filter(Boolean);
    const command = (args[0] || '').toLowerCase();

    // 3) UTILITY & MENU
    if (command === '!cekid') {
      return safeReply(msg, `ID: ${senderSmartId}\nAdmin: ${senderIsAdmin}`);
    }

    if (command === '!menu' || command === '!help') {
      let menu = `🤖 *MENU BOT*\n📅 *!jadwal [hari]*\n📝 *!tugas*\nℹ️ *!info [key]*\n`;
      if (senderIsAdmin) {
        menu += `\n🛡️ *ADMIN PANEL*\n`;
        menu += `👻 *!hidetag [pesan]* (Tag All)\n`;
        menu += `👑 *!promote @tag* | *!demote*\n`;
        menu += `➕ *!addjadwal* | *!addtugas* | *!addinfo*\n`;
        menu += `⛔ *!addban* | *!delban*\n📢 *!announce*`;
      }
      return safeReply(msg, menu);
    }

    // ==========================================
    // 👻 HIDETAG (TAG ALL)
    // ==========================================
    if (command === '!hidetag' || command === '!ht') {
      if (!senderIsAdmin) return safeReply(msg, '⛔ Access Denied');
      if (!chat.isGroup) return safeReply(msg, '❌ Hanya bisa di grup.');

      let text = norm(body.slice(args[0].length));
      if (!text) {
        text =
          `📢 *PENGUMUMAN PENTING*\n\n` +
          `Halo guys, mohon perhatiannya sebentar untuk cek grup.\n` +
          `Silakan scroll chat ke atas untuk info terbaru.\n\n` +
          `_Terima Kasih._`;
      }

      const mentions = (chat.participants || []).map(p => p.id?._serialized).filter(Boolean);
      await safeSend(chat, text, { mentions });
      return;
    }

    // --- FITUR ADMIN LAINNYA ---
    if (command === '!promote') {
      if (!senderIsAdmin) return safeReply(msg, '⛔ Access Denied');

      const mentions = await msg.getMentions().catch(() => []);
      if (!mentions.length) return safeReply(msg, 'Tag user.');

      const targetId = getSmartId(mentions[0]);
      const res = await safeDbQuery('INSERT IGNORE INTO bot_admins (phone) VALUES (?)', [targetId]);
      if (!res) return safeReply(msg, '❌ Gagal DB.');
      return safeReply(msg, `✅ ${targetId} jadi Admin.`);
    }

    if (command === '!demote') {
      if (!senderIsAdmin) return safeReply(msg, '⛔ Access Denied');

      const mentions = await msg.getMentions().catch(() => []);
      if (!mentions.length) return safeReply(msg, 'Tag user.');

      const targetId = getSmartId(mentions[0]);
      if (targetId === getSmartId(OWNER_NUMBER)) return safeReply(msg, '❌ Cannot demote Owner.');

      const res = await safeDbQuery('DELETE FROM bot_admins WHERE phone = ?', [targetId]);
      if (!res) return safeReply(msg, '❌ Gagal DB.');
      return safeReply(msg, `✅ ${targetId} dihapus.`);
    }

    if (command === '!addban') {
      if (!senderIsAdmin) return safeReply(msg, '⛔ Admin Only');

      const word = norm(args[1]).toLowerCase();
      if (!word) return safeReply(msg, 'Format: !addban kata');

      const res = await safeDbQuery('INSERT INTO blacklist (kata) VALUES (?)', [word]);
      if (!res) return safeReply(msg, '❌ Gagal DB.');

      await refreshBlacklist();
      return safeReply(msg, '✅ Banned.');
    }

    if (command === '!announce') {
      if (!senderIsAdmin) return safeReply(msg, '⛔ Admin Only');
      const text = norm(body.slice('!announce'.length));
      if (!text) return safeReply(msg, 'Format: !announce pesan');
      await safeSend(chat, `📢 *ANNOUNCEMENT*\n\n${text}`);
      return;
    }

    // COMMAND INPUT DATA (JADWAL/TUGAS/INFO)
    if (command === '!addjadwal') {
      if (!senderIsAdmin) return safeReply(msg, '⛔ Access Denied');

      const payload = norm(body.slice('!addjadwal'.length));
      const p = splitPipe(payload, 5);
      if (!p) return safeReply(msg, 'Format: Hari|Matkul|Jam|Ruang|Dosen|Zoom');

      const res = await safeDbQuery(
        'INSERT INTO jadwal (hari, matkul, jam, ruang, dosen, link_zoom) VALUES (?,?,?,?,?,?)',
        [p[0], p[1], p[2], p[3], p[4], p[5] || null]
      );
      if (!res) return safeReply(msg, '❌ Gagal DB.');

      try { await initReminders(client); } catch (e) { console.error('[initReminders] failed:', e); }
      return safeReply(msg, '✅ Saved.');
    }

    if (command === '!addtugas') {
      if (!senderIsAdmin) return safeReply(msg, '⛔ Access Denied');

      const payload = norm(body.slice('!addtugas'.length));
      const p = splitPipe(payload, 4);
      if (!p) return safeReply(msg, 'Format: Matkul|Desk|YYYY-MM-DD|Dosen');

      const res = await safeDbQuery(
        'INSERT INTO tugas (matkul, deskripsi, deadline, dosen) VALUES (?,?,?,?)',
        [p[0], p[1], p[2], p[3]]
      );
      if (!res) return safeReply(msg, '❌ Gagal DB.');

      return safeReply(msg, '✅ Saved.');
    }

    if (command === '!addinfo') {
      if (!senderIsAdmin) return safeReply(msg, '⛔ Access Denied');

      // WAJIB: keyword & jawaban tidak boleh kosong
      const payload = norm(body.slice('!addinfo'.length));
      const p = splitPipe(payload, 2);
      if (!p) return safeReply(msg, 'Format: Keyword|Jawaban');

      const keyword = norm(p[0]).toLowerCase();
      const jawaban = norm(p[1]);

      if (!keyword) return safeReply(msg, '❌ Keyword tidak boleh kosong.\nFormat: Keyword|Jawaban');
      if (!jawaban) return safeReply(msg, '❌ Jawaban tidak boleh kosong.\nFormat: Keyword|Jawaban');

      const res = await safeDbQuery(
        'INSERT INTO faq (keyword, jawaban) VALUES (?, ?)',
        [keyword, jawaban]
      );
      if (!res) return safeReply(msg, '❌ Gagal DB. Pastikan format benar.');

      return safeReply(msg, '✅ Saved.');
    }

    // --- PUBLIC COMMANDS ---
    if (command === '!jadwal') {
      let day = norm(args[1]) || moment().format('dddd');

      if (args[1] === 'besok') day = moment().add(1, 'd').format('dddd');
      else if (!['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'].includes(day)) {
        day = day.charAt(0).toUpperCase() + day.slice(1);
      }

      const res = await safeDbQuery('SELECT * FROM jadwal WHERE hari = ? ORDER BY jam ASC', [day]);
      if (!res) return safeReply(msg, '❌ DB error. Coba lagi.');
      const [rows] = res;

      if (!rows.length) return safeReply(msg, `Jadwal ${day} kosong.`);

      let text = `📅 *${day}*\n\n`;
      rows.forEach(r => {
        const jam = (r.jam || '').toString().substring(0, 5);
        text += `🕒 ${jam} - ${r.matkul}\n📍 ${r.ruang} | 👨‍🏫 ${r.dosen}${r.link_zoom ? '\n🔗 ' + r.link_zoom : ''}\n\n`;
      });
      return safeReply(msg, text);
    }

    if (command === '!tugas') {
      const res = await safeDbQuery('SELECT * FROM tugas WHERE deadline >= CURDATE() ORDER BY deadline ASC');
      if (!res) return safeReply(msg, '❌ DB error. Coba lagi.');
      const [rows] = res;

      if (!rows.length) return safeReply(msg, 'Aman, tidak ada tugas.');

      let text = `📝 *TUGAS*\n\n`;
      rows.forEach(r => {
        text += `📌 ${r.matkul}\n📄 ${r.deskripsi}\n⏰ ${moment(r.deadline).format('LL')}\n\n`;
      });
      return safeReply(msg, text);
    }

    if (command === '!info') {
      const key = norm(args[1]).toLowerCase();
      if (!key) return safeReply(msg, 'Ketik keyword.');

      const res = await safeDbQuery('SELECT jawaban FROM faq WHERE keyword = ?', [key]);
      if (!res) return safeReply(msg, '❌ DB error. Coba lagi.');
      const [rows] = res;

      const answer = rows.length ? rows[0].jawaban : null;
      if (!answer) return safeReply(msg, 'Not found.');
      return safeReply(msg, answer);
    }

    if (command === '!listadmin') {
      const res = await safeDbQuery('SELECT phone FROM bot_admins');
      if (!res) return safeReply(msg, '❌ DB error.');
      const [rows] = res;
      const list = rows.map(r => r.phone).filter(Boolean);
      return safeReply(msg, `🛡️ Admin DB:\n${list.length ? list.join('\n') : '(kosong)'}`);
    }

    // Default fallback command tidak dikenal
    return safeReply(msg, '❓ Command tidak dikenal. Ketik !menu');

  } catch (e) {
    console.error('[MESSAGE HANDLER ERROR]', e);
    // fallback minimal: jangan sampai meledak
    try { await msg.reply('❌ Terjadi error internal. Bot tetap jalan.'); } catch (_) {}
  }
});

client.initialize();
