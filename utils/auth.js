const db = require('../database/db');
const { OWNER_NUMBER } = require('../config');

async function isAdmin(chat, rawId) {
    // 1. Cek Owner Utama (Dari config.js)
    // Pastikan OWNER_NUMBER di config.js formatnya SAMA PERSIS dengan hasil !checkid
    if (rawId === OWNER_NUMBER) return true;

    // 2. Cek Database Bot Admin (Cek ID mentah)
    try {
        const [rows] = await db.query('SELECT phone FROM bot_admins WHERE phone = ?', [rawId]);
        if (rows.length > 0) return true;
    } catch (e) {
        console.error('DB Check Error:', e);
    }

    // 3. Cek Admin Grup WA
    if (chat.isGroup) {
        const participant = chat.participants.find(p => p.id._serialized === rawId);
        return participant ? (participant.isAdmin || participant.isSuperAdmin) : false;
    }

    return false;
}

module.exports = { isAdmin };