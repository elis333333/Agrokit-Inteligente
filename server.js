// server.js
const express = require("express");
const path = require("path");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const ExcelJS = require("exceljs");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const initSqlJs = require("sql.js");

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "cambiame_por_algo_muy_secreto";

// middlewares
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// HTTP + socket.io
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// -------- DB con sql.js --------
let db;
let SQL;

async function initDB() {
  SQL = await initSqlJs();

  // cargar db desde archivo si existe
  const dbFile = path.join(__dirname, "agrokit.db");
  const filebuffer = fs.existsSync(dbFile) ? fs.readFileSync(dbFile) : null;
  db = filebuffer ? new SQL.Database(filebuffer) : new SQL.Database();

  // crear tablas (si no existen)
  db.run(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password_hash TEXT
    );

    CREATE TABLE IF NOT EXISTS agrokits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      id_agrokit TEXT UNIQUE,
      name TEXT,
      api_key TEXT
    );

    CREATE TABLE IF NOT EXISTS sensores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      id_agrokit TEXT,
      humedad_tierra REAL,
      temp_aire REAL,
      humedad_aire REAL,
      temp_suelo REAL,
      luz REAL,
      presion REAL,
      agua INTEGER,
      gps TEXT,
      bateria REAL,
      fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  console.log("SQLite inicializado con sql.js");
}

// helper: persistir db en disco
function saveDB() {
  try {
    const dbFile = path.join(__dirname, "agrokit.db");
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbFile, buffer);
    console.log("DB guardada en disco ->", dbFile);
  } catch (e) {
    console.error("Error guardando DB:", e);
  }
}

// save on exit signals
function setupGracefulShutdown() {
  const handler = () => {
    console.log("Recibiendo señal de terminación, guardando DB...");
    if (db) saveDB();
    process.exit(0);
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  process.on("exit", () => { if (db) saveDB(); });
}

// helper: auth middleware
function authenticateToken(req, res, next) {
  const auth = req.headers["authorization"];
  if (!auth) return res.status(401).json({ error: "No token" });
  const token = auth.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Token inválido" });
    req.user = user;
    next();
  });
}

// ---------- Health / Ping ----------
app.get("/ping", (req, res) => {
  res.json({ ok: true, serverTime: new Date().toISOString(), dbInitialized: !!db });
});

// ---------- AUTH ----------
app.post("/api/auth/register", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: "Faltan datos" });

  try {
    const stmt = db.prepare(
      "SELECT id FROM usuarios WHERE username = :username"
    );
    stmt.bind({ ":username": username });
    if (stmt.step()) {
      const existing = stmt.getAsObject();
      if (existing.id) return res.status(400).json({ error: "Usuario ya existe" });
    }

    const hash = await bcrypt.hash(password, 10);
    db.run("INSERT INTO usuarios (username, password_hash) VALUES (?, ?)", [username, hash]);
    saveDB();

    res.json({ msg: "Usuario registrado" });
  } catch (e) {
    console.error("Error registro:", e);
    res.status(500).json({ error: "Error servidor" });
  }
});

app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: "Faltan datos" });

  try {
    const stmt = db.prepare(
      "SELECT id, username, password_hash FROM usuarios WHERE username = :username"
    );
    stmt.bind({ ":username": username });
    if (!stmt.step()) return res.status(401).json({ error: "Credenciales inválidas" });
    const row = stmt.getAsObject();

    bcrypt.compare(password, row.password_hash).then((ok) => {
      if (!ok) return res.status(401).json({ error: "Credenciales inválidas" });
      const token = jwt.sign(
        { id: row.id, username: row.username },
        JWT_SECRET,
        { expiresIn: "12h" }
      );
      res.json({ token });
    }).catch(err => {
      console.error("bcrypt error:", err);
      res.status(500).json({ error: "Error servidor" });
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Error DB" });
  }
});

