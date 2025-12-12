// File: utils/helper.js

// Fungsi ini memaksa semua jenis ID (LID, c.us, objek contact)
// menjadi HANYA ANGKA NOMOR HP (Contoh: "628123456")
function getSmartId(input) {
    if (!input) return null;

    // 1. Jika input adalah Objek Contact (dari getContact / getMentions)
    if (typeof input === 'object') {
        // Prioritas 1: Ambil id.user (pasti angka murni)
        if (input.id && input.id.user) return input.id.user;
        // Prioritas 2: Ambil number
        if (input.number) return input.number;
    }

    // 2. Jika input string biasa
    let str = input.toString();
    
    // Hapus semua suffix (@c.us, @lid, :12)
    str = str.split('@')[0].split(':')[0];
    
    // Hapus karakter non-angka
    return str.replace(/\D/g, '');
}

module.exports = { getSmartId };