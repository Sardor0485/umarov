const express = require('express');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// REFRESH XATOLIGINI OLDINI OLISH
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.use(express.static(path.join(__dirname, 'public')));

// RENDER VA TERMUX UCHUN AVTOMATIK BAZA SOZLAMASI
// Agar Render-da bo'lsa, internetdagi URL orqali, Termux-da bo'lsa lokal ulanadi
const isProduction = process.env.NODE_ENV === 'production';

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: isProduction ? { rejectUnauthorized: false } : false // Render uchun SSL majburiy
});

pool.connect((err, client, release) => {
    if (err) return console.error('Bazaga ulanishda xatolik:', err.stack);
    console.log('PostgreSQL bazasiga muvaffaqiyatli ulandi!');
    release();
});

app.get('/api/templates', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM andozalar ORDER BY model_nomi ASC");
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/templates', async (req, res) => {
    const { key_name, etalon_weight } = req.body;
    const name = key_name.trim().toUpperCase();
    try {
        await pool.query("INSERT INTO andozalar (model_nomi, vazn_10_dona) VALUES ($1, $2) ON CONFLICT (model_nomi) DO UPDATE SET vazn_10_dona = EXCLUDED.vazn_10_dona", [name, etalon_weight]);
        await pool.query("INSERT INTO ombor (model_nomi, jami_vazn, jami_soni) VALUES ($1, 0, 0) ON CONFLICT (model_nomi) DO NOTHING", [name]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stock', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM ombor ORDER BY model_nomi ASC");
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/logs', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM tarix ORDER BY id DESC LIMIT 100");
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/stock/transaction', async (req, res) => {
    const { key_name, type, mode, value } = req.body;
    try {
        const tempRes = await pool.query("SELECT vazn_10_dona FROM andozalar WHERE model_nomi = $1", [key_name]);
        if(tempRes.rows.length === 0) return res.status(400).json({ error: "Andoza topilmadi!" });

        const bitta_vazni = parseFloat(tempRes.rows[0].vazn_10_dona) / 10;
        let hisoblangan_soni = mode === 'weight' ? Math.round(parseFloat(value) / bitta_vazni) : parseInt(value);
        let hisoblangan_vazni = mode === 'weight' ? parseFloat(value) : hisoblangan_soni * bitta_vazni;

        if (type === 'sub') {
            const stockRes = await pool.query("SELECT jami_soni FROM ombor WHERE model_nomi = $1", [key_name]);
            const bor_soni = stockRes.rows[0] ? stockRes.rows[0].jami_soni : 0;
            if (hisoblangan_soni > bor_soni) return res.status(400).json({ error: `Xatolik! Omborda bor-yo'g'i ${bor_soni} ta kalit bor.` });

            await pool.query("UPDATE ombor SET jami_vazn = GREATEST(0, jami_vazn - $1), jami_soni = GREATEST(0, jami_soni - $2) WHERE model_nomi = $3", [hisoblangan_vazni, hisoblangan_soni, key_name]);
            await pool.query("INSERT INTO tarix (model_nomi, amal_turi, o_zgarish_soni, o_zgarish_vazni) VALUES ($1, 'CHIQIM', $2, $3)", [key_name, hisoblangan_soni, hisoblangan_vazni]);
        } else {
            await pool.query("UPDATE ombor SET jami_vazn = jami_vazn + $1, jami_soni = jami_soni + $2 WHERE model_nomi = $3", [hisoblangan_vazni, hisoblangan_soni, key_name]);
            await pool.query("INSERT INTO tarix (model_nomi, amal_turi, o_zgarish_soni, o_zgarish_vazni) VALUES ($1, 'KIRIM', $2, $3)", [key_name, hisoblangan_soni, hisoblangan_vazni]);
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/stock/:name', async (req, res) => {
    try {
        await pool.query("DELETE FROM ombor WHERE model_nomi = $1", [req.params.name]);
        await pool.query("DELETE FROM andozalar WHERE model_nomi = $1", [req.params.name]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

process.on('uncaughtException', (err) => console.error('Tizim xatoligi (Tutildi):', err.message));
process.on('unhandledRejection', (reason) => console.error('Rad etilish (Tutildi):', reason));

// RENDER PORTNI AVTOMATIK BERADI, AGAR BO'LMASA 3000-PORTNI ESHITADI
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));