// ---------- Upload sensores ----------
app.post("/api/sensores", (req, res) => {
  const {
    id_agrokit,
    humedad_tierra,
    temp_aire,
    humedad_aire,
    temp_suelo,
    luz,
    presion,
    agua,
    gps,
    bateria,
    fechaHora,
  } = req.body;

  if (!id_agrokit) return res.status(400).json({ error: "Falta id_agrokit" });

  console.log("POST /api/sensores recibido:", JSON.stringify(req.body));

  const gpsText = gps ? JSON.stringify(gps) : null;

  const insertSQL = fechaHora
    ? `INSERT INTO sensores (id_agrokit, humedad_tierra, temp_aire, humedad_aire, temp_suelo, luz, presion, agua, gps, bateria, fecha)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    : `INSERT INTO sensores (id_agrokit, humedad_tierra, temp_aire, humedad_aire, temp_suelo, luz, presion, agua, gps, bateria)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  const params = fechaHora
    ? [
        id_agrokit,
        humedad_tierra ?? null,
        temp_aire ?? null,
        humedad_aire ?? null,
        temp_suelo ?? null,
        luz ?? null,
        presion ?? null,
        agua ?? null,
        gpsText,
        bateria ?? null,
        fechaHora,
      ]
    : [
        id_agrokit,
        humedad_tierra ?? null,
        temp_aire ?? null,
        humedad_aire ?? null,
        temp_suelo ?? null,
        luz ?? null,
        presion ?? null,
        agua ?? null,
        gpsText,
        bateria ?? null,
      ];

  try {
    db.run(insertSQL, params);
    db.run("INSERT OR IGNORE INTO agrokits (id_agrokit, name) VALUES (?, ?)", [id_agrokit, id_agrokit]);
    saveDB();

    // recuperar último registro para debug/respuesta
    const stmt = db.prepare(`SELECT id, id_agrokit, humedad_tierra, temp_aire, humedad_aire, temp_suelo, luz, presion, agua, gps, bateria, fecha as timestamp FROM sensores WHERE id = (SELECT max(id) FROM sensores)`);
    let row = null;
    if (stmt.step()) row = stmt.getAsObject();

    io.emit("nuevo_registro", req.body);
    return res.json({ success: true, registro: row });
  } catch (err) {
    console.error("Insert error:", err);
    return res.status(500).json({ error: "Error al insertar" });
  }
});

// ---------- Get sensores ----------
app.get("/api/sensores/:id_agrokit", (req, res) => {
  const id = req.params.id_agrokit;
  try {
    const stmt = db.prepare(
      `SELECT id, id_agrokit, humedad_tierra, temp_aire, humedad_aire, temp_suelo, luz, presion, agua, fecha as timestamp
       FROM sensores WHERE id_agrokit = :id ORDER BY fecha DESC LIMIT 100`
    );
    stmt.bind({ ":id": id });
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    res.json(rows);
  } catch (err) {
    console.error("DB select error:", err);
    res.status(500).json({ error: "Error DB" });
  }
});

// ---------- Excel ----------
app.get("/api/download/:id_agrokit", authenticateToken, async (req, res) => {
  const id_agrokit = req.params.id_agrokit;
  try {
    const stmt = db.prepare(
      `SELECT id, id_agrokit, humedad_tierra, temp_aire, humedad_aire, temp_suelo, luz, presion, agua, fecha as timestamp
       FROM sensores WHERE id_agrokit = :id ORDER BY fecha DESC`
    );
    stmt.bind({ ":id": id_agrokit });
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Datos");
    sheet.columns = [
      { header: "id", key: "id", width: 8 },
      { header: "id_agrokit", key: "id_agrokit", width: 14 },
      { header: "humedad_tierra", key: "humedad_tierra", width: 16 },
      { header: "temp_aire", key: "temp_aire", width: 12 },
      { header: "humedad_aire", key: "humedad_aire", width: 14 },
      { header: "temp_suelo", key: "temp_suelo", width: 12 },
      { header: "luz", key: "luz", width: 12 },
      { header: "presion", key: "presion", width: 12 },
      { header: "agua", key: "agua", width: 10 },
      { header: "timestamp", key: "timestamp", width: 22 },
    ];
    rows.forEach((r) => sheet.addRow(r));

    const fileName = `agrokit_${id_agrokit}_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=${fileName}`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("Excel error:", err);
    res.status(500).json({ error: "Error DB" });
  }
});

// ---------- Agrokits ----------
app.get("/api/agrokits", authenticateToken, (req, res) => {
  try {
    const stmt = db.prepare("SELECT id_agrokit, name FROM agrokits");
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    res.json(rows);
  } catch (err) {
    console.error("DB error:", err);
    res.status(500).json({ error: "DB error" });
  }
});

// socket.io
io.on("connection", (socket) => {
  console.log("Cliente conectado:", socket.id);
  socket.on("disconnect", () => console.log("Cliente desconectado:", socket.id));
});

// start
initDB().then(() => {
  setupGracefulShutdown();
  server.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error("Fallo inicializando DB:", err);
  process.exit(1);
});















// // server.js
// const express = require("express");
// const sqlite3 = require("sqlite3").verbose();
// const path = require("path");
// const cors = require("cors");
// const bcrypt = require("bcrypt");
// const jwt = require("jsonwebtoken");
// const ExcelJS = require("exceljs");
// const http = require("http");
// const { Server } = require("socket.io");

