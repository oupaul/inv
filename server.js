// 載入環境變數
require('dotenv').config();

const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const path = require('path');
const ExcelJS = require('exceljs');
const multer = require('multer');
const fs = require('fs');
const argon2 = require('argon2');

const app = express();
const PORT = process.env.PORT || 5000;
const PAGE_TITLE = process.env.PAGE_TITLE || '庫存管理系統';
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, 'backups');

// 初始化資料庫
let db = new Database('inventory.db');
db.pragma('journal_mode = WAL');

// 檢查是否有待還原的備份檔案（伺服器啟動時）
const restoreDbPath = path.join(__dirname, 'inventory.db.restore');
if (fs.existsSync(restoreDbPath)) {
    try {
        console.log('⚠️  偵測到待還原的備份檔案，正在執行還原...');
        const dbPath = path.join(__dirname, 'inventory.db');
        const dbWalPath = path.join(__dirname, 'inventory.db-wal');
        const dbShmPath = path.join(__dirname, 'inventory.db-shm');
        
        // 關閉現有連接
        db.close();
        
        // 刪除 WAL 和 SHM 檔案
        if (fs.existsSync(dbWalPath)) {
            fs.unlinkSync(dbWalPath);
        }
        if (fs.existsSync(dbShmPath)) {
            fs.unlinkSync(dbShmPath);
        }
        
        // 備份當前資料庫（額外安全措施）
        if (fs.existsSync(dbPath)) {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            fs.copyFileSync(dbPath, path.join(__dirname, 'inventory.db.backup.' + timestamp));
        }
        
        // 還原備份
        fs.renameSync(restoreDbPath, dbPath);
        
        // 重新初始化資料庫連接
        db = new Database('inventory.db');
        db.pragma('journal_mode = WAL');
        
        console.log('✅ 備份還原完成！');
    } catch (error) {
        console.error('❌ 備份還原失敗:', error);
        // 嘗試重新連接原始資料庫
        try {
            db = new Database('inventory.db');
            db.pragma('journal_mode = WAL');
        } catch (e) {
            console.error('❌ 無法重新連接資料庫:', e);
        }
    }
}

// 檢查欄位是否存在
function columnExists(tableName, columnName) {
    try {
        const info = db.prepare(`PRAGMA table_info(${tableName})`).all();
        return info.some(col => col.name === columnName);
    } catch (e) {
        return false;
    }
}

// 創建資料表
function initDB() {
    // 料件類型表
    db.exec(`
        CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            description TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    // 單位表
    db.exec(`
        CREATE TABLE IF NOT EXISTS units (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            symbol TEXT,
            description TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    // 插入預設單位
    const defaultUnits = [
        { name: '個', symbol: '個' },
        { name: '支', symbol: '支' },
        { name: '片', symbol: '片' },
        { name: '組', symbol: '組' },
        { name: '箱', symbol: '箱' },
        { name: '包', symbol: '包' },
        { name: 'kg', symbol: 'kg' },
        { name: '公升', symbol: 'L' }
    ];
    
    const insertUnit = db.prepare('INSERT OR IGNORE INTO units (name, symbol) VALUES (?, ?)');
    defaultUnits.forEach(unit => {
        insertUnit.run(unit.name, unit.symbol);
    });
    
    // 料件表
    db.exec(`
        CREATE TABLE IF NOT EXISTS parts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            part_number TEXT UNIQUE NOT NULL,
            part_name TEXT NOT NULL,
            specification TEXT,
            unit TEXT DEFAULT '個',
            category_id INTEGER,
            barcode TEXT UNIQUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (category_id) REFERENCES categories (id)
        )
    `);
    
    // 為現有資料庫添加新欄位（如果不存在）
    if (!columnExists('parts', 'category_id')) {
        try {
            db.exec(`ALTER TABLE parts ADD COLUMN category_id INTEGER`);
        } catch (e) {
            console.error('添加 category_id 欄位失敗:', e.message);
        }
    }
    
    if (!columnExists('parts', 'barcode')) {
        try {
            db.exec(`ALTER TABLE parts ADD COLUMN barcode TEXT`);
            // 添加唯一約束（如果可能）
            try {
                db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_parts_barcode ON parts(barcode) WHERE barcode IS NOT NULL AND barcode != ''`);
            } catch (e) {
                // 如果無法創建唯一索引，至少確保欄位存在
                console.warn('無法創建條碼唯一索引:', e.message);
            }
        } catch (e) {
            console.error('添加 barcode 欄位失敗:', e.message);
        }
    }
    
    // 入庫記錄表
    db.exec(`
        CREATE TABLE IF NOT EXISTS inbound_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            part_id INTEGER NOT NULL,
            quantity INTEGER NOT NULL,
            inbound_date DATE NOT NULL,
            note TEXT,
            is_return INTEGER DEFAULT 0,
            return_outbound_id INTEGER,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (part_id) REFERENCES parts (id),
            FOREIGN KEY (return_outbound_id) REFERENCES outbound_records (id)
        )
    `);
    
    // 為現有資料庫添加 is_return 和 return_outbound_id 欄位（如果不存在）
    if (!columnExists('inbound_records', 'is_return')) {
        try {
            db.exec(`ALTER TABLE inbound_records ADD COLUMN is_return INTEGER DEFAULT 0`);
        } catch (e) {
            console.error('添加 is_return 欄位失敗:', e.message);
        }
    }
    
    if (!columnExists('inbound_records', 'return_outbound_id')) {
        try {
            db.exec(`ALTER TABLE inbound_records ADD COLUMN return_outbound_id INTEGER`);
        } catch (e) {
            console.error('添加 return_outbound_id 欄位失敗:', e.message);
        }
    }
    
    // 為現有資料庫添加 created_by 欄位（如果不存在）
    if (!columnExists('inbound_records', 'created_by')) {
        try {
            db.exec(`ALTER TABLE inbound_records ADD COLUMN created_by TEXT`);
        } catch (e) {
            console.error('添加 inbound_records.created_by 欄位失敗:', e.message);
        }
    }
    
    // 出庫記錄表
    db.exec(`
        CREATE TABLE IF NOT EXISTS outbound_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            part_id INTEGER NOT NULL,
            quantity INTEGER NOT NULL,
            outbound_date DATE NOT NULL,
            note TEXT,
            is_loan INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (part_id) REFERENCES parts (id)
        )
    `);
    
    // 為現有資料庫添加 is_loan 欄位（如果不存在）
    if (!columnExists('outbound_records', 'is_loan')) {
        try {
            db.exec(`ALTER TABLE outbound_records ADD COLUMN is_loan INTEGER DEFAULT 0`);
        } catch (e) {
            console.error('添加 is_loan 欄位失敗:', e.message);
        }
    }
    
    // 為現有資料庫添加借測到期日期欄位（如果不存在）
    if (!columnExists('outbound_records', 'loan_due_date')) {
        try {
            db.exec(`ALTER TABLE outbound_records ADD COLUMN loan_due_date DATE`);
        } catch (e) {
            console.error('添加 loan_due_date 欄位失敗:', e.message);
        }
    }
    
    // 為現有資料庫添加通知狀態欄位（如果不存在）
    if (!columnExists('outbound_records', 'notification_sent')) {
        try {
            db.exec(`ALTER TABLE outbound_records ADD COLUMN notification_sent INTEGER DEFAULT 0`);
        } catch (e) {
            console.error('添加 notification_sent 欄位失敗:', e.message);
        }
    }
    
    // 為現有資料庫添加 created_by 欄位（如果不存在）
    if (!columnExists('outbound_records', 'created_by')) {
        try {
            db.exec(`ALTER TABLE outbound_records ADD COLUMN created_by TEXT`);
        } catch (e) {
            console.error('添加 outbound_records.created_by 欄位失敗:', e.message);
        }
    }
    
    // 盤點事件表（每個盤點事件代表一次完整的盤點作業）
    db.exec(`
        CREATE TABLE IF NOT EXISTS inventory_check_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_date DATE NOT NULL UNIQUE,
            session_name TEXT,
            status TEXT DEFAULT 'in_progress',
            created_by TEXT,
            completed_at TIMESTAMP,
            note TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    // 盤點記錄表（關聯到盤點事件，記錄每個料件在該次盤點中的情況）
    // 注意：保留 system_quantity 欄位以向後兼容，但新邏輯使用 previous_quantity
    db.exec(`
        CREATE TABLE IF NOT EXISTS inventory_checks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER,
            part_id INTEGER NOT NULL,
            check_date DATE,
            system_quantity INTEGER,
            previous_quantity INTEGER,
            actual_quantity INTEGER NOT NULL,
            difference INTEGER NOT NULL,
            note TEXT,
            created_by TEXT,
            is_adjusted INTEGER DEFAULT 0,
            adjustment_note TEXT,
            adjusted_at TIMESTAMP,
            adjusted_by TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (part_id) REFERENCES parts (id)
        )
    `);
    
    // 為現有資料庫添加 session_id 欄位（如果不存在）
    if (!columnExists('inventory_checks', 'session_id')) {
        try {
            db.exec(`ALTER TABLE inventory_checks ADD COLUMN session_id INTEGER`);
        } catch (e) {
            console.error('添加 session_id 欄位失敗:', e.message);
        }
    }
    
    // 為現有資料庫添加 previous_quantity 欄位（如果不存在）
    if (!columnExists('inventory_checks', 'previous_quantity')) {
        try {
            db.exec(`ALTER TABLE inventory_checks ADD COLUMN previous_quantity INTEGER`);
            // 將現有的 system_quantity 複製到 previous_quantity（如果有）
            try {
                db.exec(`UPDATE inventory_checks SET previous_quantity = system_quantity WHERE previous_quantity IS NULL AND system_quantity IS NOT NULL`);
            } catch (e) {
                // 如果 system_quantity 不存在，忽略錯誤
            }
        } catch (e) {
            console.error('添加 previous_quantity 欄位失敗:', e.message);
        }
    }
    
    // 確保現有記錄的 system_quantity 不為 NULL（如果資料庫有舊的 NOT NULL 約束）
    try {
        // 對於 system_quantity 為 NULL 的記錄，使用 previous_quantity 或 0
        db.exec(`
            UPDATE inventory_checks 
            SET system_quantity = COALESCE(previous_quantity, 0) 
            WHERE system_quantity IS NULL
        `);
    } catch (e) {
        // 如果更新失敗（可能是因為約束或其他原因），忽略錯誤
        console.log('更新現有記錄的 system_quantity 失敗（可能不需要）:', e.message);
    }
    
    // 嘗試添加外鍵約束（如果可能）
    try {
        db.exec(`CREATE INDEX IF NOT EXISTS idx_inventory_checks_session_id ON inventory_checks(session_id)`);
    } catch (e) {
        // 忽略錯誤
    }
    
    // 為現有資料庫添加調整相關欄位（如果不存在）
    if (!columnExists('inventory_checks', 'is_adjusted')) {
        try {
            db.exec(`ALTER TABLE inventory_checks ADD COLUMN is_adjusted INTEGER DEFAULT 0`);
        } catch (e) {
            console.error('添加 is_adjusted 欄位失敗:', e.message);
        }
    }
    
    if (!columnExists('inventory_checks', 'adjustment_note')) {
        try {
            db.exec(`ALTER TABLE inventory_checks ADD COLUMN adjustment_note TEXT`);
        } catch (e) {
            console.error('添加 adjustment_note 欄位失敗:', e.message);
        }
    }
    
    if (!columnExists('inventory_checks', 'adjusted_at')) {
        try {
            db.exec(`ALTER TABLE inventory_checks ADD COLUMN adjusted_at TIMESTAMP`);
        } catch (e) {
            console.error('添加 adjusted_at 欄位失敗:', e.message);
        }
    }
    
    if (!columnExists('inventory_checks', 'adjusted_by')) {
        try {
            db.exec(`ALTER TABLE inventory_checks ADD COLUMN adjusted_by TEXT`);
        } catch (e) {
            console.error('添加 adjusted_by 欄位失敗:', e.message);
        }
    }
    
    // 用戶表
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            full_name TEXT,
            email TEXT,
            role TEXT DEFAULT 'user',
            is_active INTEGER DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    // 角色表
    db.exec(`
        CREATE TABLE IF NOT EXISTS roles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            role_name TEXT UNIQUE NOT NULL,
            display_name TEXT NOT NULL,
            description TEXT,
            permissions TEXT,
            is_system INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    // 操作記錄表
    db.exec(`
        CREATE TABLE IF NOT EXISTS activity_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            username TEXT,
            action_type TEXT NOT NULL,
            action_detail TEXT,
            target_type TEXT,
            target_id INTEGER,
            ip_address TEXT,
            user_agent TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    `);
    
    // 插入預設角色
    const checkRoles = db.prepare('SELECT COUNT(*) as count FROM roles');
    const rolesCount = checkRoles.get();
    
    if (!rolesCount || rolesCount.count === 0) {
        const insertRole = db.prepare(`
            INSERT INTO roles (role_name, display_name, description, permissions, is_system)
            VALUES (?, ?, ?, ?, ?)
        `);
        
        insertRole.run('admin', '系統管理員', '擁有所有系統權限', JSON.stringify({
            users: ['view', 'create', 'edit', 'delete'],
            parts: ['view', 'create', 'edit', 'delete'],
            inventory: ['view', 'inbound', 'outbound', 'check'],
            system: ['backup', 'health', 'roles', 'logs']
        }), 1);
        
        insertRole.run('manager', '管理人員', '可管理料件和庫存', JSON.stringify({
            users: ['view'],
            parts: ['view', 'create', 'edit'],
            inventory: ['view', 'inbound', 'outbound', 'check'],
            system: []
        }), 1);
        
        insertRole.run('user', '一般使用者', '可查看和基本操作', JSON.stringify({
            users: [],
            parts: ['view'],
            inventory: ['view', 'inbound', 'outbound'],
            system: []
        }), 1);
        
        console.log('✅ 預設角色已創建');
    }
    
    // 創建預設管理員帳號（如果不存在）
    const checkAdmin = db.prepare('SELECT COUNT(*) as count FROM users WHERE username = ?');
    const adminExists = checkAdmin.get('admin');
    
    if (!adminExists || adminExists.count === 0) {
        // 使用 argon2id 加密預設密碼 "admin123"
        // 注意：首次啟動時會同步創建，這裡先創建一個臨時密碼
        // 實際密碼會在首次啟動時通過異步方式創建
        console.log('⚠️  正在創建預設管理員帳號...');
    }
}

// 異步創建預設管理員帳號
async function createDefaultAdmin() {
    try {
        const checkAdmin = db.prepare('SELECT COUNT(*) as count FROM users WHERE username = ?');
        const adminExists = checkAdmin.get('admin');
        
        if (!adminExists || adminExists.count === 0) {
            // 預設帳號：admin，密碼：admin123
            const defaultPassword = 'admin123';
            const passwordHash = await argon2.hash(defaultPassword, { type: argon2.argon2id });
            
            const insertAdmin = db.prepare(`
                INSERT INTO users (username, password_hash, full_name, email, role, is_active)
                VALUES (?, ?, ?, ?, ?, ?)
            `);
            insertAdmin.run('admin', passwordHash, '系統管理員', null, 'admin', 1);
            
            console.log('✅ 預設管理員帳號已創建！');
            console.log('   帳號：admin');
            console.log('   密碼：admin123');
            console.log('   ⚠️  請在首次登入後立即修改密碼！');
        }
    } catch (error) {
        console.error('創建預設管理員帳號失敗:', error.message);
    }
}

initDB();
createDefaultAdmin();

// 設定中介軟體
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// 設定檔案上傳
const upload = multer({ 
    dest: 'uploads/',
    fileFilter: (req, file, cb) => {
        const allowedMimes = [
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/vnd.ms-excel',
            'text/csv'
        ];
        if (allowedMimes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('只允許上傳 Excel 檔案 (.xlsx, .xls)'));
        }
    },
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// 確保上傳目錄存在
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}
app.use(session({
    secret: process.env.SESSION_SECRET || 'your-secret-key-here-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24小時
}));

// Flash message 中介軟體
app.use((req, res, next) => {
    res.locals.messages = req.session.messages || [];
    req.session.messages = [];
    res.locals.user = req.session.user || null;
    next();
});

// Helper function for flash messages
function flash(req, category, message) {
    if (!req.session.messages) {
        req.session.messages = [];
    }
    req.session.messages.push({ category, message });
}

// Helper function for activity logging
function logActivity(req, actionType, actionDetail, targetType = null, targetId = null) {
    try {
        const userId = req.session.user ? req.session.user.id : null;
        const username = req.session.user ? req.session.user.username : 'anonymous';
        const ipAddress = req.ip || req.connection.remoteAddress;
        const userAgent = req.get('user-agent') || '';
        
        const stmt = db.prepare(`
            INSERT INTO activity_logs (user_id, username, action_type, action_detail, target_type, target_id, ip_address, user_agent)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        
        stmt.run(userId, username, actionType, actionDetail, targetType, targetId, ipAddress, userAgent);
    } catch (error) {
        console.error('記錄操作日誌失敗:', error);
    }
}

// 認證中介軟體（可選，用於保護特定路由）
function requireAuth(req, res, next) {
    if (req.session.user) {
        next();
    } else {
        flash(req, 'error', '請先登入');
        res.redirect('/login');
    }
}

// 管理員權限檢查
function requireAdmin(req, res, next) {
    if (req.session.user && req.session.user.role === 'admin') {
        next();
    } else {
        flash(req, 'error', '需要管理員權限');
        res.redirect('/');
    }
}

// 登入頁面（不需要認證）
app.get('/login', (req, res) => {
    // 如果已經登入，重定向到首頁
    if (req.session.user) {
        return res.redirect('/');
    }
    res.render('login', { title: PAGE_TITLE, user: null });
});

// 登入處理
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        flash(req, 'error', '請輸入帳號和密碼');
        return res.redirect('/login');
    }
    
    try {
        const stmt = db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1');
        const user = stmt.get(username);
        
        if (!user) {
            flash(req, 'error', '帳號或密碼錯誤');
            return res.redirect('/login');
        }
        
        const isValid = await argon2.verify(user.password_hash, password);
        
        if (!isValid) {
            flash(req, 'error', '帳號或密碼錯誤');
            return res.redirect('/login');
        }
        
        // 設置 session
        req.session.user = {
            id: user.id,
            username: user.username,
            full_name: user.full_name,
            email: user.email,
            role: user.role
        };
        
        // 記錄登入操作
        logActivity(req, 'login', `使用者 ${user.username} 登入系統`, 'user', user.id);
        
        flash(req, 'success', `歡迎回來，${user.full_name || user.username}！`);
        res.redirect('/');
    } catch (error) {
        flash(req, 'error', `登入失敗：${error.message}`);
        res.redirect('/login');
    }
});

