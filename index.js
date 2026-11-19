const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    downloadContentFromMessage,
    jidDecode
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const readline = require('readline');
const axios = require('axios');
const os = require('os');
const { Sticker, StickerTypes } = require('wa-sticker-formatter');

// ================= KONFIGURASI BOT =================
const config = {
    ownerNumber: ['6285764612711'], // Ganti dengan nomor WhatsApp Anda (awalan 62)
    ownerName: 'Admin',
    botName: 'X-Bot MD',
    prefix: '.',
    publicMode: true
};

// ================= DATABASE SEDERHANA =================
const dbFile = './database.json';
if (!fs.existsSync(dbFile)) {
    fs.writeFileSync(dbFile, JSON.stringify({
        users: {},
        groups: {},
        respon: {},
        premium: []
    }, null, 2));
}
let db = JSON.parse(fs.readFileSync(dbFile));
const saveDb = () => fs.writeFileSync(dbFile, JSON.stringify(db, null, 2));

// ================= HELPER FUNGSI =================
const question = (text) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => rl.question(text, (ans) => { rl.close(); resolve(ans); }));
};

const runtime = (seconds) => {
    seconds = Number(seconds);
    const d = Math.floor(seconds / (3600 * 24));
    const h = Math.floor(seconds % (3600 * 24) / 3600);
    const m = Math.floor(seconds % 3600 / 60);
    const s = Math.floor(seconds % 60);
    return `${d}d ${h}h ${m}m ${s}s`;
};

const getUcapanWaktu = () => {
    const jam = new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false }).split(':')[0];
    if (jam >= 4 && jam < 11) return 'Selamat Pagi';
    if (jam >= 11 && jam < 15) return 'Selamat Siang';
    if (jam >= 15 && jam < 18) return 'Selamat Sore';
    return 'Selamat Malam';
};

async function downloadMedia(message, type) {
    const stream = await downloadContentFromMessage(message, type);
    let buffer = Buffer.from([]);
    for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
    }
    return buffer;
}