// const app = express();
// const PORT = process.env.PORT || 3000;
// const JWT_SECRET = process.env.JWT_SECRET || "cambiame_por_algo_muy_secreto";

// app.use(cors());
// app.use(express.json());
// app.use(express.static(path.join(__dirname, "public")));

// // create HTTP server + socket.io (so socket is available to routes)
// const server = http.createServer(app);
// const io = new Server(server, {
//   cors: { origin: "*", methods: ["GET", "POST"] }
// });

// // DB setup
// const DB_FILE = path.join(__dirname, "agrokit.db");
// const db = new sqlite3.Database(DB_FILE, (err) => {
//   if (err) return console.error("DB open error:", err);
//   console.log("SQLite DB:", DB_FILE);
// });

// db.serialize(() => {
//   db.run(`CREATE TABLE IF NOT EXISTS usuarios (
//     id INTEGER PRIMARY KEY AUTOINCREMENT,
//     username TEXT UNIQUE,
//     password_hash TEXT
//   )`);
//   db.run(`CREATE TABLE IF NOT EXISTS agrokits (
//     id INTEGER PRIMARY KEY AUTOINCREMENT,
//     id_agrokit TEXT UNIQUE,
//     name TEXT,
//     api_key TEXT
//   )`);
//   db.run(`CREATE TABLE IF NOT EXISTS sensores (
//     id INTEGER PRIMARY KEY AUTOINCREMENT,
//     id_agrokit TEXT,
//     humedad_tierra REAL,
//     temp_aire REAL,
//     humedad_aire REAL,
//     temp_suelo REAL,
//     luz REAL,
//     presion REAL,
//     agua INTEGER,
//     fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
//   )`);
// });

// // Helper: auth middleware
// function authenticateToken(req, res, next) {
//   const auth = req.headers["authorization"];
//   if (!auth) return res.status(401).json({ error: "No token" });
//   const token = auth.split(" ")[1];
//   if (!token) return res.status(401).json({ error: "No token" });
//   jwt.verify(token, JWT_SECRET, (err, user) => {
//     if (err) return res.status(403).json({ error: "Token inválido" });
//     req.user = user;
//     next();
//   });
// }

// // ---------- AUTH ----------
// app.post("/api/auth/register", async (req, res) => {
//   const { username, password } = req.body;
//   if (!username || !password) return res.status(400).json({ error: "Faltan datos" });
//   try {
//     const hash = await bcrypt.hash(password, 10);
//     db.run("INSERT INTO usuarios (username, password_hash) VALUES (?, ?)", [username, hash], function (err) {
//       if (err) return res.status(400).json({ error: "Usuario ya existe" });
//       res.json({ msg: "Usuario registrado" });
//     });
//   } catch (e) {
//     res.status(500).json({ error: "Error servidor" });
//   }
// });

// app.post("/api/auth/login", (req, res) => {
//   const { username, password } = req.body;
//   if (!username || !password) return res.status(400).json({ error: "Faltan datos" });

//   db.get("SELECT * FROM usuarios WHERE username = ?", [username], async (err, row) => {
//     if (err) return res.status(500).json({ error: "DB error" });
//     if (!row) return res.status(401).json({ error: "Credenciales inválidas" });
//     const ok = await bcrypt.compare(password, row.password_hash);
//     if (!ok) return res.status(401).json({ error: "Credenciales inválidas" });
//     const token = jwt.sign({ id: row.id, username: row.username }, JWT_SECRET, { expiresIn: "12h" });
//     res.json({ token });
//   });
// });

// // ---------- Upload desde ESP32 (público) ----------
// /*
//  JSON esperado (fecha opcional "fechaHora"):
//  {
//    "id_agrokit":"KIT123",
//    "humedad_tierra":20,
//    "temp_aire":27,
//    "humedad_aire":60,
//    "temp_suelo":22,
//    "luz":350,
//    "presion":1012,
//    "agua":1,
//    "fechaHora":"2025-08-18 00:12:34"
//  }
// */
// app.post("/api/sensores", (req, res) => {
//   const {
//     id_agrokit,
//     humedad_tierra,
//     temp_aire,
//     humedad_aire,
//     temp_suelo,
//     luz,
//     presion,
//     agua,
//     fechaHora
//   } = req.body;

//   if (!id_agrokit) return res.status(400).json({ error: "Falta id_agrokit" });

//   const insertWithDate = !!fechaHora;
//   const params = insertWithDate
//     ? [id_agrokit, humedad_tierra ?? null, temp_aire ?? null, humedad_aire ?? null, temp_suelo ?? null, luz ?? null, presion ?? null, agua ?? null, fechaHora]
//     : [id_agrokit, humedad_tierra ?? null, temp_aire ?? null, humedad_aire ?? null, temp_suelo ?? null, luz ?? null, presion ?? null, agua ?? null];

