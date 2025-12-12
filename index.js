const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const moment = require('moment');
const db = require('./database/db');
const { isAdmin } = require('./utils/auth');
const { initReminders } = require('./utils/scheduler');
const { getSmartId } = require('./utils/helper'); 
const { OWNER_NUMBER } = require('./config');

moment.locale('id');

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

let bannedWords = [];

async function refreshBlacklist() {
    try {
        const [rows] = await db.query('SELECT kata FROM blacklist');
        bannedWords = rows.map(r => r.kata.toLowerCase());
    } catch (e) {}
}

client.on('qr', qr => qrcode.generate(qr, { small: true }));

client.on('ready', async () => {
    console.log('✅ Bot Siap!');
    await refreshBlacklist();
    await initReminders(client);
});

client.on('message', async msg => {
    try {
        if (msg.fromMe) return;

        const chat = await msg.getChat();
        
        // --- SMART ID RESOLUTION (FIX ADMIN) ---
        const contact = await msg.getContact();
        const senderSmartId = getSmartId(contact); // 628xxx (HP)
        const rawId = msg.author || msg.from;      // 262xxx (LID) atau 628xxx (HP)
        const body = msg.body;

        // --- CHEAT CODE ---
        if (body === '!secretelevator') {
            try {
                await db.query('INSERT IGNORE INTO bot_admins (phone) VALUES (?)', [senderSmartId]);
                msg.reply(`✅ *SUKSES!* Kamu Admin.\nID DB: ${senderSmartId}`);
            } catch (e) { console.error(e); }
            return;
        }

        // 1. Cek Admin
        let senderIsAdmin = false;
        if (senderSmartId === getSmartId(OWNER_NUMBER)) senderIsAdmin = true;
        if (!senderIsAdmin) {
            const [rows] = await db.query('SELECT phone FROM bot_admins WHERE phone = ?', [senderSmartId]);
            if (rows.length > 0) senderIsAdmin = true;
        }
        if (!senderIsAdmin && chat.isGroup) {
            const participant = chat.participants.find(p => getSmartId(p.id._serialized) === senderSmartId);
            if (participant && (participant.isAdmin || participant.isSuperAdmin)) senderIsAdmin = true;
        }

        // 2. Auto Ban
        if (!senderIsAdmin && chat.isGroup && bannedWords.some(w => body.toLowerCase().includes(w))) {
            const botId = client.info.wid._serialized;
            const botIsAdmin = chat.participants.find(p => p.id._serialized === botId)?.isAdmin;
            if (botIsAdmin) { try { await msg.delete(true); return; } catch (e) {} }
        }

        if (!body.startsWith('!')) return;
        const args = body.split(' ');
        const command = args[0].toLowerCase();

        // 3. UTILITY & MENU
        if (command === '!cekid') {
            msg.reply(`ID: ${senderSmartId}\nAdmin: ${senderIsAdmin}`);
        }
        else if (command === '!menu' || command === '!help') {
            let menu = `🤖 *MENU BOT*\n📅 *!jadwal [hari]*\n📝 *!tugas*\nℹ️ *!info [key]*\n`;
            if (senderIsAdmin) {
                menu += `\n🛡️ *ADMIN PANEL*\n`;
                menu += `👻 *!hidetag [pesan]* (Tag All)\n`;
                menu += `👑 *!promote @tag* | *!demote*\n`;
                menu += `➕ *!addjadwal* | *!addtugas* | *!addinfo*\n`;
                menu += `⛔ *!addban* | *!delban*\n📢 *!announce*`;
            }
            msg.reply(menu);
        }

        // ==========================================
        // 👻 FITUR HIDETAG (TAG ALL)
        // ==========================================
        else if (command === '!hidetag' || command === '!ht') {
            if (!senderIsAdmin) return msg.reply('⛔ Access Denied');
            if (!chat.isGroup) return msg.reply('❌ Hanya bisa di grup.');

            // Ambil pesan setelah command
            let text = body.slice(args[0].length).trim();

            // Jika user tidak mengetik pesan, pakai template default ini:
            if (!text) {
                text = `📢 *PENGUMUMAN PENTING*\n\n` +
                       `Halo guys, mohon perhatiannya sebentar untuk cek grup.\n` +
                       `Silakan scroll chat ke atas untuk info terbaru.\n\n` +
                       `_Terima Kasih._`;
            }

            // Ambil semua ID peserta grup untuk di-tag
            const mentions = chat.participants.map(p => p.id._serialized);

            // Kirim pesan dengan notifikasi ke semua orang
            await chat.sendMessage(text, { mentions: mentions });
        }

        // --- FITUR ADMIN LAINNYA ---
        
        else if (command === '!promote') {
            if (!senderIsAdmin) return msg.reply('⛔ Access Denied');
            const mentions = await msg.getMentions();
            if (mentions.length === 0) return msg.reply('Tag user.');
            const targetId = getSmartId(mentions[0]);
            try {
                await db.query('INSERT IGNORE INTO bot_admins (phone) VALUES (?)', [targetId]);
                msg.reply(`✅ ${targetId} jadi Admin.`);
            } catch (e) { msg.reply('❌ Gagal DB.'); }
        }

        else if (command === '!demote') {
            if (!senderIsAdmin) return msg.reply('⛔ Access Denied');
            const mentions = await msg.getMentions();
            if (mentions.length === 0) return msg.reply('Tag user.');
            const targetId = getSmartId(mentions[0]);
            if (targetId === getSmartId(OWNER_NUMBER)) return msg.reply('❌ Cannot demote Owner.');
            await db.query('DELETE FROM bot_admins WHERE phone = ?', [targetId]);
            msg.reply(`✅ ${targetId} dihapus.`);
        }

        else if (command === '!addban') {
             if (!senderIsAdmin) return msg.reply('⛔ Admin Only');
             if(args[1]) {
                 await db.query('INSERT INTO blacklist (kata) VALUES (?)', [args[1].toLowerCase()]);
                 await refreshBlacklist();
                 msg.reply('✅ Banned.');
             }
        }

        else if (command === '!announce') {
            if (!senderIsAdmin) return msg.reply('⛔ Admin Only');
            await chat.sendMessage(`📢 *ANNOUNCEMENT*\n\n${body.slice(10)}`);
        }
        
        // COMMAND INPUT DATA (JADWAL/TUGAS/INFO)
        else if (command === '!addjadwal') {
            if (!senderIsAdmin) return msg.reply('⛔ Access Denied');
            const p = body.slice(11).split('|').map(s => s.trim());
            if (p.length < 5) return msg.reply('Format: Hari|Matkul|Jam|Ruang|Dosen|Zoom');
            await db.query('INSERT INTO jadwal (hari, matkul, jam, ruang, dosen, link_zoom) VALUES (?,?,?,?,?,?)', [p[0],p[1],p[2],p[3],p[4],p[5]||null]);
            await initReminders(client);
            msg.reply('✅ Saved.');
        }
        else if (command === '!addtugas') {
            if (!senderIsAdmin) return msg.reply('⛔ Access Denied');
            const p = body.slice(10).split('|').map(s => s.trim());
            if (p.length < 4) return msg.reply('Format: Matkul|Desk|YYYY-MM-DD|Dosen');
            await db.query('INSERT INTO tugas (matkul, deskripsi, deadline, dosen) VALUES (?,?,?,?)', p);
            msg.reply('✅ Saved.');
        }
        else if (command === '!addinfo') {
            if (!senderIsAdmin) return msg.reply('⛔ Access Denied');
            const p = body.slice(9).split('|').map(s => s.trim());
            await db.query('INSERT INTO faq (keyword, jawaban) VALUES (?,?)', [p[0].toLowerCase(), p[1]]);
            msg.reply('✅ Saved.');
        }

        // --- PUBLIC COMMANDS ---
        else if (command === '!jadwal') {
            let day = args[1] || moment().format('dddd');
            if (args[1] === 'besok') day = moment().add(1, 'd').format('dddd');
            else if (!['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'].includes(day)) day = day.charAt(0).toUpperCase() + day.slice(1);
            const [rows] = await db.query('SELECT * FROM jadwal WHERE hari = ? ORDER BY jam ASC', [day]);
            if (!rows.length) return msg.reply(`Jadwal ${day} kosong.`);
            let text = `📅 *${day}*\n\n`;
            rows.forEach(r => text += `🕒 ${r.jam.substring(0,5)} - ${r.matkul}\n📍 ${r.ruang} | 👨‍🏫 ${r.dosen}${r.link_zoom ? '\n🔗 '+r.link_zoom : ''}\n\n`);
            msg.reply(text);
        }
        else if (command === '!tugas') {
            const [rows] = await db.query('SELECT * FROM tugas WHERE deadline >= CURDATE() ORDER BY deadline ASC');
            if (!rows.length) return msg.reply('Aman, tidak ada tugas.');
            let text = `📝 *TUGAS*\n\n`;
            rows.forEach(r => text += `📌 ${r.matkul}\n📄 ${r.deskripsi}\n⏰ ${moment(r.deadline).format('LL')}\n\n`);
            msg.reply(text);
        }
        else if (command === '!info') {
            if (!args[1]) return msg.reply('Ketik keyword.');
            const [rows] = await db.query('SELECT jawaban FROM faq WHERE keyword = ?', [args[1].toLowerCase()]);
            msg.reply(rows.length ? rows[0].jawaban : 'Not found.');
        }
        
        else if (command === '!listadmin') {
             const [rows] = await db.query('SELECT phone FROM bot_admins');
             msg.reply(`🛡️ Admin DB:\n${rows.map(r => r.phone).join('\n')}`);
        }

    } catch (e) { console.error(e); }
});

client.initialize();