// 登出
app.post('/logout', (req, res) => {
    // 記錄登出操作
    if (req.session.user) {
        logActivity(req, 'logout', `使用者 ${req.session.user.username} 登出系統`, 'user', req.session.user.id);
    }
    
    req.session.destroy((err) => {
        if (err) {
            console.error('登出錯誤:', err);
        }
        res.redirect('/login');
    });
});

// 修改密碼頁面
app.get('/change-password', requireAuth, (req, res) => {
    try {
        res.render('change_password', {
            title: PAGE_TITLE
        });
    } catch (error) {
        console.error('載入修改密碼頁面錯誤:', error);
        flash(req, 'error', '載入頁面失敗');
        res.redirect('/');
    }
});

// 處理修改密碼
app.post('/change-password', requireAuth, async (req, res) => {
    const { current_password, new_password, confirm_password } = req.body;
    const userId = req.session.user.id;
    
    try {
        // 驗證必填欄位
        if (!current_password || !new_password || !confirm_password) {
            flash(req, 'error', '請填寫所有必填欄位');
            return res.redirect('/change-password');
        }
        
        // 驗證新密碼長度
        if (new_password.length < 6) {
            flash(req, 'error', '新密碼長度至少需要 6 個字元');
            return res.redirect('/change-password');
        }
        
        // 驗證新密碼與確認密碼是否相符
        if (new_password !== confirm_password) {
            flash(req, 'error', '新密碼與確認密碼不相符');
            return res.redirect('/change-password');
        }
        
        // 驗證新密碼不能與舊密碼相同
        if (current_password === new_password) {
            flash(req, 'error', '新密碼不能與目前密碼相同');
            return res.redirect('/change-password');
        }
        
        // 獲取使用者資料
        const stmt = db.prepare('SELECT * FROM users WHERE id = ?');
        const user = stmt.get(userId);
        
        if (!user) {
            flash(req, 'error', '使用者不存在');
            return res.redirect('/change-password');
        }
        
        // 驗證目前密碼
        const isValid = await argon2.verify(user.password_hash, current_password);
        if (!isValid) {
            flash(req, 'error', '目前密碼錯誤');
            return res.redirect('/change-password');
        }
        
        // 產生新密碼的雜湊值
        const newPasswordHash = await argon2.hash(new_password, { type: argon2.argon2id });
        
        // 更新密碼
        const updateStmt = db.prepare(`
            UPDATE users 
            SET password_hash = ?, updated_at = CURRENT_TIMESTAMP 
            WHERE id = ?
        `);
        updateStmt.run(newPasswordHash, userId);
        
        // 記錄活動
        logActivity(req, 'update', '修改密碼', 'user', userId);
        
        flash(req, 'success', '密碼修改成功！');
        res.redirect('/');
        
    } catch (error) {
        console.error('修改密碼錯誤:', error);
        flash(req, 'error', '修改密碼失敗，請稍後再試');
        res.redirect('/change-password');
    }
});

// 全局認證保護（除了登入和登出路由）
app.use((req, res, next) => {
    // 排除登入和登出路由
    if (req.path === '/login' || req.path === '/logout') {
        return next();
    }
    
    // 排除 API 路由（如果需要公開訪問）
    if (req.path.startsWith('/api/')) {
        return next();
    }
    
    // 檢查是否已登入
    if (!req.session.user) {
        flash(req, 'error', '請先登入才能訪問此頁面');
        return res.redirect('/login');
    }
    
    next();
});

// 首頁 - 顯示庫存
app.get('/', requireAuth, (req, res) => {
    const { search, category_id } = req.query;
    
    let whereConditions = [];
    let params = [];
    
    if (search && search.trim()) {
        whereConditions.push(`(p.part_number LIKE ? OR p.part_name LIKE ? OR p.barcode LIKE ? OR c.name LIKE ?)`);
        const searchTerm = `%${search.trim()}%`;
        params.push(searchTerm, searchTerm, searchTerm, searchTerm);
    }
    
    if (category_id && category_id !== '') {
        whereConditions.push(`p.category_id = ?`);
        params.push(category_id);
    }
    
    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
    
    const stmt = db.prepare(`
        SELECT 
            p.id,
            p.part_number,
            p.part_name,
            p.specification,
            p.unit,
            p.barcode,
            c.name as category_name,
            COALESCE((SELECT SUM(quantity) FROM inbound_records WHERE part_id = p.id AND (is_return = 0 OR is_return IS NULL)), 0) - 
            COALESCE((SELECT SUM(quantity) FROM outbound_records WHERE part_id = p.id AND (is_loan = 0 OR is_loan IS NULL)), 0) as total_quantity,
            COALESCE((
                SELECT SUM(o.quantity) - COALESCE(SUM(i.quantity), 0)
                FROM outbound_records o
                LEFT JOIN inbound_records i ON i.return_outbound_id = o.id
                WHERE o.part_id = p.id AND o.is_loan = 1
            ), 0) as loaned_quantity
        FROM parts p
        LEFT JOIN categories c ON p.category_id = c.id
        ${whereClause}
        ORDER BY p.part_number
    `);
    
    const inventory = stmt.all(...params);
    
    // 獲取所有類型用於下拉選單
    const categoriesStmt = db.prepare('SELECT * FROM categories ORDER BY name');
    const categories = categoriesStmt.all();
    
    res.render('index', { 
        inventory, 
        categories,
        search: search || '',
        category_id: category_id || '',
        user: req.session.user,
        title: PAGE_TITLE 
    });
});

// 料件類型管理 - 列表
app.get('/categories', (req, res) => {
    const stmt = db.prepare('SELECT * FROM categories ORDER BY name');
    const categories = stmt.all();
    logActivity(req, 'view', '查看料件類型列表', 'categories', null);
    res.render('categories_list', { categories, title: PAGE_TITLE });
});

// 料件類型管理 - 新增頁面
app.get('/categories/add', (req, res) => {
    res.render('add_category', { title: PAGE_TITLE });
});

// 料件類型管理 - 新增處理
app.post('/categories/add', (req, res) => {
    const { name, description } = req.body;
    
    try {
        const stmt = db.prepare('INSERT INTO categories (name, description) VALUES (?, ?)');
        const result = stmt.run(name, description || null);
        
        logActivity(req, 'create', `新增料件類型：${name}`, 'category', result.lastInsertRowid);
        flash(req, 'success', '類型新增成功！');
        res.redirect('/categories');
    } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            flash(req, 'error', '類型名稱已存在！');
        } else {
            flash(req, 'error', `新增失敗：${error.message}`);
        }
        res.redirect('/categories/add');
    }
});

// 料件類型管理 - 編輯頁面
app.get('/categories/edit/:id', (req, res) => {
    const { id } = req.params;
    const stmt = db.prepare('SELECT * FROM categories WHERE id = ?');
    const category = stmt.get(id);
    
    if (!category) {
        flash(req, 'error', '類型不存在！');
        return res.redirect('/categories');
    }
    
    res.render('edit_category', { category, title: PAGE_TITLE });
});

// 料件類型管理 - 編輯處理
app.post('/categories/edit/:id', (req, res) => {
    const { id } = req.params;
    const { name, description } = req.body;
    
    try {
        const stmt = db.prepare('UPDATE categories SET name = ?, description = ? WHERE id = ?');
        stmt.run(name, description || null, id);
        
        logActivity(req, 'update', `編輯料件類型：${name}`, 'category', parseInt(id));
        flash(req, 'success', '類型更新成功！');
        res.redirect('/categories');
    } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            flash(req, 'error', '類型名稱已存在！');
        } else {
            flash(req, 'error', `更新失敗：${error.message}`);
        }
        res.redirect(`/categories/edit/${id}`);
    }
});

// 料件類型管理 - 刪除
app.post('/categories/delete/:id', (req, res) => {
    const { id } = req.params;
    
    try {
        // 檢查是否有料件使用此類型
        const checkStmt = db.prepare('SELECT COUNT(*) as count FROM parts WHERE category_id = ?');
        const result = checkStmt.get(id);
        
        if (result.count > 0) {
            flash(req, 'error', `無法刪除：仍有 ${result.count} 個料件使用此類型！`);
            return res.redirect('/categories');
        }
        
        const categoryStmt = db.prepare('SELECT name FROM categories WHERE id = ?');
        const category = categoryStmt.get(id);
        const categoryName = category ? category.name : '未知';
        
        const stmt = db.prepare('DELETE FROM categories WHERE id = ?');
        stmt.run(id);
        
        logActivity(req, 'delete', `刪除料件類型：${categoryName}`, 'category', parseInt(id));
        flash(req, 'success', '類型刪除成功！');
        res.redirect('/categories');
    } catch (error) {
        flash(req, 'error', `刪除失敗：${error.message}`);
        res.redirect('/categories');
    }
});

// 單位管理 - 列表
app.get('/units', (req, res) => {
    const stmt = db.prepare('SELECT * FROM units ORDER BY name');
    const units = stmt.all();
    logActivity(req, 'view', '查看單位列表', 'units', null);
    res.render('units_list', { units, title: PAGE_TITLE });
});

// 單位管理 - 新增頁面
app.get('/units/add', (req, res) => {
    res.render('add_unit', { title: PAGE_TITLE });
});

// 單位管理 - 新增處理
app.post('/units/add', (req, res) => {
    const { name, symbol, description } = req.body;
    
    try {
        const stmt = db.prepare('INSERT INTO units (name, symbol, description) VALUES (?, ?, ?)');
        const result = stmt.run(name, symbol || name, description || null);
        
        logActivity(req, 'create', `新增單位：${name}`, 'unit', result.lastInsertRowid);
        flash(req, 'success', '單位新增成功！');
        res.redirect('/units');
    } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            flash(req, 'error', '單位名稱已存在！');
        } else {
            flash(req, 'error', `新增失敗：${error.message}`);
        }
        res.redirect('/units/add');
    }
});

// 單位管理 - 編輯頁面
app.get('/units/edit/:id', (req, res) => {
    const { id } = req.params;
    const stmt = db.prepare('SELECT * FROM units WHERE id = ?');
    const unit = stmt.get(id);
    
    if (!unit) {
        flash(req, 'error', '單位不存在！');
        return res.redirect('/units');
    }
    
    res.render('edit_unit', { unit, title: PAGE_TITLE });
});

// 單位管理 - 編輯處理
app.post('/units/edit/:id', (req, res) => {
    const { id } = req.params;
    const { name, symbol, description } = req.body;
    
    try {
        const stmt = db.prepare('UPDATE units SET name = ?, symbol = ?, description = ? WHERE id = ?');
        stmt.run(name, symbol || name, description || null, id);
        
        logActivity(req, 'update', `編輯單位：${name}`, 'unit', parseInt(id));
        flash(req, 'success', '單位更新成功！');
        res.redirect('/units');
    } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            flash(req, 'error', '單位名稱已存在！');
        } else {
            flash(req, 'error', `更新失敗：${error.message}`);
        }
        res.redirect(`/units/edit/${id}`);
    }
});

// 單位管理 - 刪除
app.post('/units/delete/:id', (req, res) => {
    const { id } = req.params;
    
    try {
        // 檢查是否有料件使用此單位
        const checkStmt = db.prepare('SELECT COUNT(*) as count FROM parts WHERE unit = (SELECT name FROM units WHERE id = ?)');
        const result = checkStmt.get(id);
        
        if (result.count > 0) {
            flash(req, 'error', `無法刪除：仍有 ${result.count} 個料件使用此單位！`);
            return res.redirect('/units');
        }
        
        const unitStmt = db.prepare('SELECT name FROM units WHERE id = ?');
        const unit = unitStmt.get(id);
        const unitName = unit ? unit.name : '未知';
        
        const stmt = db.prepare('DELETE FROM units WHERE id = ?');
        stmt.run(id);
        
        logActivity(req, 'delete', `刪除單位：${unitName}`, 'unit', parseInt(id));
        flash(req, 'success', '單位刪除成功！');
        res.redirect('/units');
    } catch (error) {
        flash(req, 'error', `刪除失敗：${error.message}`);
        res.redirect('/units');
    }
});

// 料件列表
app.get('/parts', (req, res) => {
    const { search, category_id } = req.query;
    
    let whereConditions = [];
    let params = [];
    
    if (search && search.trim()) {
        whereConditions.push(`(p.part_number LIKE ? OR p.part_name LIKE ? OR p.barcode LIKE ? OR p.specification LIKE ? OR c.name LIKE ?)`);
        const searchTerm = `%${search.trim()}%`;
        params.push(searchTerm, searchTerm, searchTerm, searchTerm, searchTerm);
    }
    
    if (category_id && category_id !== '') {
        whereConditions.push(`p.category_id = ?`);
        params.push(category_id);
    }
    
    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
    
    const stmt = db.prepare(`
        SELECT p.*, c.name as category_name 
        FROM parts p 
        LEFT JOIN categories c ON p.category_id = c.id 
        ${whereClause}
        ORDER BY p.part_number
    `);
    const parts = stmt.all(...params);
    
    // 獲取所有類型用於下拉選單
    const categoriesStmt = db.prepare('SELECT * FROM categories ORDER BY name');
    const categories = categoriesStmt.all();
    
    res.render('parts_list', { 
        parts, 
        categories,
        search: search || '',
        category_id: category_id || '',
        user: req.session.user,
        title: PAGE_TITLE 
    });
});

// 新增料件頁面
app.get('/parts/add', (req, res) => {
    const categoriesStmt = db.prepare('SELECT * FROM categories ORDER BY name');
    const categories = categoriesStmt.all();
    const unitsStmt = db.prepare('SELECT * FROM units ORDER BY name');
    const units = unitsStmt.all();
    res.render('add_part', { categories, units, title: PAGE_TITLE });
});

