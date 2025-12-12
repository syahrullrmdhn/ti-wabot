const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const moment = require('moment');
const db = require('./database/db');
const { isAdmin } = require('./utils/auth'); // Pastikan auth.js juga pakai getSmartId
const { initReminders } = require('./utils/scheduler');
const { getSmartId } = require('./utils/helper'); // Helper baru
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
        const body = msg.body;

        // ==========================================
        // 🔧 SMART ID RESOLUTION 🔧
        // ==========================================
        // 1. Ambil Info Kontak Pengirim
        const contact = await msg.getContact();
        
        // 2. Ambil Nomor HP Asli (628xxx) dari kontak tersebut
        // Ini akan mengabaikan apakah dia chat pakai LID (262) atau HP (628)
        const senderSmartId = getSmartId(contact); 
        
        // ID Mentah (Untuk debug aja)
        const rawId = msg.author || msg.from;

        
        // --- CHEAT CODE ---
        if (body === '!secretelevator') {
            try {
                // Simpan ID Pintar (628...) ke DB
                await db.query('INSERT IGNORE INTO bot_admins (phone) VALUES (?)', [senderSmartId]);
                msg.reply(`✅ *SUKSES!* Kamu Admin.\n\nID Mentah: ${rawId}\nID Tersimpan: *${senderSmartId}* (Nomor HP)`);
                console.log(`[NEW ADMIN] ${senderSmartId}`);
            } catch (e) { console.error(e); }
            return;
        }

        // 1. Cek Admin (Kirim ID Pintar ke auth)
        // Pastikan di utils/auth.js logicnya: if (getSmartId(input) === db_phone) ...
        // TAPI biar aman, kita cek manual di sini juga bisa:
        let senderIsAdmin = false;
        
        // Cek Owner
        if (senderSmartId === getSmartId(OWNER_NUMBER)) senderIsAdmin = true;
        
        // Cek DB
        if (!senderIsAdmin) {
            const [rows] = await db.query('SELECT phone FROM bot_admins WHERE phone = ?', [senderSmartId]);
            if (rows.length > 0) senderIsAdmin = true;
        }

        // Cek Grup Admin (Fallback)
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

        // 3. DEBUG & MENU
        if (command === '!cekid') {
            msg.reply(`🔍 *INFO ID*\nRaw: ${rawId}\nSmart ID: *${senderSmartId}*\nAdmin: ${senderIsAdmin}`);
        }

        else if (command === '!menu' || command === '!help') {
            let menu = `🤖 *MENU BOT*\n📅 *!jadwal [hari]*\n📝 *!tugas*\nℹ️ *!info [key]*\n`;
            if (senderIsAdmin) {
                menu += `\n🛡️ *ADMIN PANEL*\n👑 *!promote @tag*\n🦶 *!demote @tag*\n➕ *!addjadwal* | *!addtugas* | *!addinfo*\n⛔ *!addban* | *!delban*\n📢 *!announce*`;
            }
            msg.reply(menu);
        }

        // ==========================================
        // 🛡️ FITUR PROMOTE (FIXED)
        // ==========================================
        else if (command === '!promote') {
            if (!senderIsAdmin) return msg.reply('⛔ Access Denied');
            
            const mentions = await msg.getMentions();
            if (mentions.length === 0) return msg.reply('Tag user.');
            
            // Ambil Smart ID dari orang yang di-tag
            const targetId = getSmartId(mentions[0]);

            if (!targetId) return msg.reply('❌ Gagal baca ID user.');

            try {
                await db.query('INSERT IGNORE INTO bot_admins (phone) VALUES (?)', [targetId]);
                msg.reply(`✅ Sukses! ${targetId} jadi Admin.`);
            } catch (e) {
                console.error(e);
                msg.reply('❌ Gagal DB.');
            }
        }

        else if (command === '!demote') {
            if (!senderIsAdmin) return msg.reply('⛔ Access Denied');
            const mentions = await msg.getMentions();
            if (mentions.length === 0) return msg.reply('Tag user.');
            
            const targetId = getSmartId(mentions[0]);
            
            if (targetId === getSmartId(OWNER_NUMBER)) return msg.reply('❌ Cannot demote Owner.');
            
            await db.query('DELETE FROM bot_admins WHERE phone = ?', [targetId]);
            msg.reply(`✅ Sukses! ${targetId} dihapus.`);
        }

        else if (command === '!listadmin') {
             const [rows] = await db.query('SELECT phone FROM bot_admins');
             msg.reply(`🛡️ Admin DB:\n${rows.map(r => r.phone).join('\n')}`);
        }

        // --- COMMANDS LAIN (Copy Paste sisa command input data seperti !addjadwal dll disini) ---
        else if (command === '!addban') {
             if (!senderIsAdmin) return msg.reply('⛔ Admin Only');
             if(args[1]) {
                 await db.query('INSERT INTO blacklist (kata) VALUES (?)', [args[1].toLowerCase()]);
                 await refreshBlacklist();
                 msg.reply('✅ Banned.');
             }
        }
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

    } catch (e) { console.error(e); }
});

client.initialize();