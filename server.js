const express = require('express');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// REFRESH VA OQ EKRAN XATOLIKLARINI OLDINI OLISH
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.use(express.static(path.join(__dirname, 'public')));

// AQLLI BAZA ULANISH TIZIMI (Ham lokal Termux, ham Render uchun)
const isProduction = process.env.NODE_ENV === 'production';
let pool;

if (isProduction) {
    // RENDER.COM UCHUN INTERNETDAGI BAZA
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });
} else {
    // TERMUX LOCAL UCHUN TELEFON ICHIDAGI BAZA
    pool = new Pool({
        user: 'u0_a410',
        host: 'localhost',
        database: 'postgres',
        password: '',
        port: 5432
    });
}

// Baza ulanishini tekshirish
pool.connect((err, client, release) => {
    if (err) {
        return console.error('Bazaga ulanishda xatolik yuz berdi:', err.stack);
    }
    console.log('PostgreSQL bazasiga muvaffaqiyatli ulandi!');
    release();
});

// 1. Andozalar ro'yxati
app.get('/api/templates', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM andozalar ORDER BY model_nomi ASC");
        res.json(result.rows);
    } catch (err) { 
        console.error("Templates olishda xato:", err.message);
        res.status(500).json({ error: err.message }); 
    }
});

// 2. Yangi andoza yaratish
app.post('/api/templates', async (req, res) => {
    const { key_name, etalon_weight } = req.body;
    if (!key_name || !etalon_weight) {
        return res.status(400).json({ error: "Ma'lumotlar to'liq emas!" });
    }
    const name = key_name.trim().toUpperCase();
    try {
        await pool.query(
            "INSERT INTO andozalar (model_nomi, vazn_10_dona) VALUES ($1, $2) ON CONFLICT (model_nomi) DO UPDATE SET vazn_10_dona = EXCLUDED.vazn_10_dona",
            [name, etalon_weight]
        );
        await pool.query(
            "INSERT INTO ombor (model_nomi, jami_vazn, jami_soni) VALUES ($1, 0, 0) ON CONFLICT (model_nomi) DO NOTHING", 
            [name]
        );
        res.json({ success: true });
    } catch (err) { 
        console.error("Andoza yaratishda xato:", err.message);
        res.status(500).json({ error: err.message }); 
    }
});

// 3. Ombor qoldig'ini olish
app.get('/api/stock', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM ombor ORDER BY model_nomi ASC");
        res.json(result.rows);
    } catch (err) { 
        console.error("Omborni olishda xato:", err.message);
        res.status(500).json({ error: err.message }); 
    }
});

// 4. Tarixni olish
app.get('/api/logs', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM tarix ORDER BY id DESC LIMIT 100");
        res.json(result.rows);
    } catch (err) { 
        console.error("Loglarni olishda xato:", err.message);
        res.status(500).json({ error: err.message }); 
    }
});

// 5. Kirim / Chiqim tranzaksiyasi
app.post('/api/stock/transaction', async (req, res) => {
    const { key_name, type, mode, value } = req.body;
    try {
        const tempRes = await pool.query("SELECT vazn_10_dona FROM andozalar WHERE model_nomi = $1", [key_name]);
        if(tempRes.rows.length === 0) return res.status(400).json({ error: "Andoza topilmadi!" });

        const bitta_vazni = parseFloat(tempRes.rows[0].vazn_10_dona) / 10;
        let hisoblangan_soni = 0;
        let hisoblangan_vazni = 0;

        if (mode === 'weight') {
            hisoblangan_vazni = parseFloat(value);
            hisoblangan_soni = Math.round(hisoblangan_vazni / bitta_vazni);
        } else {
            hisoblangan_soni = parseInt(value);
            hisoblangan_vazni = hisoblangan_soni * bitta_vazni;
        }

        if (type === 'sub') {
            const stockRes = await pool.query("SELECT jami_soni FROM ombor WHERE model_nomi = $1", [key_name]);
            const bor_soni = stockRes.rows[0] ? stockRes.rows[0].jami_soni : 0;

            if (hisoblangan_soni > bor_soni) {
                return res.status(400).json({
                    error: `Xatolik! Omborda bor-yo'g'i ${bor_soni} ta kalit mavjud. Siz ${hisoblangan_soni} ta chiqarmoqchisiz.`
                });
            }

            await pool.query(
                "UPDATE ombor SET jami_vazn = GREATEST(0, jami_vazn - $1), jami_soni = GREATEST(0, jami_soni - $2) WHERE model_nomi = $3",
                [hisoblangan_vazni, hisoblangan_soni, key_name]
            );
            await pool.query("INSERT INTO tarix (model_nomi, amal_turi, o_zgarish_soni, o_zgarish_vazni) VALUES ($1, 'CHIQIM', $2, $3)", [key_name, hisoblangan_soni, hisoblangan_vazni]);
        } else {
            await pool.query(
                "UPDATE ombor SET jami_vazn = jami_vazn + $1, jami_soni = jami_soni + $2 WHERE model_nomi = $3",
                [hisoblangan_vazni, hisoblangan_soni, key_name]
            );
            await pool.query("INSERT INTO tarix (model_nomi, amal_turi, o_zgarish_soni, o_zgarish_vazni) VALUES ($1, 'KIRIM', $2, $3)", [key_name, hisoblangan_soni, hisoblangan_vazni]);
        }

        res.json({ success: true });
    } catch (err) { 
        console.error("Tranzaksiyada xato:", err.message);
        res.status(500).json({ error: err.message }); 
    }
});

// 6. Modelni butunlay o'chirish
app.delete('/api/stock/:name', async (req, res) => {
    const { name } = req.params;
    try {
        await pool.query("DELETE FROM ombor WHERE model_nomi = $1", [name]);
        await pool.query("DELETE FROM andozalar WHERE model_nomi = $1", [name]);
        res.json({ success: true });
    } catch (err) { 
        console.error("O'chirishda xato:", err.message);
        res.status(500).json({ error: err.message }); 
    }
});

// Bosh sahifa yo'nalishi
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// GLOBAL XAVFSIZLIK QALQONI (Server kutilmagan xatoda ham o'chib qolmaydi)
process.on('uncaughtException', (err) => console.error('Tizim ichki xatoligi (Tutildi):', err.message));
process.on('unhandledRejection', (reason) => console.error('Kutilmagan rad etilish (Tutildi):', reason));

// PORT SOZLAMASI
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});

