const schedule = require('node-schedule');
const db = require('../database/db');
const { CLASS_GROUP_ID } = require('../config');

async function initReminders(client) {
    try {
        schedule.gracefulShutdown();
        const [rows] = await db.query('SELECT * FROM jadwal');
        
        rows.forEach(row => {
            const [jam, menit] = row.jam.split(':');
            const dayNum = { 'Minggu': 0, 'Senin': 1, 'Selasa': 2, 'Rabu': 3, 'Kamis': 4, 'Jumat': 5, 'Sabtu': 6 }[row.hari];
            if (dayNum === undefined) return;
            
            let jamReminder = parseInt(jam) - 1;
            const zoom = row.link_zoom ? `\n🔗 ${row.link_zoom}` : '';

            schedule.scheduleJob(`${menit} ${jamReminder} * * ${dayNum}`, function(){
                client.sendMessage(CLASS_GROUP_ID, 
                    `⏳ *REMINDER 1 JAM LAGI*\n📚 *${row.matkul}*\n⏰ ${row.jam.substring(0,5)}\n📍 ${row.ruang}\n👨‍🏫 ${row.dosen}${zoom}`
                );
            });
        });
        console.log(`[SYSTEM] Reminder: ${rows.length} jadwal.`);
    } catch (e) { console.error(e); }
}

module.exports = { initReminders };