//   const sql = insertWithDate
//     ? `INSERT INTO sensores (id_agrokit, humedad_tierra, temp_aire, humedad_aire, temp_suelo, luz, presion, agua, fecha)
//        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
//     : `INSERT INTO sensores (id_agrokit, humedad_tierra, temp_aire, humedad_aire, temp_suelo, luz, presion, agua)
//        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

//   db.run(sql, params, function (err) {
//     if (err) {
//       console.error("Insert error:", err);
//       return res.status(500).json({ error: "Error al insertar" });
//     }

//     // registrar agrokit si no existe
//     db.run("INSERT OR IGNORE INTO agrokits (id_agrokit, name) VALUES (?, ?)", [id_agrokit, id_agrokit]);

//     // obtener el registro insertado y emitirlo por socket.io para tiempo real
//     const lastId = this.lastID;
//     db.get(
//       `SELECT id, id_agrokit, humedad_tierra, temp_aire, humedad_aire, temp_suelo, luz, presion, agua, fecha as timestamp
//        FROM sensores WHERE id = ?`, [lastId], (e, row) => {
//       if (!e && row) {
//         // emitimos evento global; los clientes filtrarán por id_agrokit si quieren
//         io.emit("nuevo_registro", row);
//       }
//     });

//     res.json({ success: true, id: this.lastID });
//   });
// });

// // ---------- Get datos por id_agrokit ----------
// app.get("/api/sensores/:id_agrokit", (req, res) => {
//   const id = req.params.id_agrokit;
//   db.all(
//     `SELECT id, id_agrokit, humedad_tierra, temp_aire, humedad_aire, temp_suelo, luz, presion, agua, fecha as timestamp
//      FROM sensores
//      WHERE id_agrokit = ?
//      ORDER BY fecha DESC
//      LIMIT 100`,
//     [id],
//     (err, rows) => {
//       if (err) {
//         console.error("DB select error:", err);
//         return res.status(500).json({ error: "Error DB" });
//       }
//       res.json(rows);
//     }
//   );
// });

// // ---------- Descargar Excel (PROTEGIDO) ----------
// app.get("/api/download/:id_agrokit", authenticateToken, (req, res) => {
//   const id_agrokit = req.params.id_agrokit;
//   db.all(
//     `SELECT id, id_agrokit, humedad_tierra, temp_aire, humedad_aire, temp_suelo, luz, presion, agua, fecha as timestamp
//      FROM sensores
//      WHERE id_agrokit = ?
//      ORDER BY fecha DESC`,
//     [id_agrokit],
//     async (err, rows) => {
//       if (err) {
//         console.error("DB select error:", err);
//         return res.status(500).json({ error: "Error DB" });
//       }

//       const workbook = new ExcelJS.Workbook();
//       const sheet = workbook.addWorksheet("Datos");
//       sheet.columns = [
//         { header: "id", key: "id", width: 8 },
//         { header: "id_agrokit", key: "id_agrokit", width: 14 },
//         { header: "humedad_tierra", key: "humedad_tierra", width: 16 },
//         { header: "temp_aire", key: "temp_aire", width: 12 },
//         { header: "humedad_aire", key: "humedad_aire", width: 14 },
//         { header: "temp_suelo", key: "temp_suelo", width: 12 },
//         { header: "luz", key: "luz", width: 12 },
//         { header: "presion", key: "presion", width: 12 },
//         { header: "agua", key: "agua", width: 10 },
//         { header: "timestamp", key: "timestamp", width: 22 }
//       ];
//       rows.forEach(r => sheet.addRow(r));

//       const fileName = `agrokit_${id_agrokit}_${new Date().toISOString().slice(0,10)}.xlsx`;
//       res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
//       res.setHeader("Content-Disposition", `attachment; filename=${fileName}`);
//       await workbook.xlsx.write(res);
//       res.end();
//     }
//   );
// });

// // ---------- Listar agrokits (PROTEGIDO) ----------
// app.get("/api/agrokits", authenticateToken, (req, res) => {
//   db.all("SELECT id_agrokit, name FROM agrokits", [], (err, rows) => {
//     if (err) return res.status(500).json({ error: "DB error" });
//     res.json(rows);
//   });
// });

// // socket.io connection logging
// io.on("connection", (socket) => {
//   console.log("Cliente socket conectado:", socket.id);
//   socket.on("disconnect", () => {
//     console.log("Socket desconectado:", socket.id);
//   });
// });

// // start server (http + socket.io)
// server.listen(PORT, () => {
//   console.log(`Servidor corriendo en http://localhost:${PORT}`);
// });