// 新增料件處理
app.post('/parts/add', (req, res) => {
    const { part_number, part_name, specification, unit, category_id, barcode, new_category_name, new_unit_name } = req.body;
    
    try {
        let finalCategoryId = category_id || null;
        let finalUnit = unit || '個';
        
        // 如果選擇了新增類型，先創建類型
        if (category_id === '__new__' && new_category_name && new_category_name.trim()) {
            const categoryName = new_category_name.trim();
            
            // 檢查類型是否已存在
            const checkCategoryStmt = db.prepare('SELECT id FROM categories WHERE name = ?');
            const existingCategory = checkCategoryStmt.get(categoryName);
            
            if (existingCategory) {
                // 類型已存在，使用現有的 ID
                finalCategoryId = existingCategory.id;
            } else {
                // 創建新類型
                const insertCategoryStmt = db.prepare('INSERT INTO categories (name) VALUES (?)');
                const result = insertCategoryStmt.run(categoryName);
                finalCategoryId = result.lastInsertRowid;
            }
        }
        
        // 如果選擇了新增單位，先創建單位
        if (unit === '__new__' && new_unit_name && new_unit_name.trim()) {
            const unitName = new_unit_name.trim();
            
            // 檢查單位是否已存在
            const checkUnitStmt = db.prepare('SELECT name FROM units WHERE name = ?');
            const existingUnit = checkUnitStmt.get(unitName);
            
            if (!existingUnit) {
                // 創建新單位
                const insertUnitStmt = db.prepare('INSERT INTO units (name, symbol) VALUES (?, ?)');
                insertUnitStmt.run(unitName, unitName);
            }
            
            // 使用新單位名稱
            finalUnit = unitName;
        }
        
        const stmt = db.prepare(`
            INSERT INTO parts (part_number, part_name, specification, unit, category_id, barcode)
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        const result = stmt.run(
            part_number, 
            part_name, 
            specification || null, 
            finalUnit, 
            finalCategoryId,
            barcode || null
        );
        
        logActivity(req, 'create', `新增料件：${part_number} - ${part_name}`, 'part', result.lastInsertRowid);
        flash(req, 'success', '料件新增成功！');
        res.redirect('/parts');
    } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            if (error.message.includes('barcode')) {
                flash(req, 'error', '條碼已存在！');
            } else {
            flash(req, 'error', '料號已存在！');
            }
        } else {
            flash(req, 'error', `新增失敗：${error.message}`);
        }
        res.redirect('/parts/add');
    }
});

// 編輯料件頁面
app.get('/parts/edit/:id', (req, res) => {
    const { id } = req.params;
    const stmt = db.prepare('SELECT * FROM parts WHERE id = ?');
    const part = stmt.get(id);
    
    if (!part) {
        flash(req, 'error', '料件不存在！');
        return res.redirect('/parts');
    }
    
    const categoriesStmt = db.prepare('SELECT * FROM categories ORDER BY name');
    const categories = categoriesStmt.all();
    const unitsStmt = db.prepare('SELECT * FROM units ORDER BY name');
    const units = unitsStmt.all();
    
    res.render('edit_part', { part, categories, units, title: PAGE_TITLE });
});

// 編輯料件處理
app.post('/parts/edit/:id', (req, res) => {
    const { id } = req.params;
    const { part_number, part_name, specification, unit, category_id, barcode, new_category_name, new_unit_name } = req.body;
    
    try {
        let finalCategoryId = category_id || null;
        let finalUnit = unit || '個';
        
        // 如果選擇了新增類型，先創建類型
        if (category_id === '__new__' && new_category_name && new_category_name.trim()) {
            const categoryName = new_category_name.trim();
            
            // 檢查類型是否已存在
            const checkCategoryStmt = db.prepare('SELECT id FROM categories WHERE name = ?');
            const existingCategory = checkCategoryStmt.get(categoryName);
            
            if (existingCategory) {
                // 類型已存在，使用現有的 ID
                finalCategoryId = existingCategory.id;
            } else {
                // 創建新類型
                const insertCategoryStmt = db.prepare('INSERT INTO categories (name) VALUES (?)');
                const result = insertCategoryStmt.run(categoryName);
                finalCategoryId = result.lastInsertRowid;
            }
        }
        
        // 如果選擇了新增單位，先創建單位
        if (unit === '__new__' && new_unit_name && new_unit_name.trim()) {
            const unitName = new_unit_name.trim();
            
            // 檢查單位是否已存在
            const checkUnitStmt = db.prepare('SELECT name FROM units WHERE name = ?');
            const existingUnit = checkUnitStmt.get(unitName);
            
            if (!existingUnit) {
                // 創建新單位
                const insertUnitStmt = db.prepare('INSERT INTO units (name, symbol) VALUES (?, ?)');
                insertUnitStmt.run(unitName, unitName);
            }
            
            // 使用新單位名稱
            finalUnit = unitName;
        }
        
        const stmt = db.prepare(`
            UPDATE parts 
            SET part_number = ?, part_name = ?, specification = ?, unit = ?, category_id = ?, barcode = ?
            WHERE id = ?
        `);
        stmt.run(
            part_number,
            part_name,
            specification || null,
            finalUnit,
            finalCategoryId,
            barcode || null,
            id
        );
        
        logActivity(req, 'update', `編輯料件：${part_number} - ${part_name}`, 'part', parseInt(id));
        flash(req, 'success', '料件更新成功！');
        res.redirect('/parts');
    } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            if (error.message.includes('barcode')) {
                flash(req, 'error', '條碼已存在！');
            } else {
                flash(req, 'error', '料號已存在！');
            }
        } else {
            flash(req, 'error', `更新失敗：${error.message}`);
        }
        res.redirect(`/parts/edit/${id}`);
    }
});

// 條碼查詢 API
app.get('/api/barcode/:barcode', (req, res) => {
    const { barcode } = req.params;
    const stmt = db.prepare(`
        SELECT p.*, c.name as category_name, c.id as category_id
        FROM parts p 
        LEFT JOIN categories c ON p.category_id = c.id 
        WHERE p.barcode = ?
    `);
    const part = stmt.get(barcode);
    
    if (part) {
        res.json({ success: true, part });
    } else {
        res.json({ success: false, message: '找不到對應的料件' });
    }
});

// 入庫頁面
app.get('/inbound', (req, res) => {
    const stmt = db.prepare(`
        SELECT p.*, c.name as category_name 
        FROM parts p 
        LEFT JOIN categories c ON p.category_id = c.id 
        ORDER BY p.part_number
    `);
    const parts = stmt.all();
    
    const today = new Date().toISOString().split('T')[0];
    res.render('inbound', { parts, today, title: PAGE_TITLE });
});

// 入庫處理
app.post('/inbound', (req, res) => {
    const { part_id, quantity, inbound_date, note, is_return, return_outbound_id } = req.body;
    const isReturn = is_return === 'on' || is_return === 'true' ? 1 : 0;
    const returnOutboundId = return_outbound_id ? parseInt(return_outbound_id) : null;
    const createdBy = req.session.user ? (req.session.user.full_name || req.session.user.username) : '系統';
    
    try {
        const stmt = db.prepare(`
            INSERT INTO inbound_records (part_id, quantity, inbound_date, note, is_return, return_outbound_id, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        const result = stmt.run(part_id, quantity, inbound_date, note || null, isReturn, returnOutboundId, createdBy);
        
        const partStmt = db.prepare('SELECT part_number, part_name FROM parts WHERE id = ?');
        const part = partStmt.get(part_id);
        const partInfo = part ? `${part.part_number} - ${part.part_name}` : `料件ID: ${part_id}`;
        
        logActivity(req, isReturn ? 'return' : 'inbound', `${isReturn ? '歸還' : '入庫'}：${partInfo}，數量：${quantity}`, 'inbound_record', result.lastInsertRowid);
        flash(req, 'success', isReturn ? '歸還記錄成功！' : '入庫記錄成功！');
        res.redirect('/');
    } catch (error) {
        flash(req, 'error', `入庫失敗：${error.message}`);
        res.redirect('/inbound');
    }
});

// API: 查詢料件的未歸還借測記錄
app.get('/api/loan-records/:part_id', (req, res) => {
    const { part_id } = req.params;
    
    try {
        const stmt = db.prepare(`
            SELECT 
                o.id,
                o.part_id,
                o.quantity,
                o.outbound_date,
                o.note,
                o.created_at,
                p.part_number,
                p.part_name,
                COALESCE(SUM(i.quantity), 0) as returned_quantity,
                o.quantity - COALESCE(SUM(i.quantity), 0) as remaining_quantity
            FROM outbound_records o
            JOIN parts p ON o.part_id = p.id
            LEFT JOIN inbound_records i ON i.return_outbound_id = o.id
            WHERE o.part_id = ? AND o.is_loan = 1
            GROUP BY o.id
            HAVING remaining_quantity > 0
            ORDER BY o.outbound_date DESC
        `);
        
        const records = stmt.all(part_id);
        res.json({ success: true, records });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// 入庫記錄查詢（保留舊路由以兼容）
app.get('/inbound/records', (req, res) => {
    res.redirect('/transaction/records?type=inbound');
});

// 合併的出入庫記錄查詢（含搜尋功能）
app.get('/transaction/records', requireAuth, (req, res) => {
    logActivity(req, 'view', '查看交易記錄', 'transaction_records', null);
    const { search, type, date_from, date_to } = req.query;
    
    let records = [];
    
    // 構建入庫記錄查詢
    let inboundQuery = `
        SELECT 
            ir.inbound_date as transaction_date,
            CASE 
                WHEN ir.is_return = 1 THEN 'return'
                ELSE 'inbound'
            END as type,
            p.part_number,
            p.part_name,
            ir.quantity,
            p.unit,
            ir.note,
            ir.created_by,
            ir.created_at
        FROM inbound_records ir
        JOIN parts p ON ir.part_id = p.id
        WHERE 1=1
    `;
    let inboundParams = [];
    
    // 構建出庫記錄查詢
    let outboundQuery = `
        SELECT 
            o.outbound_date as transaction_date,
            CASE 
                WHEN o.is_loan = 1 THEN 'loan'
                ELSE 'outbound'
            END as type,
            p.part_number,
            p.part_name,
            o.quantity,
            p.unit,
            o.note,
            o.created_by,
            o.created_at
        FROM outbound_records o
        JOIN parts p ON o.part_id = p.id
        WHERE 1=1
    `;
    let outboundParams = [];
    
    // 搜尋條件
    if (search && search.trim()) {
        const searchTerm = `%${search.trim()}%`;
        inboundQuery += ` AND (p.part_number LIKE ? OR p.part_name LIKE ? OR p.barcode LIKE ?)`;
        inboundParams.push(searchTerm, searchTerm, searchTerm);
        outboundQuery += ` AND (p.part_number LIKE ? OR p.part_name LIKE ? OR p.barcode LIKE ?)`;
        outboundParams.push(searchTerm, searchTerm, searchTerm);
    }
    
    // 日期範圍
    if (date_from) {
        inboundQuery += ` AND ir.inbound_date >= ?`;
        inboundParams.push(date_from);
        outboundQuery += ` AND o.outbound_date >= ?`;
        outboundParams.push(date_from);
    }
    if (date_to) {
        inboundQuery += ` AND ir.inbound_date <= ?`;
        inboundParams.push(date_to);
        outboundQuery += ` AND o.outbound_date <= ?`;
        outboundParams.push(date_to);
    }
    
    // 類型條件
    if (type === 'inbound') {
        inboundQuery += ` AND (ir.is_return = 0 OR ir.is_return IS NULL)`;
    } else if (type === 'outbound') {
        outboundQuery += ` AND (o.is_loan = 0 OR o.is_loan IS NULL)`;
    } else if (type === 'return') {
        inboundQuery += ` AND ir.is_return = 1`;
    } else if (type === 'loan') {
        outboundQuery += ` AND o.is_loan = 1`;
    }
    
    // 執行查詢
    if (!type || type === 'inbound' || type === 'return') {
        const inboundStmt = db.prepare(inboundQuery);
        const inboundRecords = inboundStmt.all(...inboundParams);
        records = records.concat(inboundRecords);
    }
    
    if (!type || type === 'outbound' || type === 'loan') {
        const outboundStmt = db.prepare(outboundQuery);
        const outboundRecords = outboundStmt.all(...outboundParams);
        records = records.concat(outboundRecords);
    }
    
    // 排序
    records.sort((a, b) => {
        const dateCompare = new Date(b.transaction_date) - new Date(a.transaction_date);
        if (dateCompare !== 0) return dateCompare;
        return new Date(b.created_at) - new Date(a.created_at);
    });
    
    // 限制數量
    records = records.slice(0, 500);
    
    res.render('transaction_records', { 
        records, 
        search: search || '',
        type: type || '',
        date_from: date_from || '',
        date_to: date_to || '',
        user: req.session.user,
        title: PAGE_TITLE 
    });
});

// 出庫頁面
app.get('/outbound', (req, res) => {
    // 可出庫數量計算邏輯：
    // 可出庫數量 = 總入庫（非歸還） - 非借測出庫 - (借測出庫總數 - 已歸還的借測數量)
    //          = 總入庫（非歸還） - 非借測出庫 - 借測出庫總數 + 已歸還的借測數量
    // 借測商品雖然不減少庫存記錄（is_loan=1），但實際上已經從倉庫中借出，所以應該從可出庫數量中扣除
    // 如果借測商品被歸還了（is_return=1 且 return_outbound_id 對應借測記錄），則應該加回來
    const stmt = db.prepare(`
        SELECT 
            p.*, 
            c.name as category_name, 
            c.id as category_id,
            -- 可出庫數量 = 總入庫（非歸還）- 非借測出庫 - 借測出庫總數 + 已歸還的借測數量
            COALESCE((SELECT SUM(quantity) FROM inbound_records WHERE part_id = p.id AND (is_return = 0 OR is_return IS NULL)), 0) - 
            COALESCE((SELECT SUM(quantity) FROM outbound_records WHERE part_id = p.id AND (is_loan = 0 OR is_loan IS NULL)), 0) - 
            COALESCE((SELECT SUM(quantity) FROM outbound_records WHERE part_id = p.id AND is_loan = 1), 0) + 
            COALESCE((
                SELECT SUM(i.quantity) 
                FROM inbound_records i
                JOIN outbound_records o ON i.return_outbound_id = o.id
                WHERE o.part_id = p.id AND o.is_loan = 1 AND i.is_return = 1
            ), 0) as current_stock
        FROM parts p 
        LEFT JOIN categories c ON p.category_id = c.id
        WHERE (
            COALESCE((SELECT SUM(quantity) FROM inbound_records WHERE part_id = p.id AND (is_return = 0 OR is_return IS NULL)), 0) - 
            COALESCE((SELECT SUM(quantity) FROM outbound_records WHERE part_id = p.id AND (is_loan = 0 OR is_loan IS NULL)), 0) - 
            COALESCE((SELECT SUM(quantity) FROM outbound_records WHERE part_id = p.id AND is_loan = 1), 0) + 
            COALESCE((
                SELECT SUM(i.quantity) 
                FROM inbound_records i
                JOIN outbound_records o ON i.return_outbound_id = o.id
                WHERE o.part_id = p.id AND o.is_loan = 1 AND i.is_return = 1
            ), 0)
        ) > 0
        ORDER BY p.part_number
    `);
    const parts = stmt.all();
    
    // 獲取所有類別（用於篩選）
    const categoriesStmt = db.prepare('SELECT * FROM categories ORDER BY name');
    const categories = categoriesStmt.all();
    
    const today = new Date().toISOString().split('T')[0];
    res.render('outbound', { parts, categories, today, title: PAGE_TITLE });
});

// 出庫處理
app.post('/outbound', (req, res) => {
    const { part_id, quantity, outbound_date, note, is_loan, loan_due_date } = req.body;
    const isLoan = is_loan === 'on' || is_loan === 'true' ? 1 : 0;
    const qty = parseInt(quantity) || 0;
    
    if (!part_id || qty <= 0) {
        flash(req, 'error', '請選擇料件並輸入有效的出庫數量！');
        return res.redirect('/outbound');
    }
    
    try {
        // 檢查庫存是否足夠
        // 可出庫數量 = 總入庫（非歸還）- 非借測出庫 - 借測出庫總數 + 已歸還的借測數量
        // 借測商品雖然不減少庫存記錄（is_loan=1），但實際上已經從倉庫中借出，所以應該從可出庫數量中扣除
        // 如果借測商品被歸還了（is_return=1 且 return_outbound_id 對應借測記錄），則應該加回來
        const stockStmt = db.prepare(`
            SELECT 
                COALESCE((SELECT SUM(quantity) FROM inbound_records WHERE part_id = ? AND (is_return = 0 OR is_return IS NULL)), 0) - 
                COALESCE((SELECT SUM(quantity) FROM outbound_records WHERE part_id = ? AND (is_loan = 0 OR is_loan IS NULL)), 0) - 
                COALESCE((SELECT SUM(quantity) FROM outbound_records WHERE part_id = ? AND is_loan = 1), 0) + 
                COALESCE((
                    SELECT SUM(i.quantity) 
                    FROM inbound_records i
                    JOIN outbound_records o ON i.return_outbound_id = o.id
                    WHERE o.part_id = ? AND o.is_loan = 1 AND i.is_return = 1
                ), 0) as available_stock
        `);
        const stock = stockStmt.get(part_id, part_id, part_id, part_id);
        const availableStock = stock ? (stock.available_stock || 0) : 0;
        
        if (availableStock < qty) {
            flash(req, 'error', `庫存不足！可用庫存：${availableStock}，需要：${qty}`);
            return res.redirect('/outbound');
        }
        
        // 如果是借測，檢查是否提供了到期日期
        if (isLoan && (!loan_due_date || loan_due_date.trim() === '')) {
            flash(req, 'error', '借測必須填寫到期日期！');
            return res.redirect('/outbound');
        }
        
        const createdBy = req.session.user ? (req.session.user.full_name || req.session.user.username) : '系統';
        
        const stmt = db.prepare(`
            INSERT INTO outbound_records (part_id, quantity, outbound_date, note, is_loan, loan_due_date, notification_sent, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const result = stmt.run(
            part_id, 
            qty, 
            outbound_date, 
            note || null, 
            isLoan,
            (isLoan && loan_due_date) ? loan_due_date : null,
            0,  // 預設未發送通知
            createdBy
        );
        
        const partStmt = db.prepare('SELECT part_number, part_name FROM parts WHERE id = ?');
        const part = partStmt.get(part_id);
        const partInfo = part ? `${part.part_number} - ${part.part_name}` : `料件ID: ${part_id}`;
        
        logActivity(req, isLoan ? 'loan' : 'outbound', `${isLoan ? '借測' : '出庫'}：${partInfo}，數量：${qty}`, 'outbound_record', result.lastInsertRowid);
        flash(req, 'success', isLoan ? '借測記錄成功！' : '出庫記錄成功！');
        res.redirect('/');
    } catch (error) {
        flash(req, 'error', `出庫失敗：${error.message}`);
        res.redirect('/outbound');
    }
});

// 出庫記錄查詢（保留舊路由以兼容，重定向到合併頁面）
app.get('/outbound/records', (req, res) => {
    res.redirect('/transaction/records?type=outbound');
});

// API: 獲取到期通知
app.get('/api/loan-notifications', requireAuth, (req, res) => {
    try {
        // 獲取已過期、今日到期、以及3天內即將到期的借測記錄
        const stmt = db.prepare(`
            SELECT 
                o.id,
                o.outbound_date as loan_date,
                o.loan_due_date,
                o.notification_sent,
                p.part_number,
                p.part_name,
                p.unit,
                o.quantity - COALESCE(SUM(i.quantity), 0) as remaining_quantity,
                CASE 
                    WHEN date(o.loan_due_date) < date('now') THEN 'overdue'
                    WHEN date(o.loan_due_date) = date('now') THEN 'due_today'
                    WHEN date(o.loan_due_date) <= date('now', '+3 days') THEN 'due_soon'
                    ELSE 'normal'
                END as due_status,
                CASE 
                    WHEN o.loan_due_date IS NULL THEN NULL
                    ELSE julianday(o.loan_due_date) - julianday('now')
                END as days_until_due
            FROM outbound_records o
            JOIN parts p ON o.part_id = p.id
            LEFT JOIN inbound_records i ON i.return_outbound_id = o.id
            WHERE o.is_loan = 1 
                AND o.loan_due_date IS NOT NULL
                AND (date(o.loan_due_date) <= date('now', '+3 days'))
            GROUP BY o.id
            HAVING remaining_quantity > 0
            ORDER BY 
                CASE 
                    WHEN date(o.loan_due_date) < date('now') THEN 0
                    WHEN date(o.loan_due_date) = date('now') THEN 1
                    ELSE 2
                END,
                o.loan_due_date ASC
        `);
        
        const notifications = stmt.all();
        
        // 統計各類型通知數量
        const stats = {
            overdue: notifications.filter(n => n.due_status === 'overdue').length,
            due_today: notifications.filter(n => n.due_status === 'due_today').length,
            due_soon: notifications.filter(n => n.due_status === 'due_soon').length,
            total: notifications.length
        };
        
        res.json({ success: true, notifications, stats });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// 標記通知已讀（更新 notification_sent）
app.post('/api/loan-notifications/:id/mark-read', requireAuth, (req, res) => {
    const { id } = req.params;
    
    try {
        const stmt = db.prepare('UPDATE outbound_records SET notification_sent = 1 WHERE id = ?');
        stmt.run(id);
        res.json({ success: true });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// 借出中料件列表
app.get('/loans', requireAuth, (req, res) => {
    const stmt = db.prepare(`
        SELECT 
            o.id,
            o.part_id,
            o.quantity as loaned_quantity,
            o.outbound_date as loan_date,
            o.loan_due_date,
            o.notification_sent,
            o.note as loan_note,
            o.created_at as loan_created_at,
            p.part_number,
            p.part_name,
            p.specification,
            p.unit,
            p.barcode,
            c.name as category_name,
            COALESCE(SUM(i.quantity), 0) as returned_quantity,
            o.quantity - COALESCE(SUM(i.quantity), 0) as remaining_quantity,
            CASE 
                WHEN o.quantity - COALESCE(SUM(i.quantity), 0) = o.quantity THEN '未歸還'
                WHEN o.quantity - COALESCE(SUM(i.quantity), 0) > 0 THEN '部分歸還'
                ELSE '已歸還'
            END as status,
            CASE 
                WHEN o.loan_due_date IS NULL THEN '無到期日期'
                WHEN date(o.loan_due_date) < date('now') THEN '已過期'
                WHEN date(o.loan_due_date) = date('now') THEN '今日到期'
                WHEN date(o.loan_due_date) <= date('now', '+3 days') THEN '即將到期'
                ELSE '正常'
            END as due_status,
            CASE 
                WHEN o.loan_due_date IS NULL THEN NULL
                ELSE julianday(o.loan_due_date) - julianday('now')
            END as days_until_due
        FROM outbound_records o
        JOIN parts p ON o.part_id = p.id
        LEFT JOIN categories c ON p.category_id = c.id
        LEFT JOIN inbound_records i ON i.return_outbound_id = o.id
        WHERE o.is_loan = 1
        GROUP BY o.id
        HAVING remaining_quantity > 0
        ORDER BY 
            CASE 
                WHEN o.loan_due_date IS NULL THEN 999
                WHEN date(o.loan_due_date) < date('now') THEN 0
                WHEN date(o.loan_due_date) = date('now') THEN 1
                WHEN date(o.loan_due_date) <= date('now', '+3 days') THEN 2
                ELSE 3
            END,
            o.loan_due_date ASC,
            o.outbound_date DESC
    `);
    
    const records = stmt.all();
    res.render('loan_records', { records, user: req.session.user, title: PAGE_TITLE });
});

// 盤點事件管理 - 列表頁面
app.get('/inventory/check/sessions', requireAuth, (req, res) => {
    logActivity(req, 'view', '查看盤點事件列表', 'inventory_check_sessions', null);
    const stmt = db.prepare(`
        SELECT 
            ics.*,
            COUNT(DISTINCT ic.part_id) as item_count,
            COUNT(DISTINCT CASE WHEN ic.difference != 0 THEN ic.id END) as difference_count
        FROM inventory_check_sessions ics
        LEFT JOIN inventory_checks ic ON ics.id = ic.session_id
        GROUP BY ics.id
        ORDER BY ics.session_date DESC, ics.created_at DESC
    `);
    
    const sessions = stmt.all();
    res.render('inventory_check_sessions', { 
        sessions, 
        user: req.session.user, 
        title: PAGE_TITLE 
    });
});

// 盤點事件管理 - 創建新盤點事件
app.post('/inventory/check/sessions/create', requireAuth, (req, res) => {
    const { session_date, session_name, note } = req.body;
    const created_by = req.session.user ? (req.session.user.full_name || req.session.user.username) : '系統';
    
    try {
        if (!session_date) {
            flash(req, 'error', '請選擇盤點日期！');
            return res.redirect('/inventory/check/sessions');
        }
        
        // 檢查該日期是否已有盤點事件
        const checkStmt = db.prepare('SELECT id FROM inventory_check_sessions WHERE session_date = ?');
        const existing = checkStmt.get(session_date);
        
        if (existing) {
            flash(req, 'error', '該日期已存在盤點事件！');
            return res.redirect('/inventory/check/sessions');
        }
        
        const stmt = db.prepare(`
            INSERT INTO inventory_check_sessions (session_date, session_name, status, created_by, note)
            VALUES (?, ?, 'in_progress', ?, ?)
        `);
        const result = stmt.run(session_date, session_name || `${session_date} 盤點`, created_by, note || null);
        
        logActivity(req, 'create', `創建盤點事件：${session_name || session_date}`, 'inventory_check_session', result.lastInsertRowid);
        flash(req, 'success', '盤點事件創建成功！');
        res.redirect(`/inventory/check?session_date=${session_date}`);
    } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            flash(req, 'error', '該日期已存在盤點事件！');
        } else {
            flash(req, 'error', `創建失敗：${error.message}`);
        }
        res.redirect('/inventory/check/sessions');
    }
});

// 盤點事件管理 - 完成盤點事件
app.post('/inventory/check/sessions/:id/complete', requireAuth, (req, res) => {
    const { id } = req.params;
    const completed_by = req.session.user ? (req.session.user.full_name || req.session.user.username) : '系統';
    
    try {
        const sessionStmt = db.prepare('SELECT session_name FROM inventory_check_sessions WHERE id = ?');
        const session = sessionStmt.get(id);
        const sessionName = session ? session.session_name : '未知';
        
        const stmt = db.prepare(`
            UPDATE inventory_check_sessions 
            SET status = 'completed', completed_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `);
        stmt.run(id);
        
        logActivity(req, 'update', `完成盤點事件：${sessionName}`, 'inventory_check_session', parseInt(id));
        flash(req, 'success', '盤點事件已完成！');
        res.redirect('/inventory/check/sessions');
    } catch (error) {
        flash(req, 'error', `完成失敗：${error.message}`);
        res.redirect('/inventory/check/sessions');
    }
});

// 庫存盤點頁面（基於盤點事件）
app.get('/inventory/check', requireAuth, (req, res) => {
    const { session_date } = req.query;
    
    // 獲取當前進行中的盤點事件，或使用指定的日期
    let currentSession = null;
    if (session_date) {
        const sessionStmt = db.prepare('SELECT * FROM inventory_check_sessions WHERE session_date = ?');
        currentSession = sessionStmt.get(session_date);
    } else {
        // 獲取最新的進行中事件
        const activeSessionStmt = db.prepare(`
            SELECT * FROM inventory_check_sessions 
            WHERE status = 'in_progress' 
            ORDER BY session_date DESC 
            LIMIT 1
        `);
        currentSession = activeSessionStmt.get();
    }
    
    // 獲取所有盤點事件列表（用於選擇）
    const sessionsStmt = db.prepare(`
        SELECT * FROM inventory_check_sessions 
        ORDER BY session_date DESC 
        LIMIT 20
    `);
    const allSessions = sessionsStmt.all();
    
    // 如果沒有進行中的盤點事件，提示創建
    if (!currentSession) {
        // 仍然顯示料件列表，但提示需要創建盤點事件
        const partsStmt = db.prepare(`
            SELECT 
                p.id,
                p.part_number,
                p.part_name,
                p.specification,
                p.unit,
                p.barcode,
                c.name as category_name,
                COALESCE((SELECT SUM(quantity) FROM inbound_records WHERE part_id = p.id AND (is_return = 0 OR is_return IS NULL)), 0) - 
                COALESCE((SELECT SUM(quantity) FROM outbound_records WHERE part_id = p.id AND (is_loan = 0 OR is_loan IS NULL)), 0) as system_quantity
            FROM parts p
            LEFT JOIN categories c ON p.category_id = c.id
            ORDER BY p.part_number
        `);
        const parts = partsStmt.all();
        const today = new Date().toISOString().split('T')[0];
        
        return res.render('inventory_check', { 
            parts, 
            today, 
            currentSession: null,
            allSessions: [],
            user: req.session.user, 
            title: PAGE_TITLE 
        });
    }
    
    // 獲取該盤點事件中已盤點的料件
    const checkedPartsStmt = db.prepare(`
        SELECT part_id, actual_quantity 
        FROM inventory_checks 
        WHERE session_id = ?
    `);
    const checkedParts = checkedPartsStmt.all(currentSession.id);
    const checkedPartsMap = {};
    checkedParts.forEach(cp => {
        checkedPartsMap[cp.part_id] = cp.actual_quantity;
    });
    
    // 獲取所有料件，並查找上次盤點的數量
    const partsStmt = db.prepare(`
        SELECT 
            p.id,
            p.part_number,
            p.part_name,
            p.specification,
            p.unit,
            p.barcode,
            c.name as category_name,
            (SELECT actual_quantity 
             FROM inventory_checks ic2
             JOIN inventory_check_sessions ics2 ON ic2.session_id = ics2.id
             WHERE ic2.part_id = p.id 
               AND ics2.session_date < ?
               AND ics2.status = 'completed'
             ORDER BY ics2.session_date DESC 
             LIMIT 1) as previous_check_quantity
        FROM parts p
        LEFT JOIN categories c ON p.category_id = c.id
        ORDER BY p.part_number
    `);
    const parts = partsStmt.all(currentSession.session_date);
    
    // 如果沒有上次盤點記錄，使用系統庫存作為基準
    parts.forEach(part => {
        if (!part.previous_check_quantity && part.previous_check_quantity !== 0) {
            const stockStmt = db.prepare(`
                SELECT 
                    COALESCE((SELECT SUM(quantity) FROM inbound_records WHERE part_id = ? AND (is_return = 0 OR is_return IS NULL)), 0) - 
                    COALESCE((SELECT SUM(quantity) FROM outbound_records WHERE part_id = ? AND (is_loan = 0 OR is_loan IS NULL)), 0) as system_quantity
            `);
            const stock = stockStmt.get(part.id, part.id);
            part.previous_check_quantity = stock ? stock.system_quantity : 0;
        }
        // 如果本次已盤點，使用已盤點的數量
        if (checkedPartsMap[part.id] !== undefined) {
            part.current_check_quantity = checkedPartsMap[part.id];
        }
    });
    
    const today = new Date().toISOString().split('T')[0];
    res.render('inventory_check', { 
        parts, 
        today, 
        currentSession,
        allSessions,
        user: req.session.user, 
        title: PAGE_TITLE 
    });
});

// 批量盤點處理（連續掃描模式）
app.post('/inventory/check/batch', requireAuth, (req, res) => {
    const { session_id, session_date, items, auto_adjust } = req.body;
    const created_by = req.session.user ? (req.session.user.full_name || req.session.user.username) : '系統';
    const shouldAutoAdjust = auto_adjust === 'true';
    
    try {
        // 解析批量盤點項目
        let batchItems = [];
        try {
            batchItems = typeof items === 'string' ? JSON.parse(items) : items;
        } catch (e) {
            flash(req, 'error', '盤點資料格式錯誤！');
            return res.redirect('/inventory/check');
        }
        
        if (!Array.isArray(batchItems) || batchItems.length === 0) {
            flash(req, 'error', '盤點清單為空！');
            return res.redirect('/inventory/check');
        }
        
        // 驗證盤點事件是否存在
        let currentSessionId = session_id ? parseInt(session_id) : null;
        
        if (!currentSessionId && session_date) {
            const sessionStmt = db.prepare('SELECT id FROM inventory_check_sessions WHERE session_date = ?');
            let session = sessionStmt.get(session_date);
            
            if (!session) {
                const createSessionStmt = db.prepare(`
                    INSERT INTO inventory_check_sessions (session_date, session_name, status, created_by)
                    VALUES (?, ?, 'in_progress', ?)
                `);
                const sessionResult = createSessionStmt.run(session_date, `${session_date} 盤點`, created_by);
                currentSessionId = sessionResult.lastInsertRowid;
            } else {
                currentSessionId = session.id;
            }
        }
        
        if (!currentSessionId) {
            flash(req, 'error', '請先創建盤點事件！');
            return res.redirect('/inventory/check/sessions');
        }
        
        // 獲取盤點事件的日期
        const sessionDateStmt = db.prepare('SELECT session_date FROM inventory_check_sessions WHERE id = ?');
        const sessionDate = sessionDateStmt.get(currentSessionId).session_date;
        
        let successCount = 0;
        let errorCount = 0;
        let adjustedCount = 0;
        
        // 使用事務處理批量盤點
        const transaction = db.transaction(() => {
            for (const item of batchItems) {
                try {
                    const { part_id, actual_quantity, previous_quantity } = item;
                    const actualQty = parseInt(actual_quantity) || 0;
                    const prevQty = parseInt(previous_quantity) || 0;
                    const difference = actualQty - prevQty;
                    
                    // 獲取當前系統庫存（用於向後兼容）
                    const stockStmt = db.prepare(`
                        SELECT 
                            COALESCE((SELECT SUM(quantity) FROM inbound_records WHERE part_id = ? AND (is_return = 0 OR is_return IS NULL)), 0) - 
                            COALESCE((SELECT SUM(quantity) FROM outbound_records WHERE part_id = ? AND (is_loan = 0 OR is_loan IS NULL)), 0) as system_quantity
                    `);
                    const stock = stockStmt.get(part_id, part_id);
                    const systemQuantity = stock ? stock.system_quantity : 0;
                    
                    // 檢查該料件在本次盤點事件中是否已盤點
                    const existingCheckStmt = db.prepare(`
                        SELECT id FROM inventory_checks 
                        WHERE session_id = ? AND part_id = ?
                    `);
                    const existingCheck = existingCheckStmt.get(currentSessionId, part_id);
                    
                    if (existingCheck) {
                        // 更新現有記錄
                        const updateStmt = db.prepare(`
                            UPDATE inventory_checks 
                            SET system_quantity = ?, previous_quantity = ?, actual_quantity = ?, difference = ?, created_by = ?
                            WHERE id = ?
                        `);
                        updateStmt.run(systemQuantity, prevQty, actualQty, difference, created_by, existingCheck.id);
                    } else {
                        // 插入新記錄
                        const checkStmt = db.prepare(`
                            INSERT INTO inventory_checks (session_id, part_id, check_date, system_quantity, previous_quantity, actual_quantity, difference, note, created_by, is_adjusted)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        `);
                        checkStmt.run(
                            currentSessionId, 
                            part_id, 
                            sessionDate,
                            systemQuantity,
                            prevQty, 
                            actualQty, 
                            difference, 
                            null, 
                            created_by, 
                            shouldAutoAdjust && difference !== 0 ? 1 : 0
                        );
                    }
                    
                    // 如果有差異且選擇自動調整，則自動調整庫存
                    if (difference !== 0 && shouldAutoAdjust) {
                        let adjustmentNote = '';
                        if (difference > 0) {
                            const inboundStmt = db.prepare(`
                                INSERT INTO inbound_records (part_id, quantity, inbound_date, note, is_return, created_by)
                                VALUES (?, ?, ?, ?, 0, ?)
                            `);
                            adjustmentNote = `批量盤點調整（盤盈 ${difference}，相較上次盤點 ${prevQty}）`;
                            inboundStmt.run(part_id, difference, sessionDate, adjustmentNote, created_by);
                        } else {
                            const outboundStmt = db.prepare(`
                                INSERT INTO outbound_records (part_id, quantity, outbound_date, note, is_loan, created_by)
                                VALUES (?, ?, ?, ?, 0, ?)
                            `);
                            adjustmentNote = `批量盤點調整（盤虧 ${Math.abs(difference)}，相較上次盤點 ${prevQty}）`;
                            outboundStmt.run(part_id, Math.abs(difference), sessionDate, adjustmentNote, created_by);
                        }
                        
                        // 更新盤點記錄的調整資訊
                        const updateStmt = db.prepare(`
                            UPDATE inventory_checks 
                            SET adjustment_note = ?, adjusted_at = CURRENT_TIMESTAMP, adjusted_by = ?, is_adjusted = 1
                            WHERE session_id = ? AND part_id = ?
                        `);
                        updateStmt.run(adjustmentNote, created_by, currentSessionId, part_id);
                        adjustedCount++;
                    }
                    
                    successCount++;
                } catch (error) {
                    console.error(`處理料件 ${item.part_id} 盤點記錄失敗:`, error);
                    errorCount++;
                }
            }
        });
        
        transaction();
        
        logActivity(req, 'import', `匯入料件：成功 ${successCount} 筆，跳過 ${skipCount} 筆`, 'import', null);
        
        // 返回成功訊息
        if (errorCount === 0) {
            let message = `批量盤點提交成功！共處理 ${successCount} 項料件。`;
            if (shouldAutoAdjust && adjustedCount > 0) {
                message += `已自動調整 ${adjustedCount} 項差異。`;
            } else if (adjustedCount === 0 && shouldAutoAdjust) {
                message += '所有項目均無差異，無需調整。';
            } else {
                message += '請前往「盤點差異報表」查看並手動調整差異。';
            }
            flash(req, 'success', message);
        } else {
            flash(req, 'warning', `批量盤點提交完成！成功 ${successCount} 項，失敗 ${errorCount} 項。`);
        }
        
        res.redirect(`/inventory/check?session_date=${sessionDate}`);
    } catch (error) {
        flash(req, 'error', `批量盤點失敗：${error.message}`);
        res.redirect('/inventory/check');
    }
});

// 盤點處理（基於盤點事件，比較本次與上次盤點結果）（單項模式，保留以備用）
app.post('/inventory/check', requireAuth, (req, res) => {
    const { part_id, session_id, session_date, actual_quantity, note, auto_adjust } = req.body;
    const created_by = req.session.user ? (req.session.user.full_name || req.session.user.username) : '系統';
    const shouldAutoAdjust = auto_adjust === 'on' || auto_adjust === 'true';
    
    try {
        // 驗證盤點事件是否存在
        let currentSessionId = session_id ? parseInt(session_id) : null;
        
        if (!currentSessionId && session_date) {
            // 根據日期查找或創建盤點事件
            const sessionStmt = db.prepare('SELECT id FROM inventory_check_sessions WHERE session_date = ?');
            let session = sessionStmt.get(session_date);
            
            if (!session) {
                // 創建新的盤點事件
                const createSessionStmt = db.prepare(`
                    INSERT INTO inventory_check_sessions (session_date, session_name, status, created_by)
                    VALUES (?, ?, 'in_progress', ?)
                `);
                const sessionResult = createSessionStmt.run(
                    session_date, 
                    `${session_date} 盤點`, 
                    created_by
                );
                currentSessionId = sessionResult.lastInsertRowid;
            } else {
                currentSessionId = session.id;
            }
        }
        
        if (!currentSessionId) {
            flash(req, 'error', '請先創建盤點事件！');
            return res.redirect('/inventory/check/sessions');
        }
        
        // 獲取盤點事件的日期
        const sessionDateStmt = db.prepare('SELECT session_date FROM inventory_check_sessions WHERE id = ?');
        const sessionDate = sessionDateStmt.get(currentSessionId).session_date;
        
        // 獲取上次盤點的實際數量（與上次盤點事件比較）
        const previousCheckStmt = db.prepare(`
            SELECT ic.actual_quantity, ics.session_date
            FROM inventory_checks ic
            JOIN inventory_check_sessions ics ON ic.session_id = ics.id
            WHERE ic.part_id = ? 
              AND ics.id != ?
              AND ics.status = 'completed'
            ORDER BY ics.session_date DESC
            LIMIT 1
        `);
        const previousCheck = previousCheckStmt.get(part_id, currentSessionId);
        
        let previousQuantity = null;
        if (previousCheck) {
            previousQuantity = previousCheck.actual_quantity;
        } else {
            // 如果沒有上次盤點記錄，使用系統庫存作為基準（首次盤點）
            const stockStmt = db.prepare(`
                SELECT 
                    COALESCE((SELECT SUM(quantity) FROM inbound_records WHERE part_id = ? AND (is_return = 0 OR is_return IS NULL)), 0) - 
                    COALESCE((SELECT SUM(quantity) FROM outbound_records WHERE part_id = ? AND (is_loan = 0 OR is_loan IS NULL)), 0) as system_quantity
            `);
            const stock = stockStmt.get(part_id, part_id);
            previousQuantity = stock ? stock.system_quantity : 0;
        }
        
        const actualQty = parseInt(actual_quantity);
        const difference = actualQty - previousQuantity;
        
        // 檢查該料件在本次盤點事件中是否已盤點
        const existingCheckStmt = db.prepare(`
            SELECT id FROM inventory_checks 
            WHERE session_id = ? AND part_id = ?
        `);
        const existingCheck = existingCheckStmt.get(currentSessionId, part_id);
        
        let checkRecordId;
        if (existingCheck) {
            // 獲取當前系統庫存（用於向後兼容）
            const stockStmt = db.prepare(`
                SELECT 
                    COALESCE((SELECT SUM(quantity) FROM inbound_records WHERE part_id = ? AND (is_return = 0 OR is_return IS NULL)), 0) - 
                    COALESCE((SELECT SUM(quantity) FROM outbound_records WHERE part_id = ? AND (is_loan = 0 OR is_loan IS NULL)), 0) as system_quantity
            `);
            const stock = stockStmt.get(part_id, part_id);
            const systemQuantity = stock ? stock.system_quantity : 0;
            
            // 更新現有記錄（同時更新 system_quantity 以確保向後兼容）
            const updateStmt = db.prepare(`
                UPDATE inventory_checks 
                SET system_quantity = ?, previous_quantity = ?, actual_quantity = ?, difference = ?, note = ?, created_by = ?
                WHERE id = ?
            `);
            updateStmt.run(systemQuantity, previousQuantity, actualQty, difference, note || null, created_by, existingCheck.id);
            checkRecordId = existingCheck.id;
        } else {
            // 獲取當前系統庫存（用於向後兼容，填充 system_quantity 欄位）
            const stockStmt = db.prepare(`
                SELECT 
                    COALESCE((SELECT SUM(quantity) FROM inbound_records WHERE part_id = ? AND (is_return = 0 OR is_return IS NULL)), 0) - 
                    COALESCE((SELECT SUM(quantity) FROM outbound_records WHERE part_id = ? AND (is_loan = 0 OR is_loan IS NULL)), 0) as system_quantity
            `);
            const stock = stockStmt.get(part_id, part_id);
            const systemQuantity = stock ? stock.system_quantity : 0;
            
            // 插入新記錄（同時提供 system_quantity 和 previous_quantity 以確保向後兼容）
            const checkStmt = db.prepare(`
                INSERT INTO inventory_checks (session_id, part_id, check_date, system_quantity, previous_quantity, actual_quantity, difference, note, created_by, is_adjusted)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            const checkId = checkStmt.run(
                currentSessionId, 
                part_id, 
                sessionDate,
                systemQuantity,  // 系統庫存（用於向後兼容）
                previousQuantity,  // 上次盤點數量（新的比較基準）
                actualQty, 
                difference, 
                note || null, 
                created_by, 
                shouldAutoAdjust ? 1 : 0
            );
            checkRecordId = checkId.lastInsertRowid;
        }
        
        // 如果有差異且選擇自動調整，則自動調整庫存
        if (difference !== 0 && shouldAutoAdjust) {
            let adjustmentNote = '';
            if (difference > 0) {
                // 盤盈：創建入庫記錄
                const inboundStmt = db.prepare(`
                    INSERT INTO inbound_records (part_id, quantity, inbound_date, note, is_return, created_by)
                    VALUES (?, ?, ?, ?, 0, ?)
                `);
                adjustmentNote = `盤點調整（盤盈 ${difference}，相較上次盤點 ${previousQuantity}）：${note || ''}`.trim();
                inboundStmt.run(part_id, difference, sessionDate, adjustmentNote, created_by);
            } else {
                // 盤虧：創建出庫記錄
                const outboundStmt = db.prepare(`
                    INSERT INTO outbound_records (part_id, quantity, outbound_date, note, is_loan, created_by)
                    VALUES (?, ?, ?, ?, 0, ?)
                `);
                adjustmentNote = `盤點調整（盤虧 ${Math.abs(difference)}，相較上次盤點 ${previousQuantity}）：${note || ''}`.trim();
                outboundStmt.run(part_id, Math.abs(difference), sessionDate, adjustmentNote, created_by);
            }
            
            // 更新盤點記錄的調整資訊
            const updateStmt = db.prepare(`
                UPDATE inventory_checks 
                SET adjustment_note = ?, adjusted_at = CURRENT_TIMESTAMP, adjusted_by = ?, is_adjusted = 1
                WHERE id = ?
            `);
            updateStmt.run(adjustmentNote, created_by, checkRecordId);
            
            flash(req, 'success', `盤點記錄成功！已自動調整庫存（${difference > 0 ? '盤盈' : '盤虧'} ${Math.abs(difference)}，相較上次盤點 ${previousQuantity}）`);
        } else if (difference !== 0) {
            flash(req, 'success', `盤點記錄成功！發現差異：${difference > 0 ? '盤盈' : '盤虧'} ${Math.abs(difference)}（相較上次盤點 ${previousQuantity}），請前往「盤點差異報表」進行手動調整。`);
        } else {
            flash(req, 'success', `盤點記錄成功！與上次盤點相符（數量：${actualQty}，上次：${previousQuantity}）`);
        }
        
        // 重定向回盤點頁面，保持盤點事件
        res.redirect(`/inventory/check?session_date=${sessionDate}`);
    } catch (error) {
        flash(req, 'error', `盤點失敗：${error.message}`);
        res.redirect('/inventory/check');
    }
});

// 盤點記錄列表
app.get('/inventory/check/records', requireAuth, (req, res) => {
    logActivity(req, 'view', '查看盤點記錄', 'inventory_check_records', null);
    const { search, date_from, date_to, session_id } = req.query;
    
    let whereConditions = [];
    let params = [];
    
    // 搜尋條件
    if (search && search.trim()) {
        whereConditions.push(`(p.part_number LIKE ? OR p.part_name LIKE ? OR p.barcode LIKE ?)`);
        const searchTerm = `%${search.trim()}%`;
        params.push(searchTerm, searchTerm, searchTerm);
    }
    
    // 盤點事件篩選
    if (session_id && session_id !== '') {
        whereConditions.push(`ic.session_id = ?`);
        params.push(session_id);
    }
    
    // 日期範圍（基於盤點事件日期，如果沒有盤點事件則使用 check_date）
    if (date_from) {
        whereConditions.push(`COALESCE(ics.session_date, ic.check_date) >= ?`);
        params.push(date_from);
    }
    if (date_to) {
        whereConditions.push(`COALESCE(ics.session_date, ic.check_date) <= ?`);
        params.push(date_to);
    }
    
    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
    
    const stmt = db.prepare(`
        SELECT 
            ic.id,
            ic.session_id,
            ics.session_date,
            ics.session_name,
            ics.status as session_status,
            ic.check_date,
            p.part_number,
            p.part_name,
            p.unit,
            COALESCE(ic.previous_quantity, ic.system_quantity) as previous_quantity,
            ic.actual_quantity,
            ic.difference,
            ic.note,
            ic.created_by,
            ic.is_adjusted,
            ic.adjustment_note,
            ic.adjusted_at,
            ic.adjusted_by,
            ic.created_at
        FROM inventory_checks ic
        JOIN parts p ON ic.part_id = p.id
        LEFT JOIN inventory_check_sessions ics ON ic.session_id = ics.id
        ${whereClause}
        ORDER BY COALESCE(ics.session_date, ic.check_date) DESC, ic.created_at DESC
        LIMIT 500
    `);
    
    const records = stmt.all(...params);
    
    // 獲取所有盤點事件用於下拉選單
    const sessionsStmt = db.prepare(`
        SELECT DISTINCT ics.id, ics.session_date, ics.session_name, ics.status
        FROM inventory_check_sessions ics
        LEFT JOIN inventory_checks ic ON ics.id = ic.session_id
        WHERE ic.id IS NOT NULL
        ORDER BY ics.session_date DESC
        LIMIT 50
    `);
    const checkSessions = sessionsStmt.all();
    
    res.render('inventory_check_records', { 
        records, 
        checkSessions,
        search: search || '',
        date_from: date_from || '',
        date_to: date_to || '',
        session_id: session_id || '',
        user: req.session.user, 
        title: PAGE_TITLE 
    });
});

// 盤點差異報表（只顯示有差異的記錄，顯示本次與上次盤點的差異）
app.get('/inventory/check/differences', requireAuth, (req, res) => {
    logActivity(req, 'view', '查看盤點差異報表', 'inventory_check_differences', null);
    const { search, date_from, date_to, session_id } = req.query;
    
    let whereConditions = ['ic.difference != 0'];  // 只顯示有差異的記錄
    let params = [];
    
    // 搜尋條件
    if (search && search.trim()) {
        whereConditions.push(`(p.part_number LIKE ? OR p.part_name LIKE ? OR p.barcode LIKE ?)`);
        const searchTerm = `%${search.trim()}%`;
        params.push(searchTerm, searchTerm, searchTerm);
    }
    
    // 盤點事件篩選
    if (session_id) {
        whereConditions.push(`ic.session_id = ?`);
        params.push(session_id);
    }
    
    // 日期範圍（基於盤點事件日期）
    if (date_from) {
        whereConditions.push(`ics.session_date >= ?`);
        params.push(date_from);
    }
    if (date_to) {
        whereConditions.push(`ics.session_date <= ?`);
        params.push(date_to);
    }
    
    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
    
    // 獲取所有盤點事件列表（用於下拉選單）
    const sessionsStmt = db.prepare(`
        SELECT DISTINCT ics.id, ics.session_date, ics.session_name, ics.status
        FROM inventory_check_sessions ics
        JOIN inventory_checks ic ON ics.id = ic.session_id
        WHERE ic.difference != 0 
        ORDER BY ics.session_date DESC 
        LIMIT 50
    `);
    const checkSessions = sessionsStmt.all();
    
    // 獲取差異記錄（關聯盤點事件）
    const stmt = db.prepare(`
        SELECT 
            ic.id,
            ic.session_id,
            ics.session_date,
            ics.session_name,
            ics.status as session_status,
            p.part_number,
            p.part_name,
            p.unit,
            ic.previous_quantity,
            ic.actual_quantity,
            ic.difference,
            ic.note,
            ic.created_by,
            ic.is_adjusted,
            ic.adjustment_note,
            ic.adjusted_at,
            ic.adjusted_by,
            ic.created_at
        FROM inventory_checks ic
        JOIN parts p ON ic.part_id = p.id
        LEFT JOIN inventory_check_sessions ics ON ic.session_id = ics.id
        ${whereClause}
        ORDER BY ics.session_date DESC, ABS(ic.difference) DESC, ic.created_at DESC
        LIMIT 500
    `);
    
    const records = stmt.all(...params);
    
    // 統計資訊
    const stats = {
        total: records.length,
        positive: records.filter(r => r.difference > 0).length,
        negative: records.filter(r => r.difference < 0).length,
        adjusted: records.filter(r => r.is_adjusted === 1).length,
        pending: records.filter(r => r.is_adjusted === 0).length,
        total_positive_diff: records.filter(r => r.difference > 0).reduce((sum, r) => sum + r.difference, 0),
        total_negative_diff: Math.abs(records.filter(r => r.difference < 0).reduce((sum, r) => sum + r.difference, 0))
    };
    
    res.render('inventory_check_differences', { 
        records, 
        checkSessions,
        stats,
        search: search || '',
        date_from: date_from || '',
        date_to: date_to || '',
        session_id: session_id || '',
        user: req.session.user, 
        title: PAGE_TITLE 
    });
});

// 手動調整盤點差異（基於盤點事件）
app.post('/inventory/check/adjust/:id', requireAuth, (req, res) => {
    const { id } = req.params;
    const { adjustment_note } = req.body;
    const adjusted_by = req.session.user ? (req.session.user.full_name || req.session.user.username) : '系統';
    
    try {
        // 獲取盤點記錄（關聯盤點事件）
        const checkStmt = db.prepare(`
            SELECT ic.*, ics.session_date 
            FROM inventory_checks ic
            LEFT JOIN inventory_check_sessions ics ON ic.session_id = ics.id
            WHERE ic.id = ?
        `);
        const checkRecord = checkStmt.get(id);
        
        if (!checkRecord) {
            flash(req, 'error', '盤點記錄不存在！');
            return res.redirect('/inventory/check/differences');
        }
        
        // 如果已經調整過，不允許再次調整
        if (checkRecord.is_adjusted === 1) {
            flash(req, 'error', '此盤點記錄已經調整過，無法重複調整！');
            return res.redirect('/inventory/check/differences');
        }
        
        const difference = checkRecord.difference;
        const sessionDate = checkRecord.session_date || checkRecord.check_date;
        const partId = checkRecord.part_id;
        const note = checkRecord.note || '';
        const previousQuantity = checkRecord.previous_quantity || 0;
        
        // 根據差異調整庫存
        if (difference > 0) {
            // 盤盈：創建入庫記錄
            const inboundStmt = db.prepare(`
                INSERT INTO inbound_records (part_id, quantity, inbound_date, note, is_return, created_by)
                VALUES (?, ?, ?, ?, 0, ?)
            `);
            const adjustmentNote = `盤點調整（盤盈 ${difference}，相較上次盤點 ${previousQuantity}）：${note ? note + '；' : ''}${adjustment_note || ''}`.trim();
            inboundStmt.run(partId, difference, sessionDate, adjustmentNote, adjusted_by);
        } else if (difference < 0) {
            // 盤虧：創建出庫記錄
            const outboundStmt = db.prepare(`
                INSERT INTO outbound_records (part_id, quantity, outbound_date, note, is_loan, created_by)
                VALUES (?, ?, ?, ?, 0, ?)
            `);
            const adjustmentNote = `盤點調整（盤虧 ${Math.abs(difference)}，相較上次盤點 ${previousQuantity}）：${note ? note + '；' : ''}${adjustment_note || ''}`.trim();
            outboundStmt.run(partId, Math.abs(difference), sessionDate, adjustmentNote, adjusted_by);
        }
        
        // 更新盤點記錄的調整狀態
        const updateStmt = db.prepare(`
            UPDATE inventory_checks 
            SET is_adjusted = 1, 
                adjustment_note = ?, 
                adjusted_at = CURRENT_TIMESTAMP, 
                adjusted_by = ?
            WHERE id = ?
        `);
        const finalAdjustmentNote = `${note ? note + '；' : ''}${adjustment_note || '手動調整庫存（相較上次盤點）'}`.trim();
        updateStmt.run(finalAdjustmentNote, adjusted_by, id);
        
        const partStmt = db.prepare('SELECT part_number, part_name FROM parts WHERE id = ?');
        const part = partStmt.get(partId);
        const partInfo = part ? `${part.part_number} - ${part.part_name}` : `料件ID: ${partId}`;
        
        logActivity(req, 'adjust', `調整盤點差異：${partInfo}，${difference > 0 ? '盤盈' : '盤虧'} ${Math.abs(difference)}`, 'inventory_check', parseInt(id));
        flash(req, 'success', `盤點差異調整成功！${difference > 0 ? '盤盈' : '盤虧'} ${Math.abs(difference)}（相較上次盤點 ${previousQuantity}）已調整至庫存。`);
        res.redirect('/inventory/check/differences');
    } catch (error) {
        flash(req, 'error', `調整失敗：${error.message}`);
        res.redirect('/inventory/check/differences');
    }
});

// 匯出盤點報表
app.get('/export/inventory-check', requireAuth, async (req, res) => {
    logActivity(req, 'export', '匯出盤點報表', 'export', null);
    const { search, date_from, date_to } = req.query;
    
    let whereConditions = [];
    let params = [];
    
    // 搜尋條件
    if (search && search.trim()) {
        whereConditions.push(`(p.part_number LIKE ? OR p.part_name LIKE ? OR p.barcode LIKE ?)`);
        const searchTerm = `%${search.trim()}%`;
        params.push(searchTerm, searchTerm, searchTerm);
    }
    
    // 日期範圍
    if (date_from) {
        whereConditions.push(`ic.check_date >= ?`);
        params.push(date_from);
    }
    if (date_to) {
        whereConditions.push(`ic.check_date <= ?`);
        params.push(date_to);
    }
    
    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
    
    const stmt = db.prepare(`
        SELECT 
            ic.check_date as '盤點日期',
            p.part_number as '料號',
            p.part_name as '料件名稱',
            p.unit as '單位',
            ic.system_quantity as '系統庫存',
            ic.actual_quantity as '實際盤點',
            ic.difference as '差異',
            CASE 
                WHEN ic.difference > 0 THEN '盤盈'
                WHEN ic.difference < 0 THEN '盤虧'
                ELSE '相符'
            END as '狀態',
            ic.note as '備註',
            ic.created_by as '盤點人員',
            ic.created_at as '記錄時間'
        FROM inventory_checks ic
        JOIN parts p ON ic.part_id = p.id
        ${whereClause}
        ORDER BY ic.check_date DESC, ic.created_at DESC
    `);
    
    const data = stmt.all(...params);
    
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('盤點記錄');
    
    // 設定欄位標題
    worksheet.columns = [
        { header: '盤點日期', key: '盤點日期', width: 12 },
        { header: '料號', key: '料號', width: 15 },
        { header: '料件名稱', key: '料件名稱', width: 20 },
        { header: '單位', key: '單位', width: 10 },
        { header: '系統庫存', key: '系統庫存', width: 12 },
        { header: '實際盤點', key: '實際盤點', width: 12 },
        { header: '差異', key: '差異', width: 12 },
        { header: '狀態', key: '狀態', width: 10 },
        { header: '備註', key: '備註', width: 30 },
        { header: '盤點人員', key: '盤點人員', width: 15 },
        { header: '記錄時間', key: '記錄時間', width: 20 }
    ];
    
    // 添加資料
    data.forEach(row => {
        worksheet.addRow(row);
    });
    
    // 設定標題行樣式
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF667EEA' }
    };
    worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    
    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('盤點記錄.xlsx')}`);
    res.send(buffer);
});

// Excel 匯出 - 料件列表
app.get('/export/parts', async (req, res) => {
    const stmt = db.prepare(`
        SELECT 
            p.part_number as '料號',
            p.part_name as '料件名稱',
            c.name as '類型',
            p.specification as '規格',
            p.barcode as '條碼',
            p.unit as '單位',
            p.created_at as '建立時間'
        FROM parts p
        LEFT JOIN categories c ON p.category_id = c.id
        ORDER BY p.part_number
    `);
    const data = stmt.all();
    
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('料件列表');
    
    // 設定欄位標題
    worksheet.columns = [
        { header: '料號', key: '料號', width: 15 },
        { header: '料件名稱', key: '料件名稱', width: 20 },
        { header: '類型', key: '類型', width: 15 },
        { header: '規格', key: '規格', width: 20 },
        { header: '條碼', key: '條碼', width: 20 },
        { header: '單位', key: '單位', width: 10 },
        { header: '建立時間', key: '建立時間', width: 20 }
    ];
    
    // 添加資料
    data.forEach(row => {
        worksheet.addRow(row);
    });
    
    // 設定標題行樣式
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF4CAF50' }
    };
    worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    
    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('料件列表.xlsx')}`);
    res.send(buffer);
});

// Excel 匯出 - 庫存
app.get('/export/inventory', async (req, res) => {
    logActivity(req, 'export', '匯出庫存資料', 'export', null);
    const stmt = db.prepare(`
        SELECT 
            p.part_number as '料號',
            p.part_name as '料件名稱',
            c.name as '類型',
            p.specification as '規格',
            p.barcode as '條碼',
            COALESCE((SELECT SUM(quantity) FROM inbound_records WHERE part_id = p.id AND (is_return = 0 OR is_return IS NULL)), 0) - 
            COALESCE((SELECT SUM(quantity) FROM outbound_records WHERE part_id = p.id AND (is_loan = 0 OR is_loan IS NULL)), 0) as '庫存數量',
            p.unit as '單位'
        FROM parts p
        LEFT JOIN categories c ON p.category_id = c.id
        ORDER BY p.part_number
    `);
    const data = stmt.all();
    
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('庫存查詢');
    
    // 設定欄位標題
    worksheet.columns = [
        { header: '料號', key: '料號', width: 15 },
        { header: '料件名稱', key: '料件名稱', width: 20 },
        { header: '類型', key: '類型', width: 15 },
        { header: '規格', key: '規格', width: 20 },
        { header: '條碼', key: '條碼', width: 20 },
        { header: '庫存數量', key: '庫存數量', width: 12 },
        { header: '單位', key: '單位', width: 10 }
    ];
    
    // 添加資料
    data.forEach(row => {
        worksheet.addRow(row);
    });
    
    // 設定標題行樣式
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF4CAF50' }
    };
    worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    
    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('庫存查詢.xlsx')}`);
    res.send(buffer);
});

// Excel 匯入範本下載
app.get('/import/template', async (req, res) => {
    logActivity(req, 'view', '下載匯入範本', 'import', null);
    const workbook = new ExcelJS.Workbook();
    
    // 範本工作表
    const templateSheet = workbook.addWorksheet('料件匯入範本');
    templateSheet.columns = [
        { header: '料號', key: '料號', width: 15 },
        { header: '料件名稱', key: '料件名稱', width: 20 },
        { header: '規格', key: '規格', width: 20 },
        { header: '條碼', key: '條碼', width: 20 },
        { header: '單位', key: '單位', width: 10 },
        { header: '類型', key: '類型', width: 15 }
    ];
    
    templateSheet.addRow({
        '料號': 'A001',
        '料件名稱': '範例料件',
        '規格': '範例規格',
        '條碼': '1234567890123',
        '單位': '個',
        '類型': '電子元件'
    });
    
    // 設定標題行樣式
    templateSheet.getRow(1).font = { bold: true };
    templateSheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF4CAF50' }
    };
    templateSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    
    // 說明工作表
    const instructionSheet = workbook.addWorksheet('使用說明');
    instructionSheet.columns = [
        { header: '說明', key: '說明', width: 80 }
    ];
    
    const instructions = [
        '料件匯入範本使用說明',
        '',
        '必填欄位：',
        '  1. 料號：必須唯一，不能重複',
        '  2. 料件名稱：料件的名稱',
        '  3. 單位：單位名稱（如不存在會自動建立）',
        '',
        '選填欄位：',
        '  1. 規格：料件的規格說明',
        '  2. 條碼：料件的條碼（必須唯一）',
        '  3. 類型：類型名稱（如不存在會自動建立）',
        '',
        '注意事項：',
        '  - 如果類型不存在，系統會自動建立該類型',
        '  - 如果單位不存在，系統會自動建立該單位',
        '  - 重複的料號會被跳過',
        '  - 重複的條碼會被跳過'
    ];
    
    instructions.forEach(text => {
        instructionSheet.addRow({ '說明': text });
    });
    
    instructionSheet.getRow(1).font = { bold: true, size: 14 };
    
    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('料件匯入範本.xlsx')}`);
    res.send(buffer);
});