// ================= KONEKSI UTAMA WHATSAPP =================
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./session');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: ['Ubuntu', 'Chrome', '20.0.04']
    });

    // Login menggunakan Pairing Code
    if (!sock.authState.creds.registered) {
        const phoneNumber = await question('Masukkan Nomor WhatsApp Bot (contoh: 62812xxx): ');
        const code = await sock.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''));
        console.log(`\n🔑 KODE PAIRING ANDA: ${code}\n`);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Koneksi terputus, mencoba menghubungkan kembali...', shouldReconnect);
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('✅ Bot WhatsApp Berhasil Terhubung!');
        }
    });

    // ================= HANDLER PESAN =================
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const from = m.key.remoteJid;
        const isGroup = from.endsWith('@g.us');
        const sender = isGroup ? (m.key.participant || m.participant) : from;
        const senderNumber = sender.split('@')[0];
        const pushname = m.pushName || 'User';

        // Ekstrak isi teks pesan
        const body = m.message.conversation ||
            m.message.extendedTextMessage?.text ||
            m.message.imageMessage?.caption ||
            m.message.videoMessage?.caption || '';

        // Registrasi user otomatis ke database
        if (!db.users[sender]) {
            db.users[sender] = {
                name: pushname,
                balance: 1000,
                bank: 0,
                exp: 0,
                level: 1,
                health: 100,
                lastDaily: 0
            };
            saveDb();
        }

        const isOwner = config.ownerNumber.includes(senderNumber);
        const isPrem = isOwner || db.premium.includes(senderNumber);
        const userStatus = isOwner ? 'Owner' : isPrem ? 'Premium' : 'Free';

        // Cek Mode Self / Public
        if (!config.publicMode && !isOwner) return;

        // Cek Auto Respon (Fitur RESPON)
        if (db.respon[body.toLowerCase()]) {
            return sock.sendMessage(from, { text: db.respon[body.toLowerCase()] }, { quoted: m });
        }

        // Cek Antilink Grup
        if (isGroup && db.groups[from]?.antilink && body.includes('chat.whatsapp.com')) {
            if (!isOwner) {
                await sock.sendMessage(from, { delete: m.key });
                await sock.sendMessage(from, { text: `⚠️ Jangan kirim link grup di sini @${senderNumber}!`, mentions: [sender] });
                return;
            }
        }

        // Filter Command
        if (!body.startsWith(config.prefix)) return;
        const args = body.slice(config.prefix.length).trim().split(/ +/);
        const command = args.shift().toLowerCase();
        const text = args.join(' ');
        const quoted = m.message.extendedTextMessage?.contextInfo?.quotedMessage;

        const reply = (teks) => sock.sendMessage(from, { text: teks }, { quoted: m });

        // Helper Cek Admin Grup
        const getGroupAdmins = async () => {
            if (!isGroup) return { isSenderAdmin: false, isBotAdmin: false, participants: [] };
            const metadata = await sock.groupMetadata(from);
            const admins = metadata.participants.filter(p => p.admin !== null).map(p => p.id);
            const botId = sock.user.id.split(':')[0] + '@s.whatsapp.net';
            return {
                isSenderAdmin: admins.includes(sender) || isOwner,
                isBotAdmin: admins.includes(botId),
                participants: metadata.participants,
                metadata
            };
        };

        // ================= SWITCH COMMAND =================
        switch (command) {

            // ---------------- [ 1. MAIN MENU ] ----------------
            case 'menu':
            case 'help': {
                const tanggal = new Date().toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta' });
                const menuText = `${getUcapanWaktu()}

*User:* @${senderNumber}
*Status:* ${userStatus}
*Date:* ${tanggal}
*Server:* ${os.hostname()}

*MAIN*
  .menu
  .runtime
  .ping
  .speed
  .owner
  .script
  .donasi
  .aturan
  .sewa
  .check

*CONVERT*
  .sticker
  .stickermeme
  .smeme
  .attp
  .ttp
  .brat
  .qc
  .toimg
  .tovn
  .tomp3
  .tovideo
  .emojimix
  .stickerwm

*CHATS / RANDOM*
  .quoted
  .motivasi
  .faktaunik
  .katabijak
  .pantun
  .bucin
  .galau
  .truth
  .dare
  .cekjodoh
  .cekganteng
  .cekcantik
  .cekkhodam
  .apakah
  .kapankah

*AI BOT*
  .ai
  .openai
  .gemini
  .blackbox
  .simi
  .bard
  .deepseek
  .bingimg

*TOOLS*
  .tourl
  .ssweb
  .translate
  .remini
  .hd
  .removebg
  .shortlink
  .kalkulator
  .cekid
  .getpp
  .readviewonce
  .rvo
  .tts
  .qrcode
  .base64
  .whois
  .cuaca
  .jadwalsholat
  .lirik

*SEARCH*
  .wikipedia
  .pinterest
  .gimage
  .ytsearch
  .tiktoksearch
  .spotifysearch

*DOWNLOADER*
  .tiktok
  .tiktokmp3
  .igdl
  .igstory
  .ytmp3
  .ytmp4
  .facebook
  .twitter
  .spotify
  .mediafire
  .gdrive
  .capcut

*GAME*
  .tebakgambar
  .tebakkata
  .tebaklirik
  .tebaklagu
  .tebakbendera
  .family100
  .caklontong
  .susunkata
  .asahotak
  .siapakahaku
  .math
  .suit
  .tictactoe
  .slot
  .casino

*ECONOMY*
  .balance
  .bank
  .deposit
  .tarik
  .transfer
  .daily
  .leaderboard

*BAILEYS*
  .rvo
  .hidetag
  .tagall
  .totag
  .delete
  .quoted
  .inspect
  .listonline

*RESPON*
  .addrespon
  .delrespon
  .listrespon
  .setrespon

*RPG*
  .adventure
  .heal
  .profile
  .inventory
  .mining
  .fishing
  .hunt
  .shop
  .buy
  .sell

*GROUP*
  .add
  .kick
  .promote
  .demote
  .linkgc
  .revoke
  .setppgc
  .setnamegc
  .setdesc
  .group
  .antilink
  .welcome
  .mute
  .hidetag
  .tagall

*OWNER*
  .self
  .public
  .join
  .leave
  .block
  .unblock
  .addprem
  .delprem
  .listprem
  .bc
  .bcgc
  .setppbot
  .restart`;

                await sock.sendMessage(from, {
                    text: menuText,
                    mentions: [sender]
                }, { quoted: m });
                break;
            }

            case 'ping':
            case 'speed': {
                const start = Date.now();
                await reply('Testing ping...');
                const latency = Date.now() - start;
                reply(`🏓 *Pong!*\nKecepatan Respon: *${latency} ms*`);
                break;
            }

            case 'runtime': {
                reply(`⏱️ *Runtime Bot:*\n${runtime(process.uptime())}`);
                break;
            }

            case 'owner': {
                reply(`👤 *Kontak Owner:*\nwa.me/${config.ownerNumber[0]} (${config.ownerName})`);
                break;
            }

            case 'check': {
                const u = db.users[sender];
                reply(`📊 *STATUS PENGGUNA*\n\n• Nama: ${u.name}\n• Nomor: ${senderNumber}\n• Status: ${userStatus}\n• Level: ${u.level}\n• Balance: Rp ${u.balance.toLocaleString()}`);
                break;
            }

            // ---------------- [ 2. CONVERT ] ----------------
            case 's':
            case 'sticker': {
                const isImage = m.message.imageMessage || quoted?.imageMessage;
                if (!isImage) return reply(`Kirim atau balas gambar dengan caption *${config.prefix}sticker*`);
                const msgMedia = m.message.imageMessage ? m.message.imageMessage : quoted.imageMessage;
                const buffer = await downloadMedia(msgMedia, 'image');
                const sticker = new Sticker(buffer, {
                    pack: config.botName,
                    author: config.ownerName,
                    type: StickerTypes.FULL,
                    quality: 60
                });
                await sock.sendMessage(from, await sticker.toMessage(), { quoted: m });
                break;
            }

            case 'toimg': {
                if (!quoted?.stickerMessage) return reply(`Balas stiker dengan perintah *${config.prefix}toimg*`);
                const buffer = await downloadMedia(quoted.stickerMessage, 'sticker');
                await sock.sendMessage(from, { image: buffer, caption: '✅ Berhasil diubah ke gambar!' }, { quoted: m });
                break;
            }

            // ---------------- [ 3. CHATS / RANDOM ] ----------------
            case 'apakah': {
                if (!text) return reply(`Contoh: *${config.prefix}apakah aku akan kaya?*`);
                const jawaban = ['Iya', 'Tidak', 'Mungkin saja', 'Bisa jadi', 'Mustahil', '100% Pasti!'];
                reply(`❓ *Pertanyaan:* ${text}\n💡 *Jawaban:* ${jawaban[Math.floor(Math.random() * jawaban.length)]}`);
                break;
            }

            case 'cekkhodam': {
                const nama = text || pushname;
                const khodam = ['Macan Putih', 'Tutup Panci', 'Naga Indosiar', 'Kipas Angin Cosmos', 'Rawa Rontek', 'Kosong / Tidak Ada', 'Kucing Oren', 'Sendal Swallow'];
                reply(`🔮 *Cek Khodam*\n\nNama: ${nama}\nKhodam: *${khodam[Math.floor(Math.random() * khodam.length)]}*`);
                break;
            }

            // ---------------- [ 4. AI BOT ] ----------------
            case 'ai':
            case 'openai':
            case 'gemini': {
                if (!text) return reply(`Masukkan pertanyaan!\nContoh: *${config.prefix}${command} Apa itu JavaScript?*`);
                try {
                    const res = await axios.get(`https://text.pollinations.ai/${encodeURIComponent(text)}`);
                    reply(res.data);
                } catch (e) {
                    reply('Gagal menghubungi server AI.');
                }
                break;
            }

            // ---------------- [ 5. TOOLS & BAILEYS ] ----------------
            case 'rvo':
            case 'readviewonce': {
                const viewOnce = quoted?.viewOnceMessageV2?.message || quoted?.viewOnceMessage?.message || quoted?.viewOnceMessageV2Extension?.message;
                if (!viewOnce) return reply('Balas pesan 1x lihat (View Once) dengan perintah ini!');
                const typeMedia = Object.keys(viewOnce)[0];
                const mediaMsg = viewOnce[typeMedia];
                const buffer = await downloadMedia(mediaMsg, typeMedia.replace('Message', '').toLowerCase());
                if (typeMedia === 'imageMessage') {
                    await sock.sendMessage(from, { image: buffer, caption: mediaMsg.caption || '' }, { quoted: m });
                } else if (typeMedia === 'videoMessage') {
                    await sock.sendMessage(from, { video: buffer, caption: mediaMsg.caption || '' }, { quoted: m });
                } else if (typeMedia === 'audioMessage') {
                    await sock.sendMessage(from, { audio: buffer, mimetype: 'audio/mp4', ptt: true }, { quoted: m });
                }
                break;
            }

            case 'kalkulator': {
                if (!text) return reply(`Contoh: *${config.prefix}kalkulator 15*20*`);
                try {
                    const cleanMath = text.replace(/[^0-9+\-*/().]/g, '');
                    const hasil = eval(cleanMath);
                    reply(`🧮 *Hasil:* ${cleanMath} = *${hasil}*`);
                } catch {
                    reply('Format perhitungan tidak valid.');
                }
                break;
            }

            case 'cekid': {
                reply(`🆔 *ID Chat:* ${from}\n👤 *ID Anda:* ${sender}`);
                break;
            }

            case 'del':
            case 'delete': {
                if (!m.message.extendedTextMessage) return reply('Balas pesan yang ingin dihapus!');
                const { remoteJid, id, participant } = m.message.extendedTextMessage.contextInfo;
                await sock.sendMessage(from, {
                    delete: {
                        remoteJid: from,
                        fromMe: participant === (sock.user.id.split(':')[0] + '@s.whatsapp.net'),
                        id: m.message.extendedTextMessage.contextInfo.stanzaId,
                        participant: participant
                    }
                });
                break;
            }

            // ---------------- [ 6. ECONOMY & RPG ] ----------------
            case 'balance':
            case 'bank': {
                const u = db.users[sender];
                reply(`💰 *DOMPET & BANK*\n\n• Dompet: Rp ${u.balance.toLocaleString()}\n• Bank: Rp ${u.bank.toLocaleString()}\n• Level: ${u.level} (EXP: ${u.exp})`);
                break;
            }

            case 'daily': {
                const u = db.users[sender];
                const cooldown = 86400000; // 24 Jam
                if (Date.now() - u.lastDaily < cooldown) {
                    const sisa = runtime((cooldown - (Date.now() - u.lastDaily)) / 1000);
                    return reply(`⏳ Anda sudah klaim harian! Tunggu *${sisa}* lagi.`);
                }
                u.balance += 5000;
                u.lastDaily = Date.now();
                saveDb();
                reply('🎁 Selamat! Anda mendapatkan *Rp 5.000* dari klaim harian.');
                break;
            }

            case 'transfer': {
                const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                const nominal = parseInt(args[1]);
                if (!target || isNaN(nominal) || nominal <= 0) return reply(`Contoh: *${config.prefix}transfer @tag 1000*`);
                if (db.users[sender].balance < nominal) return reply('Saldo Anda tidak mencukupi!');
                if (!db.users[target]) db.users[target] = { name: 'User', balance: 1000, bank: 0, exp: 0, level: 1, health: 100, lastDaily: 0 };
                db.users[sender].balance -= nominal;
                db.users[target].balance += nominal;
                saveDb();
                reply(`✅ Berhasil transfer *Rp ${nominal.toLocaleString()}* ke @${target.split('@')[0]}`);
                break;
            }

            case 'adventure': {
                const u = db.users[sender];
                if (u.health < 20) return reply(`❤️ Darah Anda terlalu rendah (${u.health} HP). Ketik *${config.prefix}heal* terlebih dahulu!`);
                const dapatUang = Math.floor(Math.random() * 2000) + 500;
                const dapatExp = Math.floor(Math.random() * 100) + 20;
                const kurangHp = Math.floor(Math.random() * 20) + 5;
                u.balance += dapatUang;
                u.exp += dapatExp;
                u.health -= kurangHp;
                if (u.exp >= u.level * 200) {
                    u.level += 1;
                    u.exp = 0;
                }
                saveDb();
                reply(`⚔️ *PETUALANGAN SELESAI*\n\n• +Rp ${dapatUang.toLocaleString()}\n• +${dapatExp} EXP\n• -${kurangHp} HP (Sisa: ${u.health} HP)`);
                break;
            }

            case 'heal': {
                const u = db.users[sender];
                if (u.health >= 100) return reply('❤️ Darah Anda sudah penuh!');
                if (u.balance < 500) return reply('Biaya heal adalah Rp 500. Saldo tidak cukup!');
                u.balance -= 500;
                u.health = 100;
                saveDb();
                reply('🧪 Darah Anda berhasil dipulihkan menjadi *100 HP* (-Rp 500).');
                break;
            }

            case 'slot': {
                const taruhan = parseInt(args[0]);
                if (isNaN(taruhan) || taruhan < 100) return reply(`Masukkan jumlah taruhan minimal 100!\nContoh: *${config.prefix}slot 500*`);
                if (db.users[sender].balance < taruhan) return reply('Saldo tidak mencukupi!');
                const emojis = ['🍎', '🍊', '🍇', '🍒', '💎', '7️⃣'];
                const a = emojis[Math.floor(Math.random() * emojis.length)];
                const b = emojis[Math.floor(Math.random() * emojis.length)];
                const c = emojis[Math.floor(Math.random() * emojis.length)];
                let hasil = `🎰 *GAME SLOT* 🎰\n\n[ ${a} | ${b} | ${c} ]\n\n`;
                if (a === b && b === c) {
                    const menang = taruhan * 5;
                    db.users[sender].balance += menang;
                    hasil += `🎉 *JACKPOT!* Anda menang *Rp ${menang.toLocaleString()}*`;
                } else if (a === b || b === c || a === c) {
                    const menang = taruhan * 2;
                    db.users[sender].balance += menang;
                    hasil += `✨ *MENANG!* Anda dapat *Rp ${menang.toLocaleString()}*`;
                } else {
                    db.users[sender].balance -= taruhan;
                    hasil += `💀 *KALAH!* Saldo berkurang *Rp ${taruhan.toLocaleString()}*`;
                }
                saveDb();
                reply(hasil);
                break;
            }

            // ---------------- [ 7. RESPON / AUTO RESPONDER ] ----------------
            case 'addrespon': {
                if (!isOwner) return reply('Khusus Owner!');
                const [key, ...val] = text.split('|');
                if (!key || val.length === 0) return reply(`Gunakan format: *${config.prefix}addrespon kata|balasan*`);
                db.respon[key.trim().toLowerCase()] = val.join('|').trim();
                saveDb();
                reply(`✅ Berhasil menambah respon untuk kata kunci: *${key.trim()}*`);
                break;
            }

            case 'delrespon': {
                if (!isOwner) return reply('Khusus Owner!');
                if (!text) return reply(`Contoh: *${config.prefix}delrespon kata*`);
                delete db.respon[text.toLowerCase()];
                saveDb();
                reply(`🗑️ Berhasil menghapus respon: *${text}*`);
                break;
            }

            case 'listrespon': {
                const keys = Object.keys(db.respon);
                if (keys.length === 0) return reply('Belum ada daftar auto-respon.');
                reply(`📋 *DAFTAR RESPON:*\n\n${keys.map((k, i) => `${i + 1}. ${k}`).join('\n')}`);
                break;
            }

            // ---------------- [ 8. GROUP MENU ] ----------------
            case 'hidetag': {
                if (!isGroup) return reply('Khusus di dalam Grup!');
                const { isSenderAdmin, participants } = await getGroupAdmins();
                if (!isSenderAdmin) return reply('Khusus Admin Grup!');
                await sock.sendMessage(from, {
                    text: text || '',
                    mentions: participants.map(p => p.id)
                });
                break;
            }

            case 'tagall': {
                if (!isGroup) return reply('Khusus di dalam Grup!');
                const { isSenderAdmin, participants } = await getGroupAdmins();
                if (!isSenderAdmin) return reply('Khusus Admin Grup!');
                let teks = `📢 *TAG ALL MEMBERS*\nPesan: ${text || 'Tidak ada'}\n\n`;
                for (let mem of participants) {
                    teks += `• @${mem.id.split('@')[0]}\n`;
                }
                await sock.sendMessage(from, { text: teks, mentions: participants.map(p => p.id) }, { quoted: m });
                break;
            }

            case 'kick': {
                if (!isGroup) return reply('Khusus di dalam Grup!');
                const { isSenderAdmin, isBotAdmin } = await getGroupAdmins();
                if (!isSenderAdmin) return reply('Khusus Admin Grup!');
                if (!isBotAdmin) return reply('Jadikan Bot sebagai Admin terlebih dahulu!');
                const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || m.message.extendedTextMessage?.contextInfo?.participant;
                if (!target) return reply('Tag atau balas pesan orang yang ingin dikeluarkan!');
                await sock.groupParticipantsUpdate(from, [target], 'remove');
                reply('✅ Berhasil mengeluarkan anggota.');
                break;
            }

            case 'promote':
            case 'demote': {
                if (!isGroup) return reply('Khusus di dalam Grup!');
                const { isSenderAdmin, isBotAdmin } = await getGroupAdmins();
                if (!isSenderAdmin) return reply('Khusus Admin Grup!');
                if (!isBotAdmin) return reply('Jadikan Bot sebagai Admin terlebih dahulu!');
                const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || m.message.extendedTextMessage?.contextInfo?.participant;
                if (!target) return reply('Tag atau balas pesan target!');
                await sock.groupParticipantsUpdate(from, [target], command);
                reply(`✅ Berhasil ${command} anggota.`);
                break;
            }

            case 'group': {
                if (!isGroup) return reply('Khusus di dalam Grup!');
                const { isSenderAdmin, isBotAdmin } = await getGroupAdmins();
                if (!isSenderAdmin) return reply('Khusus Admin Grup!');
                if (!isBotAdmin) return reply('Jadikan Bot sebagai Admin terlebih dahulu!');
                if (args[0] === 'open') {
                    await sock.groupSettingUpdate(from, 'not_announcement');
                    reply('✅ Grup telah dibuka untuk semua anggota.');
                } else if (args[0] === 'close') {
                    await sock.groupSettingUpdate(from, 'announcement');
                    reply('🔒 Grup telah ditutup (hanya admin yang dapat mengirim pesan).');
                } else {
                    reply(`Gunakan: *${config.prefix}group open* atau *${config.prefix}group close*`);
                }
                break;
            }

            case 'antilink': {
                if (!isGroup) return reply('Khusus di dalam Grup!');
                const { isSenderAdmin, isBotAdmin } = await getGroupAdmins();
                if (!isSenderAdmin) return reply('Khusus Admin Grup!');
                if (!isBotAdmin) return reply('Jadikan Bot sebagai Admin terlebih dahulu!');
                if (!db.groups[from]) db.groups[from] = { antilink: false };
                if (args[0] === 'on') {
                    db.groups[from].antilink = true;
                    saveDb();
                    reply('✅ Antilink Grup berhasil diaktifkan!');
                } else if (args[0] === 'off') {
                    db.groups[from].antilink = false;
                    saveDb();
                    reply('❌ Antilink Grup dinonaktifkan.');
                } else {
                    reply(`Gunakan: *${config.prefix}antilink on* atau *${config.prefix}antilink off*`);
                }
                break;
            }

            // ---------------- [ 9. OWNER MENU ] ----------------
            case 'self': {
                if (!isOwner) return reply('Khusus Owner!');
                config.publicMode = false;
                reply('🔒 Bot berhasil diubah ke mode *SELF* (Hanya Owner).');
                break;
            }

            case 'public': {
                if (!isOwner) return reply('Khusus Owner!');
                config.publicMode = true;
                reply('🌐 Bot berhasil diubah ke mode *PUBLIC* (Semua Orang).');
                break;
            }

            case 'addprem': {
                if (!isOwner) return reply('Khusus Owner!');
                const nomor = text.replace(/[^0-9]/g, '');
                if (!nomor) return reply(`Contoh: *${config.prefix}addprem 62812xxx*`);
                if (!db.premium.includes(nomor)) db.premium.push(nomor);
                saveDb();
                reply(`✅ Nomor ${nomor} berhasil ditambahkan ke daftar *Premium*.`);
                break;
            }

            case 'delprem': {
                if (!isOwner) return reply('Khusus Owner!');
                const nomor = text.replace(/[^0-9]/g, '');
                db.premium = db.premium.filter(p => p !== nomor);
                saveDb();
                reply(`🗑️ Nomor ${nomor} dihapus dari daftar *Premium*.`);
                break;
            }

            default:
                // Jika perintah ada di menu tapi belum diisi API eksternal
                break;
        }
    });
}

startBot();