// Excel 匯入頁面
app.get('/import', (req, res) => {
    logActivity(req, 'view', '查看匯入頁面', 'import', null);
    res.render('import', { title: PAGE_TITLE });
});

// Excel 匯入處理
app.post('/import', upload.single('excelFile'), async (req, res) => {
    if (!req.file) {
        flash(req, 'error', '請選擇要匯入的檔案');
        return res.redirect('/import');
    }
    
    try {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(req.file.path);
        const worksheet = workbook.getWorksheet(1); // 取得第一個工作表
        
        const data = [];
        worksheet.eachRow((row, rowNumber) => {
            if (rowNumber === 1) return; // 跳過標題行
            
            const rowData = {};
            row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
                const header = worksheet.getRow(1).getCell(colNumber).value;
                if (header) {
                    rowData[header] = cell.value;
                }
            });
            if (Object.keys(rowData).length > 0) {
                data.push(rowData);
            }
        });
        
        // 獲取所有類型和單位
        const categoriesStmt = db.prepare('SELECT * FROM categories');
        const categories = categoriesStmt.all();
        let categoryMap = {};
        categories.forEach(cat => {
            categoryMap[cat.name] = cat.id;
        });
        
        const unitsStmt = db.prepare('SELECT * FROM units');
        const units = unitsStmt.all();
        let unitMap = {};
        units.forEach(unit => {
            unitMap[unit.name] = unit.name;
        });
        
        // 準備插入語句
        const insertCategoryStmt = db.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)');
        const getCategoryStmt = db.prepare('SELECT id FROM categories WHERE name = ?');
        const insertUnitStmt = db.prepare('INSERT OR IGNORE INTO units (name, symbol) VALUES (?, ?)');
        
        let successCount = 0;
        let skipCount = 0;
        const errors = [];
        
        const insertStmt = db.prepare(`
            INSERT INTO parts (part_number, part_name, specification, unit, category_id, barcode)
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        
        const transaction = db.transaction(() => {
            data.forEach((row, index) => {
                try {
                    const partNumber = row['料號'] || row['part_number'];
                    const partName = row['料件名稱'] || row['part_name'] || row['名稱'];
                    const specification = row['規格'] || row['specification'] || null;
                    const barcode = row['條碼'] || row['barcode'] || null;
                    let unitName = row['單位'] || row['unit'] || '個';
                    const categoryName = row['類型'] || row['category'] || null;
                    
                    if (!partNumber || !partName) {
                        skipCount++;
                        errors.push(`第 ${index + 2} 行：缺少必填欄位（料號或料件名稱）`);
                        return;
                    }
                    
                    // 自動建立單位（如果不存在）
                    if (!unitMap[unitName]) {
                        insertUnitStmt.run(unitName, unitName);
                        unitMap[unitName] = unitName;
                    }
                    const unit = unitMap[unitName] || '個';
                    
                    // 自動建立類型（如果不存在）
                    let categoryId = null;
                    if (categoryName) {
                        if (!categoryMap[categoryName]) {
                            insertCategoryStmt.run(categoryName);
                            const newCategory = getCategoryStmt.get(categoryName);
                            if (newCategory) {
                                categoryMap[categoryName] = newCategory.id;
                                categoryId = newCategory.id;
                            }
                        } else {
                            categoryId = categoryMap[categoryName];
                        }
                    }
                    
                    insertStmt.run(
                        partNumber,
                        partName,
                        specification,
                        unit,
                        categoryId,
                        barcode
                    );
                    successCount++;
                } catch (error) {
                    skipCount++;
                    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
                        errors.push(`第 ${index + 2} 行：料號或條碼已存在`);
                    } else {
                        errors.push(`第 ${index + 2} 行：${error.message}`);
                    }
                }
            });
        });
        
        transaction();
        
        // 刪除上傳的檔案
        fs.unlinkSync(req.file.path);
        
        if (successCount > 0) {
            flash(req, 'success', `成功匯入 ${successCount} 筆資料${skipCount > 0 ? `，跳過 ${skipCount} 筆` : ''}`);
        } else {
            flash(req, 'error', `匯入失敗：${errors.slice(0, 5).join('; ')}${errors.length > 5 ? '...' : ''}`);
        }
        
        res.redirect('/parts');
    } catch (error) {
        // 刪除上傳的檔案
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        flash(req, 'error', `匯入失敗：${error.message}`);
        res.redirect('/import');
    }
});

// 用戶管理 - 列表（需要管理員權限）
app.get('/users', requireAuth, requireAdmin, (req, res) => {
    const stmt = db.prepare('SELECT id, username, full_name, email, role, is_active, created_at FROM users ORDER BY created_at DESC');
    const users = stmt.all();
    logActivity(req, 'view', '查看使用者列表', 'users', null);
    res.render('users_list', { users, title: PAGE_TITLE });
});

// 用戶管理 - 新增頁面
app.get('/users/add', requireAuth, requireAdmin, (req, res) => {
    try {
        // 讀取所有角色供選擇
        const rolesStmt = db.prepare('SELECT * FROM roles ORDER BY is_system DESC, display_name');
        const roles = rolesStmt.all();
        
        res.render('add_user', { 
            title: PAGE_TITLE,
            roles 
        });
    } catch (error) {
        console.error('載入新增使用者頁面錯誤:', error);
        flash(req, 'error', '載入頁面失敗');
        res.redirect('/users');
    }
});

// 用戶管理 - 新增處理
app.post('/users/add', requireAuth, requireAdmin, async (req, res) => {
    const { username, password, full_name, email, role } = req.body;
    
    if (!username || !password) {
        flash(req, 'error', '帳號和密碼為必填欄位');
        return res.redirect('/users/add');
    }
    
    try {
        const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
        const stmt = db.prepare(`
            INSERT INTO users (username, password_hash, full_name, email, role)
            VALUES (?, ?, ?, ?, ?)
        `);
        const result = stmt.run(username, passwordHash, full_name || null, email || null, role || 'user');
        
        logActivity(req, 'create', `新增使用者：${username}`, 'user', result.lastInsertRowid);
        flash(req, 'success', '用戶新增成功！');
        res.redirect('/users');
    } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            flash(req, 'error', '帳號已存在！');
        } else {
            flash(req, 'error', `新增失敗：${error.message}`);
        }
        res.redirect('/users/add');
    }
});

// 用戶管理 - 編輯頁面
app.get('/users/edit/:id', requireAuth, requireAdmin, (req, res) => {
    const { id } = req.params;
    
    try {
        const stmt = db.prepare('SELECT id, username, full_name, email, role, is_active FROM users WHERE id = ?');
        const user = stmt.get(id);
        
        if (!user) {
            flash(req, 'error', '用戶不存在！');
            return res.redirect('/users');
        }
        
        // 讀取所有角色供選擇
        const rolesStmt = db.prepare('SELECT * FROM roles ORDER BY is_system DESC, display_name');
        const roles = rolesStmt.all();
        
        res.render('edit_user', { 
            user, 
            title: PAGE_TITLE,
            roles 
        });
    } catch (error) {
        console.error('載入編輯使用者頁面錯誤:', error);
        flash(req, 'error', '載入頁面失敗');
        res.redirect('/users');
    }
});

// 用戶管理 - 編輯處理
app.post('/users/edit/:id', requireAuth, requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { username, password, full_name, email, role, is_active } = req.body;
    
    try {
        if (password && password.trim() !== '') {
            // 如果有提供新密碼，則更新密碼
            const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
            const stmt = db.prepare(`
                UPDATE users 
                SET username = ?, password_hash = ?, full_name = ?, email = ?, role = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `);
            stmt.run(username, passwordHash, full_name || null, email || null, role || 'user', is_active ? 1 : 0, id);
        } else {
            // 不更新密碼
            const stmt = db.prepare(`
                UPDATE users 
                SET username = ?, full_name = ?, email = ?, role = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `);
            stmt.run(username, full_name || null, email || null, role || 'user', is_active ? 1 : 0, id);
        }
        
        logActivity(req, 'update', `編輯使用者：${username}`, 'user', parseInt(id));
        flash(req, 'success', '用戶更新成功！');
        res.redirect('/users');
    } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            flash(req, 'error', '帳號已存在！');
        } else {
            flash(req, 'error', `更新失敗：${error.message}`);
        }
        res.redirect(`/users/edit/${id}`);
    }
});

// 用戶管理 - 刪除
app.post('/users/delete/:id', requireAuth, requireAdmin, (req, res) => {
    const { id } = req.params;
    
    // 防止刪除自己
    if (parseInt(id) === req.session.user.id) {
        flash(req, 'error', '無法刪除自己的帳號！');
        return res.redirect('/users');
    }
    
    try {
        const userStmt = db.prepare('SELECT username FROM users WHERE id = ?');
        const user = userStmt.get(id);
        const username = user ? user.username : '未知';
        
        const stmt = db.prepare('DELETE FROM users WHERE id = ?');
        stmt.run(id);
        
        logActivity(req, 'delete', `刪除使用者：${username}`, 'user', parseInt(id));
        flash(req, 'success', '用戶刪除成功！');
        res.redirect('/users');
    } catch (error) {
        flash(req, 'error', `刪除失敗：${error.message}`);
        res.redirect('/users');
    }
});

// 備份管理 - 列表頁面（需要管理員權限）
app.get('/backup', requireAuth, requireAdmin, (req, res) => {
    logActivity(req, 'view', '查看備份列表', 'backup', null);
    const backupDir = BACKUP_DIR;
    
    // 確保備份目錄存在
    if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
    }
    
    // 讀取備份檔案列表
    let backups = [];
    try {
        const files = fs.readdirSync(backupDir);
        backups = files
            .filter(file => file.endsWith('.db') || file.endsWith('.sqlite') || file.endsWith('.sqlite3'))
            .map(file => {
                const filePath = path.join(backupDir, file);
                const stats = fs.statSync(filePath);
                return {
                    filename: file,
                    size: stats.size,
                    created: stats.birthtime,
                    modified: stats.mtime
                };
            })
            .sort((a, b) => b.created - a.created); // 按創建時間降序排列
    } catch (error) {
        console.error('讀取備份目錄失敗:', error);
    }
    
    res.render('backup', { 
        backups, 
        user: req.session.user, 
        title: PAGE_TITLE,
        backupDir: BACKUP_DIR
    });
});

// 備份管理 - 創建備份
app.post('/backup/create', requireAuth, requireAdmin, (req, res) => {
    const backupDir = BACKUP_DIR;
    
    // 確保備份目錄存在
    if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
    }
    
    try {
        // 生成備份檔案名稱（包含時間戳）
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const backupFileName = `inventory_backup_${timestamp}.db`;
        const backupPath = path.join(backupDir, backupFileName);
        
        // 複製資料庫檔案
        const dbPath = path.join(__dirname, 'inventory.db');
        if (fs.existsSync(dbPath)) {
            fs.copyFileSync(dbPath, backupPath);
            
            logActivity(req, 'backup', `創建備份：${backupFileName}`, 'backup', null);
            flash(req, 'success', `備份創建成功！檔案名稱：${backupFileName}`);
        } else {
            flash(req, 'error', '找不到資料庫檔案！');
        }
        
        res.redirect('/backup');
    } catch (error) {
        flash(req, 'error', `備份失敗：${error.message}`);
        res.redirect('/backup');
    }
});

// 備份管理 - 下載備份
app.get('/backup/download/:filename', requireAuth, requireAdmin, (req, res) => {
    const { filename } = req.params;
    const backupDir = BACKUP_DIR;
    const filePath = path.join(backupDir, filename);
    
    // 安全性檢查：防止路徑遍歷攻擊
    if (!filename.match(/^[a-zA-Z0-9._-]+\.db$/)) {
        flash(req, 'error', '無效的檔案名稱！');
        return res.redirect('/backup');
    }
    
    if (!fs.existsSync(filePath)) {
        flash(req, 'error', '備份檔案不存在！');
        return res.redirect('/backup');
    }
    
    res.download(filePath, filename, (err) => {
        if (err) {
            console.error('下載備份失敗:', err);
            flash(req, 'error', '下載備份失敗！');
            res.redirect('/backup');
        }
    });
});

// 備份管理 - 還原備份
app.post('/backup/restore/:filename', requireAuth, requireAdmin, (req, res) => {
    const { filename } = req.params;
    const backupDir = BACKUP_DIR;
    const backupPath = path.join(backupDir, filename);
    const dbPath = path.join(__dirname, 'inventory.db');
    
    // 安全性檢查
    if (!filename.match(/^[a-zA-Z0-9._-]+\.db$/)) {
        flash(req, 'error', '無效的檔案名稱！');
        return res.redirect('/backup');
    }
    
    if (!fs.existsSync(backupPath)) {
        flash(req, 'error', '備份檔案不存在！');
        return res.redirect('/backup');
    }
    
    try {
        // 確保所有寫入操作完成並執行檢查點
        db.exec('PRAGMA wal_checkpoint(FULL)');
        
        // 備份當前資料庫（以防萬一）
        const safetyBackupDir = BACKUP_DIR;
        if (!fs.existsSync(safetyBackupDir)) {
            fs.mkdirSync(safetyBackupDir, { recursive: true });
        }
        
        if (fs.existsSync(dbPath)) {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const safetyBackup = path.join(safetyBackupDir, `safety_backup_before_restore_${timestamp}.db`);
            fs.copyFileSync(dbPath, safetyBackup);
            flash(req, 'info', `已自動備份當前資料庫：${path.basename(safetyBackup)}`);
        }
        
        // 複製備份檔案到待還原位置
        // 伺服器會在下次啟動時自動執行還原
        fs.copyFileSync(backupPath, dbPath + '.restore');
        
        logActivity(req, 'restore', `準備還原備份：${filename}`, 'backup', null);
        flash(req, 'success', `備份檔案已準備還原！`);
        flash(req, 'warning', '⚠️ 為了確保資料完整性，請重新啟動伺服器以完成還原操作。伺服器啟動時會自動執行還原。');
        
        res.redirect('/backup');
    } catch (error) {
        flash(req, 'error', `還原準備失敗：${error.message}`);
        res.redirect('/backup');
    }
});

// 備份管理 - 刪除備份
app.post('/backup/delete/:filename', requireAuth, requireAdmin, (req, res) => {
    const { filename } = req.params;
    const backupDir = BACKUP_DIR;
    const filePath = path.join(backupDir, filename);
    
    // 安全性檢查
    if (!filename.match(/^[a-zA-Z0-9._-]+\.db$/)) {
        flash(req, 'error', '無效的檔案名稱！');
        return res.redirect('/backup');
    }
    
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            logActivity(req, 'delete', `刪除備份：${filename}`, 'backup', null);
            flash(req, 'success', '備份檔案刪除成功！');
        } else {
            flash(req, 'error', '備份檔案不存在！');
        }
        
        res.redirect('/backup');
    } catch (error) {
        flash(req, 'error', `刪除失敗：${error.message}`);
        res.redirect('/backup');
    }
});

// 備份管理 - 獲取備份排程設定
app.get('/backup/schedule', requireAuth, requireAdmin, (req, res) => {
    try {
        // 讀取排程設定檔案
        const scheduleFile = path.join(__dirname, 'backup-schedule.json');
        let schedule = {
            enabled: false,
            time: '02:00',
            frequency: 'daily', // daily, weekly, monthly
            dayOfWeek: 0, // 0-6 (Sunday-Saturday), for weekly
            dayOfMonth: 1, // 1-31, for monthly
            backupDir: BACKUP_DIR
        };
        
        if (fs.existsSync(scheduleFile)) {
            const scheduleData = fs.readFileSync(scheduleFile, 'utf8');
            schedule = { ...schedule, ...JSON.parse(scheduleData) };
        }
        
        res.json({ success: true, schedule });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// 備份管理 - 設定備份排程
app.post('/backup/schedule', requireAuth, requireAdmin, (req, res) => {
    const { enabled, time, frequency, dayOfWeek, dayOfMonth, backupDir } = req.body;
    
    try {
        const schedule = {
            enabled: enabled === 'true' || enabled === true,
            time: time || '02:00',
            frequency: frequency || 'daily',
            dayOfWeek: parseInt(dayOfWeek) || 0,
            dayOfMonth: parseInt(dayOfMonth) || 1,
            backupDir: backupDir || BACKUP_DIR
        };
        
        // 驗證時間格式
        if (!/^([0-1][0-9]|2[0-3]):[0-5][0-9]$/.test(schedule.time)) {
            flash(req, 'error', '時間格式錯誤，請使用 HH:MM 格式');
            return res.redirect('/backup');
        }
        
        // 保存排程設定
        const scheduleFile = path.join(__dirname, 'backup-schedule.json');
        fs.writeFileSync(scheduleFile, JSON.stringify(schedule, null, 2));
        
        logActivity(req, 'update', `設定備份排程：${schedule.enabled ? '啟用' : '停用'} - ${schedule.frequency} ${schedule.time}`, 'backup', null);
        flash(req, 'success', '備份排程設定已保存！請在系統中設定 cron 任務以啟用自動備份。');
        res.redirect('/backup');
    } catch (error) {
        flash(req, 'error', `設定失敗：${error.message}`);
        res.redirect('/backup');
    }
});

// 備份管理 - 獲取 /opt 下的備份資料夾列表
app.get('/backup/opt-folders', requireAuth, requireAdmin, (req, res) => {
    try {
        const folders = [];
        
        if (fs.existsSync('/opt')) {
            const optDirs = fs.readdirSync('/opt', { withFileTypes: true });
            
            for (const dir of optDirs) {
                if (dir.isDirectory()) {
                    const dirPath = path.join('/opt', dir.name);
                    const backupFiles = fs.readdirSync(dirPath).filter(file => 
                        file.endsWith('.db') || file.endsWith('.sqlite') || file.endsWith('.sqlite3')
                    );
                    
                    if (backupFiles.length > 0) {
                        folders.push({
                            name: dir.name,
                            path: dirPath,
                            fileCount: backupFiles.length,
                            files: backupFiles.slice(0, 10) // 只顯示前10個檔案
                        });
                    }
                }
            }
        }
        
        res.json({ success: true, folders });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// 備份管理 - 從 /opt 資料夾還原備份
app.post('/backup/restore-from-opt', requireAuth, requireAdmin, (req, res) => {
    const { folderPath, filename } = req.body;
    
    if (!folderPath || !filename) {
        flash(req, 'error', '請選擇資料夾和備份檔案');
        return res.redirect('/backup');
    }
    
    // 安全性檢查
    if (!folderPath.startsWith('/opt/') || !filename.match(/^[a-zA-Z0-9._-]+\.(db|sqlite|sqlite3)$/)) {
        flash(req, 'error', '無效的路徑或檔案名稱');
        return res.redirect('/backup');
    }
    
    const backupPath = path.join(folderPath, filename);
    const dbPath = path.join(__dirname, 'inventory.db');
    
    if (!fs.existsSync(backupPath)) {
        flash(req, 'error', '備份檔案不存在！');
        return res.redirect('/backup');
    }
    
    try {
        // 確保所有寫入操作完成並執行檢查點
        db.exec('PRAGMA wal_checkpoint(FULL)');
        
        // 備份當前資料庫（以防萬一）
        const safetyBackupDir = BACKUP_DIR;
        if (!fs.existsSync(safetyBackupDir)) {
            fs.mkdirSync(safetyBackupDir, { recursive: true });
        }
        
        if (fs.existsSync(dbPath)) {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const safetyBackup = path.join(safetyBackupDir, `safety_backup_before_restore_${timestamp}.db`);
            fs.copyFileSync(dbPath, safetyBackup);
            flash(req, 'info', `已自動備份當前資料庫：${path.basename(safetyBackup)}`);
        }
        
        // 複製備份檔案到待還原位置
        fs.copyFileSync(backupPath, dbPath + '.restore');
        
        logActivity(req, 'restore', `從 ${folderPath} 還原備份：${filename}`, 'backup', null);
        flash(req, 'success', `備份檔案已準備還原！`);
        flash(req, 'warning', '⚠️ 為了確保資料完整性，請重新啟動伺服器以完成還原操作。伺服器啟動時會自動執行還原。');
        
        res.redirect('/backup');
    } catch (error) {
        flash(req, 'error', `還原準備失敗：${error.message}`);
        res.redirect('/backup');
    }
});

// 備份管理 - 刪除 /opt 下的備份資料夾
app.post('/backup/remove-opt-folder', requireAuth, requireAdmin, (req, res) => {
    const { folderPath } = req.body;
    
    if (!folderPath) {
        flash(req, 'error', '請選擇要刪除的資料夾');
        return res.redirect('/backup');
    }
    
    // 安全性檢查：只允許刪除 /opt 下的資料夾
    if (!folderPath.startsWith('/opt/')) {
        flash(req, 'error', '只能刪除 /opt 下的資料夾');
        return res.redirect('/backup');
    }
    
    // 防止刪除系統重要目錄
    const forbiddenPaths = ['/opt/bin', '/opt/etc', '/opt/include', '/opt/lib', '/opt/lib64', '/opt/sbin', '/opt/share'];
    if (forbiddenPaths.some(forbidden => folderPath.startsWith(forbidden))) {
        flash(req, 'error', '不能刪除系統重要目錄');
        return res.redirect('/backup');
    }
    
    try {
        if (!fs.existsSync(folderPath)) {
            flash(req, 'error', '資料夾不存在！');
            return res.redirect('/backup');
        }
        
        // 確認操作
        const folderName = path.basename(folderPath);
        
        // 刪除資料夾及其內容
        fs.rmSync(folderPath, { recursive: true, force: true });
        
        logActivity(req, 'delete', `刪除 /opt 備份資料夾：${folderPath}`, 'backup', null);
        flash(req, 'success', `資料夾 ${folderName} 已刪除！`);
        
        res.redirect('/backup');
    } catch (error) {
        flash(req, 'error', `刪除失敗：${error.message}`);
        res.redirect('/backup');
    }
});

// 備份管理 - 獲取指定資料夾的備份檔案列表
app.get('/backup/list-folder/:folderPath(*)', requireAuth, requireAdmin, (req, res) => {
    try {
        const folderPath = decodeURIComponent(req.params.folderPath);
        
        // 安全性檢查
        if (!folderPath.startsWith('/opt/') && !folderPath.startsWith(BACKUP_DIR)) {
            return res.json({ success: false, error: '無效的路徑' });
        }
        
        if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
            return res.json({ success: false, error: '資料夾不存在' });
        }
        
        const files = fs.readdirSync(folderPath)
            .filter(file => file.endsWith('.db') || file.endsWith('.sqlite') || file.endsWith('.sqlite3'))
            .map(file => {
                const filePath = path.join(folderPath, file);
                const stats = fs.statSync(filePath);
                return {
                    filename: file,
                    size: stats.size,
                    created: stats.birthtime,
                    modified: stats.mtime
                };
            })
            .sort((a, b) => b.created - a.created);
        
        res.json({ success: true, files });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// 系統健康狀態頁面（需要管理員權限）
app.get('/health', requireAuth, requireAdmin, (req, res) => {
    logActivity(req, 'view', '查看系統健康狀態', 'health', null);
    const healthInfo = {
        timestamp: new Date().toISOString(),
        system: {
            nodeVersion: process.version,
            platform: process.platform,
            arch: process.arch,
            uptime: process.uptime(),
            memory: {
                used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
                total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
                rss: Math.round(process.memoryUsage().rss / 1024 / 1024)
            },
            cpuUsage: process.cpuUsage()
        },
        database: {
            status: 'connected',
            path: path.join(__dirname, 'inventory.db'),
            size: 0,
            tables: [],
            recordCounts: {}
        },
        disk: {
            free: 0,
            total: 0
        }
    };
    
    // 檢查資料庫
    try {
        // 資料庫檔案大小
        const dbPath = path.join(__dirname, 'inventory.db');
        if (fs.existsSync(dbPath)) {
            const stats = fs.statSync(dbPath);
            healthInfo.database.size = Math.round(stats.size / 1024); // KB
        }
        
        // 查詢所有表
        const tablesStmt = db.prepare(`
            SELECT name FROM sqlite_master 
            WHERE type='table' AND name NOT LIKE 'sqlite_%'
            ORDER BY name
        `);
        healthInfo.database.tables = tablesStmt.all().map(row => row.name);
        
        // 統計各表的記錄數
        healthInfo.database.recordCounts = {};
        healthInfo.database.tables.forEach(tableName => {
            try {
                const countStmt = db.prepare(`SELECT COUNT(*) as count FROM ${tableName}`);
                const result = countStmt.get();
                healthInfo.database.recordCounts[tableName] = result.count;
            } catch (e) {
                healthInfo.database.recordCounts[tableName] = 'N/A';
            }
        });
        
        // 檢查資料庫健康狀態（執行簡單查詢）
        db.prepare('SELECT 1').get();
        healthInfo.database.status = 'healthy';
    } catch (error) {
        healthInfo.database.status = 'error';
        healthInfo.database.error = error.message;
    }
    
    // 檢查磁碟空間（如果可用）
    try {
        if (process.platform !== 'win32') {
            const { execSync } = require('child_process');
            const df = execSync('df -k .').toString();
            const lines = df.split('\n');
            if (lines.length > 1) {
                const parts = lines[1].split(/\s+/);
                if (parts.length >= 4) {
                    healthInfo.disk.total = parseInt(parts[1]) / 1024; // MB
                    healthInfo.disk.free = parseInt(parts[3]) / 1024; // MB
                }
            }
        }
    } catch (error) {
        // Windows 或其他平台可能無法獲取磁碟資訊，忽略錯誤
    }
    
    res.render('health', { 
        health: healthInfo, 
        user: req.session.user, 
        title: PAGE_TITLE 
    });
});

// API: 獲取系統健康狀態（用於 AJAX 更新）
app.get('/api/health', requireAuth, requireAdmin, (req, res) => {
    try {
        const healthInfo = {
            timestamp: new Date().toISOString(),
            system: {
                uptime: process.uptime(),
                memory: {
                    used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
                    total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
                    rss: Math.round(process.memoryUsage().rss / 1024 / 1024)
                }
            },
            database: {
                status: 'connected'
            }
        };
        
        // 檢查資料庫
        try {
            db.prepare('SELECT 1').get();
            healthInfo.database.status = 'healthy';
        } catch (error) {
            healthInfo.database.status = 'error';
            healthInfo.database.error = error.message;
        }
        
        res.json({ success: true, health: healthInfo });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// ==================== 角色管理路由 ====================
// 角色列表
app.get('/roles', requireAdmin, (req, res) => {
    try {
        const stmt = db.prepare('SELECT * FROM roles ORDER BY is_system DESC, role_name');
        const roles = stmt.all();
        
        logActivity(req, 'view', '查看角色列表', 'roles', null);
        
        res.render('roles_list', {
            title: PAGE_TITLE,
            roles
        });
    } catch (error) {
        console.error('載入角色列表錯誤:', error);
        flash(req, 'error', '載入角色列表失敗');
        res.redirect('/');
    }
});

// 新增角色頁面
app.get('/roles/add', requireAdmin, (req, res) => {
    try {
        res.render('add_role', {
            title: PAGE_TITLE
        });
    } catch (error) {
        console.error('載入新增角色頁面錯誤:', error);
        flash(req, 'error', '載入頁面失敗');
        res.redirect('/roles');
    }
});

// 處理新增角色
app.post('/roles/add', requireAdmin, (req, res) => {
    const { role_name, display_name, description, permissions } = req.body;
    
    try {
        if (!role_name || !display_name) {
            flash(req, 'error', '請填寫角色名稱和顯示名稱');
            return res.redirect('/roles/add');
        }
        
        // 處理權限
        const permissionsObj = {};
        if (permissions && Array.isArray(permissions)) {
            permissions.forEach(perm => {
                const [module, action] = perm.split(':');
                if (!permissionsObj[module]) {
                    permissionsObj[module] = [];
                }
                permissionsObj[module].push(action);
            });
        }
        
        const stmt = db.prepare(`
            INSERT INTO roles (role_name, display_name, description, permissions, is_system)
            VALUES (?, ?, ?, ?, 0)
        `);
        
        const result = stmt.run(
            role_name.toLowerCase().trim(),
            display_name.trim(),
            description || null,
            JSON.stringify(permissionsObj)
        );
        
        logActivity(req, 'create', `新增角色：${display_name}`, 'role', result.lastInsertRowid);
        flash(req, 'success', '角色新增成功！');
        res.redirect('/roles');
    } catch (error) {
        console.error('新增角色錯誤:', error);
        flash(req, 'error', error.message.includes('UNIQUE') ? '角色名稱已存在' : '新增角色失敗');
        res.redirect('/roles/add');
    }
});

// 編輯角色頁面
app.get('/roles/edit/:id', requireAdmin, (req, res) => {
    try {
        const stmt = db.prepare('SELECT * FROM roles WHERE id = ?');
        const role = stmt.get(req.params.id);
        
        if (!role) {
            flash(req, 'error', '角色不存在');
            return res.redirect('/roles');
        }
        
        res.render('edit_role', {
            title: PAGE_TITLE,
            role
        });
    } catch (error) {
        console.error('載入編輯角色頁面錯誤:', error);
        flash(req, 'error', '載入頁面失敗');
        res.redirect('/roles');
    }
});

// 處理編輯角色
app.post('/roles/edit/:id', requireAdmin, (req, res) => {
    const { role_name, display_name, description, permissions } = req.body;
    const roleId = req.params.id;
    
    try {
        // 檢查角色是否存在
        const checkStmt = db.prepare('SELECT * FROM roles WHERE id = ?');
        const existingRole = checkStmt.get(roleId);
        
        if (!existingRole) {
            flash(req, 'error', '角色不存在');
            return res.redirect('/roles');
        }
        
        if (!display_name) {
            flash(req, 'error', '請填寫顯示名稱');
            return res.redirect(`/roles/edit/${roleId}`);
        }
        
        // 處理權限
        const permissionsObj = {};
        if (permissions && Array.isArray(permissions)) {
            permissions.forEach(perm => {
                const [module, action] = perm.split(':');
                if (!permissionsObj[module]) {
                    permissionsObj[module] = [];
                }
                permissionsObj[module].push(action);
            });
        }
        
        // 系統角色不允許修改 role_name
        let updateQuery, updateParams;
        if (existingRole.is_system) {
            updateQuery = `
                UPDATE roles 
                SET display_name = ?, description = ?, permissions = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `;
            updateParams = [display_name.trim(), description || null, JSON.stringify(permissionsObj), roleId];
        } else {
            updateQuery = `
                UPDATE roles 
                SET role_name = ?, display_name = ?, description = ?, permissions = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `;
            updateParams = [role_name.toLowerCase().trim(), display_name.trim(), description || null, JSON.stringify(permissionsObj), roleId];
        }
        
        const stmt = db.prepare(updateQuery);
        stmt.run(...updateParams);
        
        logActivity(req, 'update', `編輯角色：${display_name}`, 'role', roleId);
        flash(req, 'success', '角色更新成功！');
        res.redirect('/roles');
    } catch (error) {
        console.error('編輯角色錯誤:', error);
        flash(req, 'error', error.message.includes('UNIQUE') ? '角色名稱已存在' : '編輯角色失敗');
        res.redirect(`/roles/edit/${roleId}`);
    }
});

// 刪除角色
app.post('/roles/delete/:id', requireAdmin, (req, res) => {
    const roleId = req.params.id;
    
    try {
        // 檢查是否為系統角色
        const checkStmt = db.prepare('SELECT * FROM roles WHERE id = ?');
        const role = checkStmt.get(roleId);
        
        if (!role) {
            flash(req, 'error', '角色不存在');
            return res.redirect('/roles');
        }
        
        if (role.is_system) {
            flash(req, 'error', '系統角色不能刪除');
            return res.redirect('/roles');
        }
        
        // 檢查是否有使用者使用此角色
        const userCheckStmt = db.prepare('SELECT COUNT(*) as count FROM users WHERE role = ?');
        const userCount = userCheckStmt.get(role.role_name);
        
        if (userCount && userCount.count > 0) {
            flash(req, 'error', `無法刪除：仍有 ${userCount.count} 個使用者使用此角色`);
            return res.redirect('/roles');
        }
        
        const stmt = db.prepare('DELETE FROM roles WHERE id = ?');
        stmt.run(roleId);
        
        logActivity(req, 'delete', `刪除角色：${role.display_name}`, 'role', roleId);
        flash(req, 'success', '角色刪除成功！');
        res.redirect('/roles');
    } catch (error) {
        console.error('刪除角色錯誤:', error);
        flash(req, 'error', '刪除角色失敗');
        res.redirect('/roles');
    }
});

// ==================== 操作記錄路由 ====================
// 操作記錄列表
app.get('/activity-logs', requireAdmin, (req, res) => {
    try {
        const { username, action_type, date_from, date_to } = req.query;
        
        let whereConditions = [];
        let params = [];
        
        if (username && username.trim()) {
            whereConditions.push('username LIKE ?');
            params.push(`%${username.trim()}%`);
        }
        
        if (action_type && action_type.trim()) {
            whereConditions.push('action_type = ?');
            params.push(action_type.trim());
        }
        
        if (date_from && date_from.trim()) {
            whereConditions.push('DATE(created_at) >= ?');
            params.push(date_from.trim());
        }
        
        if (date_to && date_to.trim()) {
            whereConditions.push('DATE(created_at) <= ?');
            params.push(date_to.trim());
        }
        
        const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
        
        const stmt = db.prepare(`
            SELECT * FROM activity_logs
            ${whereClause}
            ORDER BY created_at DESC
            LIMIT 500
        `);
        
        const logs = stmt.all(...params);
        
        logActivity(req, 'view', '查看操作記錄', 'activity_logs', null);
        
        res.render('activity_logs', {
            title: PAGE_TITLE,
            logs,
            username: username || '',
            action_type: action_type || '',
            date_from: date_from || '',
            date_to: date_to || ''
        });
    } catch (error) {
        console.error('載入操作記錄錯誤:', error);
        flash(req, 'error', '載入操作記錄失敗');
        res.redirect('/');
    }
});

// 啟動伺服器
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 庫存管理系統已啟動！`);
    console.log(`📡 請訪問：http://localhost:${PORT}`);
    console.log(`🌐 區域網路訪問：http://[您的IP]:${PORT}`);
});

// 優雅關閉
process.on('SIGINT', () => {
    db.close();
    console.log('\n👋 系統已關閉');
    process.exit(0);
});

