// 載入環境變數
require('dotenv').config();

const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const path = require('path');
const ExcelJS = require('exceljs');
const fs = require('fs');
const argon2 = require('argon2');
const QRCodeGen = require('qrcode');

// 抽出的模組
const config = require('./lib/config');
const logger = require('./lib/logger');
const validators = require('./lib/validators');
const { makeAuthMiddleware } = require('./lib/auth');
const { originCheck, createLoginRateLimiter, securityHeaders } = require('./lib/security');

const app = express();
const PORT = config.PORT;
const PAGE_TITLE = config.PAGE_TITLE;
const BACKUP_DIR = config.BACKUP_DIR;

// 反向代理（HSTS / req.secure / req.ip 正確判讀）
app.set('trust proxy', 1);

// 初始化資料庫（支援 :memory: 用於測試）
const IS_MEMORY_DB = config.DB_FILE === ':memory:';
let db = new Database(config.DB_FILE);
if (!IS_MEMORY_DB) db.pragma('journal_mode = WAL');

// 檢查是否有待還原的備份檔案（伺服器啟動時，記憶體 DB 不處理）
const restoreDbPath = IS_MEMORY_DB ? null : path.join(__dirname, config.DB_FILE + '.restore');
if (restoreDbPath && fs.existsSync(restoreDbPath)) {
    try {
        logger.warn('偵測到待還原的備份檔案，正在執行還原...');
        const dbPath = path.join(__dirname, config.DB_FILE);
        const dbWalPath = dbPath + '-wal';
        const dbShmPath = dbPath + '-shm';

        db.close();

        if (fs.existsSync(dbWalPath)) fs.unlinkSync(dbWalPath);
        if (fs.existsSync(dbShmPath)) fs.unlinkSync(dbShmPath);

        if (fs.existsSync(dbPath)) {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            fs.copyFileSync(dbPath, path.join(__dirname, config.DB_FILE + '.backup.' + timestamp));
        }

        fs.renameSync(restoreDbPath, dbPath);

        db = new Database(config.DB_FILE);
        db.pragma('journal_mode = WAL');

        logger.info('✅ 備份還原完成');
    } catch (error) {
        logger.error('❌ 備份還原失敗:', error);
        try {
            db = new Database(config.DB_FILE);
            db.pragma('journal_mode = WAL');
        } catch (e) {
            logger.error('❌ 無法重新連接資料庫:', e);
        }
    }
}

// SQL helpers（從 lib/sql 取出，集中維護）
const { prep, ownedStockSql, physicalStockSql, loanedQtySql, columnExists } = require('./lib/sql')(db);

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
            logger.error('添加 category_id 欄位失敗:', e.message);
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
                logger.warn('無法創建條碼唯一索引:', e.message);
            }
        } catch (e) {
            logger.error('添加 barcode 欄位失敗:', e.message);
        }
    }
    
    // 為現有資料庫添加 is_active 欄位（如果不存在）
    if (!columnExists('parts', 'is_active')) {
        try {
            db.exec(`ALTER TABLE parts ADD COLUMN is_active INTEGER DEFAULT 1`);
        } catch (e) {
            logger.error('添加 is_active 欄位失敗:', e.message);
        }
    }
    
    // 為現有資料庫添加 min_stock 欄位（最低庫存警示）
    if (!columnExists('parts', 'min_stock')) {
        try {
            db.exec(`ALTER TABLE parts ADD COLUMN min_stock INTEGER DEFAULT 0`);
        } catch (e) {
            logger.error('添加 min_stock 欄位失敗:', e.message);
        }
    }

    // 料件圖片路徑
    if (!columnExists('parts', 'image_path')) {
        try {
            db.exec(`ALTER TABLE parts ADD COLUMN image_path TEXT`);
        } catch (e) {
            logger.error('添加 image_path 欄位失敗:', e.message);
        }
    }

    // 成本價（僅管理者可見）與售價，皆為選填
    if (!columnExists('parts', 'cost_price')) {
        try {
            db.exec(`ALTER TABLE parts ADD COLUMN cost_price REAL`);
        } catch (e) {
            logger.error('添加 cost_price 欄位失敗:', e.message);
        }
    }

    if (!columnExists('parts', 'sell_price')) {
        try {
            db.exec(`ALTER TABLE parts ADD COLUMN sell_price REAL`);
        } catch (e) {
            logger.error('添加 sell_price 欄位失敗:', e.message);
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
            logger.error('添加 is_return 欄位失敗:', e.message);
        }
    }
    
    if (!columnExists('inbound_records', 'return_outbound_id')) {
        try {
            db.exec(`ALTER TABLE inbound_records ADD COLUMN return_outbound_id INTEGER`);
        } catch (e) {
            logger.error('添加 return_outbound_id 欄位失敗:', e.message);
        }
    }
    
    // 為現有資料庫添加 created_by 欄位（如果不存在）
    if (!columnExists('inbound_records', 'created_by')) {
        try {
            db.exec(`ALTER TABLE inbound_records ADD COLUMN created_by TEXT`);
        } catch (e) {
            logger.error('添加 inbound_records.created_by 欄位失敗:', e.message);
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
            logger.error('添加 is_loan 欄位失敗:', e.message);
        }
    }
    
    // 為現有資料庫添加借測到期日期欄位（如果不存在）
    if (!columnExists('outbound_records', 'loan_due_date')) {
        try {
            db.exec(`ALTER TABLE outbound_records ADD COLUMN loan_due_date DATE`);
        } catch (e) {
            logger.error('添加 loan_due_date 欄位失敗:', e.message);
        }
    }
    
    // 為現有資料庫添加通知狀態欄位（如果不存在）
    if (!columnExists('outbound_records', 'notification_sent')) {
        try {
            db.exec(`ALTER TABLE outbound_records ADD COLUMN notification_sent INTEGER DEFAULT 0`);
        } catch (e) {
            logger.error('添加 notification_sent 欄位失敗:', e.message);
        }
    }
    
    // 為現有資料庫添加 created_by 欄位（如果不存在）
    if (!columnExists('outbound_records', 'created_by')) {
        try {
            db.exec(`ALTER TABLE outbound_records ADD COLUMN created_by TEXT`);
        } catch (e) {
            logger.error('添加 outbound_records.created_by 欄位失敗:', e.message);
        }
    }
    
    // 為現有資料庫添加 converted_from_loan 欄位（標記是否由借測轉換而來）
    if (!columnExists('outbound_records', 'converted_from_loan')) {
        try {
            db.exec(`ALTER TABLE outbound_records ADD COLUMN converted_from_loan INTEGER DEFAULT 0`);
        } catch (e) {
            logger.error('添加 converted_from_loan 欄位失敗:', e.message);
        }
    }
    
    // 為現有資料庫添加 has_invoice 欄位（標記是否有開立發票）
    if (!columnExists('outbound_records', 'has_invoice')) {
        try {
            db.exec(`ALTER TABLE outbound_records ADD COLUMN has_invoice INTEGER DEFAULT 0`);
        } catch (e) {
            logger.error('添加 has_invoice 欄位失敗:', e.message);
        }
    }
    
    // 為現有資料庫添加 invoice_number 欄位（發票號碼）
    if (!columnExists('outbound_records', 'invoice_number')) {
        try {
            db.exec(`ALTER TABLE outbound_records ADD COLUMN invoice_number TEXT`);
        } catch (e) {
            logger.error('添加 invoice_number 欄位失敗:', e.message);
        }
    }

    // 作廢功能欄位 - inbound_records
    const inboundVoidCols = [
        ['is_voided',        `ALTER TABLE inbound_records ADD COLUMN is_voided INTEGER DEFAULT 0`],
        ['void_reason',      `ALTER TABLE inbound_records ADD COLUMN void_reason TEXT`],
        ['voided_by',        `ALTER TABLE inbound_records ADD COLUMN voided_by TEXT`],
        ['voided_at',        `ALTER TABLE inbound_records ADD COLUMN voided_at TIMESTAMP`],
        ['is_void_reversal', `ALTER TABLE inbound_records ADD COLUMN is_void_reversal INTEGER DEFAULT 0`],
        ['void_source_id',   `ALTER TABLE inbound_records ADD COLUMN void_source_id INTEGER`],
    ];
    inboundVoidCols.forEach(([col, sql]) => {
        if (!columnExists('inbound_records', col)) {
            try { db.exec(sql); } catch (e) { logger.error(`添加 inbound_records.${col} 失敗:`, e.message); }
        }
    });

    // 作廢功能欄位 - outbound_records
    const outboundVoidCols = [
        ['is_voided',        `ALTER TABLE outbound_records ADD COLUMN is_voided INTEGER DEFAULT 0`],
        ['void_reason',      `ALTER TABLE outbound_records ADD COLUMN void_reason TEXT`],
        ['voided_by',        `ALTER TABLE outbound_records ADD COLUMN voided_by TEXT`],
        ['voided_at',        `ALTER TABLE outbound_records ADD COLUMN voided_at TIMESTAMP`],
        ['is_void_reversal', `ALTER TABLE outbound_records ADD COLUMN is_void_reversal INTEGER DEFAULT 0`],
        ['void_source_id',   `ALTER TABLE outbound_records ADD COLUMN void_source_id INTEGER`],
    ];
    outboundVoidCols.forEach(([col, sql]) => {
        if (!columnExists('outbound_records', col)) {
            try { db.exec(sql); } catch (e) { logger.error(`添加 outbound_records.${col} 失敗:`, e.message); }
        }
    });

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
            logger.error('添加 session_id 欄位失敗:', e.message);
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
            logger.error('添加 previous_quantity 欄位失敗:', e.message);
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
        logger.info('更新現有記錄的 system_quantity 失敗（可能不需要）:', e.message);
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
            logger.error('添加 is_adjusted 欄位失敗:', e.message);
        }
    }
    
    if (!columnExists('inventory_checks', 'adjustment_note')) {
        try {
            db.exec(`ALTER TABLE inventory_checks ADD COLUMN adjustment_note TEXT`);
        } catch (e) {
            logger.error('添加 adjustment_note 欄位失敗:', e.message);
        }
    }
    
    if (!columnExists('inventory_checks', 'adjusted_at')) {
        try {
            db.exec(`ALTER TABLE inventory_checks ADD COLUMN adjusted_at TIMESTAMP`);
        } catch (e) {
            logger.error('添加 adjusted_at 欄位失敗:', e.message);
        }
    }
    
    if (!columnExists('inventory_checks', 'adjusted_by')) {
        try {
            db.exec(`ALTER TABLE inventory_checks ADD COLUMN adjusted_by TEXT`);
        } catch (e) {
            logger.error('添加 adjusted_by 欄位失敗:', e.message);
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
            force_password_change INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    if (!columnExists('users', 'force_password_change')) {
        try {
            db.exec(`ALTER TABLE users ADD COLUMN force_password_change INTEGER DEFAULT 0`);
        } catch (e) {
            logger.error('添加 force_password_change 欄位失敗:', e.message);
        }
    }
    
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
    
    // 系統設定表
    db.exec(`
        CREATE TABLE IF NOT EXISTS system_settings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            setting_key TEXT UNIQUE NOT NULL,
            setting_value TEXT,
            description TEXT,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    // 插入預設系統設定（如果不存在）
    const checkSetting = db.prepare('SELECT COUNT(*) as count FROM system_settings WHERE setting_key = ?');
    const forceLogoutSetting = checkSetting.get('force_logout_minutes');
    if (!forceLogoutSetting || forceLogoutSetting.count === 0) {
        const insertSetting = db.prepare(`
            INSERT INTO system_settings (setting_key, setting_value, description)
            VALUES (?, ?, ?)
        `);
        insertSetting.run('force_logout_minutes', '480', '強制使用者登出時間（分鐘），預設 8 小時（480 分鐘）');
    }

    // 插入 Email 通知相關預設設定
    const emailDefaults = [
        ['email_smtp_host',         '',        'SMTP 伺服器位址'],
        ['email_smtp_port',         '587',     'SMTP 連接埠'],
        ['email_smtp_secure',       '0',       'SMTP 使用 SSL/TLS（1=是, 0=否）'],
        ['email_smtp_user',         '',        'SMTP 登入帳號'],
        ['email_smtp_password',     '',        'SMTP 登入密碼'],
        ['email_from_address',      '',        '寄件人 Email 地址'],
        ['email_from_name',         '庫存管理系統', '寄件人顯示名稱'],
        ['email_notify_recipients', '',        '通知收件人（多個以逗號分隔）'],
        ['email_notify_parts',      '1',       '料件新增/編輯/刪除時發送通知'],
        ['email_notify_inbound',    '1',       '入庫時發送通知'],
        ['email_notify_outbound',   '1',       '出庫/借測時發送通知'],
    ];
    const insertEmailSetting = db.prepare(`
        INSERT OR IGNORE INTO system_settings (setting_key, setting_value, description)
        VALUES (?, ?, ?)
    `);
    emailDefaults.forEach(([key, val, desc]) => insertEmailSetting.run(key, val, desc));

    // 發票主表
    db.exec(`
        CREATE TABLE IF NOT EXISTS invoices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_number TEXT NOT NULL UNIQUE,
            invoice_date DATE NOT NULL,
            customer_name TEXT NOT NULL,
            customer_contact TEXT,
            customer_phone TEXT,
            customer_email TEXT,
            subtotal REAL DEFAULT 0,
            tax_rate REAL DEFAULT 0.05,
            tax_amount REAL DEFAULT 0,
            total_amount REAL DEFAULT 0,
            payment_status TEXT DEFAULT 'unpaid',
            payment_due_date DATE,
            payment_date DATE,
            payment_method TEXT,
            payment_note TEXT,
            note TEXT,
            created_by TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // 發票明細表
    db.exec(`
        CREATE TABLE IF NOT EXISTS invoice_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_id INTEGER NOT NULL,
            outbound_id INTEGER,
            part_id INTEGER,
            part_number TEXT,
            part_name TEXT,
            specification TEXT,
            unit TEXT,
            quantity INTEGER NOT NULL DEFAULT 1,
            unit_price REAL NOT NULL DEFAULT 0,
            subtotal REAL NOT NULL DEFAULT 0,
            FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
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
        
        logger.info('✅ 預設角色已創建');
    }
    
    // 創建預設管理員帳號（如果不存在）
    const checkAdmin = db.prepare('SELECT COUNT(*) as count FROM users WHERE username = ?');
    const adminExists = checkAdmin.get('admin');
    
    if (!adminExists || adminExists.count === 0) {
        // 使用 argon2id 加密預設密碼 "admin123"
        // 注意：首次啟動時會同步創建，這裡先創建一個臨時密碼
        // 實際密碼會在首次啟動時通過異步方式創建
        logger.info('⚠️  正在創建預設管理員帳號...');
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
            
            // force_password_change = 1：使用預設密碼 admin123，強制首次登入立即變更
            const insertAdmin = db.prepare(`
                INSERT INTO users (username, password_hash, full_name, email, role, is_active, force_password_change)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `);
            insertAdmin.run('admin', passwordHash, '系統管理員', null, 'admin', 1, 1);

            logger.info('✅ 預設管理員帳號已創建！');
            logger.info('   帳號：admin');
            logger.info('   密碼：admin123');
            logger.info('   ⚠️  首次登入會強制要求變更密碼！');
        }
    } catch (error) {
        logger.error('創建預設管理員帳號失敗:', error.message);
    }
}

initDB();
createDefaultAdmin();

// ===== 高頻查詢用索引（CREATE INDEX IF NOT EXISTS 安全，可重覆執行）=====
function createIndexes() {
    const indexes = [
        // 庫存計算（最熱）：每次 SUM(quantity) WHERE part_id = ?
        `CREATE INDEX IF NOT EXISTS idx_inbound_part_id  ON inbound_records(part_id)`,
        `CREATE INDEX IF NOT EXISTS idx_outbound_part_id ON outbound_records(part_id)`,
        // 出入庫日期查詢、Excel 匯出
        `CREATE INDEX IF NOT EXISTS idx_inbound_date  ON inbound_records(inbound_date)`,
        `CREATE INDEX IF NOT EXISTS idx_outbound_date ON outbound_records(outbound_date)`,
        // 借測對應歸還（loan return JOIN）
        `CREATE INDEX IF NOT EXISTS idx_inbound_return_outbound ON inbound_records(return_outbound_id)`,
        // 借測 / 作廢 / 反向 篩選
        `CREATE INDEX IF NOT EXISTS idx_outbound_is_loan   ON outbound_records(is_loan)`,
        `CREATE INDEX IF NOT EXISTS idx_outbound_is_voided ON outbound_records(is_voided)`,
        `CREATE INDEX IF NOT EXISTS idx_inbound_is_return  ON inbound_records(is_return)`,
        `CREATE INDEX IF NOT EXISTS idx_inbound_is_voided  ON inbound_records(is_voided)`,
        // 借測到期通知
        `CREATE INDEX IF NOT EXISTS idx_outbound_loan_due ON outbound_records(loan_due_date) WHERE is_loan = 1`,
        // 發票
        `CREATE INDEX IF NOT EXISTS idx_invoices_payment_status ON invoices(payment_status)`,
        `CREATE INDEX IF NOT EXISTS idx_invoices_due_date       ON invoices(payment_due_date)`,
        `CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice_id ON invoice_items(invoice_id)`,
        `CREATE INDEX IF NOT EXISTS idx_invoice_items_outbound_id ON invoice_items(outbound_id)`,
        // 操作紀錄查詢
        `CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON activity_logs(created_at)`,
        `CREATE INDEX IF NOT EXISTS idx_activity_logs_user_id    ON activity_logs(user_id)`,
        // 料件搜尋
        `CREATE INDEX IF NOT EXISTS idx_parts_category_id ON parts(category_id)`,
        `CREATE INDEX IF NOT EXISTS idx_parts_is_active   ON parts(is_active)`,
    ];
    for (const sql of indexes) {
        try { db.exec(sql); }
        catch (e) { logger.warn(`索引建立失敗（可能因表尚未建立或欄位不存在）: ${e.message}`); }
    }
    // 建完後分析索引（讓 SQLite 查詢規劃器知道分布）
    try { db.exec('ANALYZE'); } catch (e) { /* ignore */ }
}
createIndexes();

// 設定中介軟體
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// 安全 HTTP 標頭（最早掛載）
app.use(securityHeaders);

app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));

// 檔案上傳（從 lib/uploads 統一管理）
const { upload, uploadPartImage, PART_IMG_DIR } = require('./lib/uploads')({ baseDir: __dirname, config });

// 靜態檔案服務（料件圖片）— 加上 Cache-Control
app.use('/public', express.static(path.join(__dirname, 'public'), {
    maxAge: '7d',
    etag: true,
    setHeaders(res, filePath) {
        if (/\.(html?|json)$/i.test(filePath)) {
            res.setHeader('Cache-Control', 'no-cache');
        }
    }
}));

// Session store：
// - 預設用 better-sqlite3-session-store 持久化（production，真實 sessions.db）
// - SESSION_STORE=memory 時用 express-session 內建 MemoryStore（測試用；同 process 保持、零相依）
let sessionStore;
let sessionDbHandle = null;
if (process.env.SESSION_STORE === 'memory') {
    sessionStore = undefined;  // express-session 預設 MemoryStore
    logger.info('Session store: MemoryStore（測試/開發模式）');
} else {
    try {
        const SqliteStore = require('better-sqlite3-session-store')(session);
        const sessionDbPath = config.SESSION_DB_FILE === ':memory:'
            ? ':memory:'
            : path.join(__dirname, config.SESSION_DB_FILE);
        sessionDbHandle = new Database(sessionDbPath);
        if (sessionDbPath !== ':memory:') sessionDbHandle.pragma('journal_mode = WAL');
        sessionStore = new SqliteStore({
            client: sessionDbHandle,
            expired: { clear: true, intervalMs: 15 * 60 * 1000 }  // 每 15 分鐘清過期
        });
        logger.info('✅ Session store: better-sqlite3 (sessions.db)');
    } catch (e) {
        logger.warn('⚠️  better-sqlite3-session-store 未安裝，使用記憶體 session store（重啟後所有人需重新登入）');
        logger.warn('   執行：npm install better-sqlite3-session-store');
        logger.warn(`   錯誤訊息：${e.message}`);
        sessionStore = undefined;
    }
}

app.use(session({
    name: 'inv.sid',
    secret: config.SESSION_SECRET,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
        maxAge: config.SESSION_MAX_AGE_MS,
        httpOnly: true,
        sameSite: config.COOKIE_SAMESITE,   // 預設 'lax'：SSO 回呼跨站導向需要；CSRF 另由 Origin 檢查把關
        secure: config.COOKIE_SECURE
    }
}));

// 取得伺服器啟動時間作為 asset 版本（給 view 用來做 cache busting）
const ASSET_VERSION = require('./package.json').version + '.' + Date.now();

// Flash message 中介軟體
app.use((req, res, next) => {
    res.locals.messages = req.session.messages || [];
    req.session.messages = [];
    res.locals.user = req.session.user || null;
    res.locals.assetVer = ASSET_VERSION;
    next();
});

// Helpers（flash / logActivity / getSystemSetting / upsertSystemSetting / hasPermission）
const { flash, logActivity, getSystemSetting, upsertSystemSetting, hasPermission } =
    require('./lib/helpers')({ db, prep });

// Email（escapeHtml / buildEmailHtml / sendNotificationEmail）
const { escapeHtml, buildEmailHtml, createMailer } = require('./lib/email');
const sendNotificationEmail = createMailer({ getSystemSetting });

// 借測逾期排程通知
const { createLoanReminderChecker } = require('./lib/loanReminder');
const loanReminderChecker = createLoanReminderChecker({ db, getSystemSetting, buildEmailHtml, sendNotificationEmail });

// 認證 / 授權 middleware（由 lib/auth.js 提供，注入 server.js 內的依賴）
const { requireAuth, requireAdmin, makeGlobalAuthGuard } =
    makeAuthMiddleware({ getSystemSetting, logActivity, flash });

// 來源檢查（Origin/Referer）：對所有非 GET 請求生效
// 允許清單可由 ALLOWED_HOSTS 環境變數（逗號分隔）擴充
const allowedExtraHosts = (process.env.ALLOWED_HOSTS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
app.use(originCheck({ allowedHosts: allowedExtraHosts }));

// 全域認證守門：白名單外的路徑一律需要登入
const PUBLIC_PATHS = ['/login', '/logout', '/healthz', '/favicon.ico', '/auth/sso', '/auth/callback'];
const PUBLIC_PREFIXES = ['/public/'];
app.use(makeGlobalAuthGuard({ publicPaths: PUBLIC_PATHS, publicPrefixes: PUBLIC_PREFIXES }));

// 登入頻率限制（建立後僅套用於 /login POST）
const loginRateLimiter = createLoginRateLimiter();

// === 公共健康檢查端點（不需登入）===
app.get('/healthz', (req, res) => {
    try {
        db.prepare('SELECT 1').get();
        res.json({ ok: true, ts: new Date().toISOString() });
    } catch (e) {
        res.status(503).json({ ok: false, error: 'db_unavailable' });
    }
});

// 認證路由：login / logout / change-password（見 routes/auth.js）
require('./routes/auth')({
    app, db, config, flash, logActivity, loginRateLimiter
});

// M365 / Entra ID SSO 路由（見 routes/sso；未設定 SSO_* 時自動停用）
require('./routes/sso')({ app, db, flash, logActivity });

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
    
    // 強制首次變更密碼：除了 /change-password 之外全部導向
    if (req.session.user.mustChangePassword && req.path !== '/change-password') {
        flash(req, 'warning', '您必須先變更初始密碼才能繼續使用系統。');
        return res.redirect('/change-password');
    }
    
    // 檢查強制登出時間
    const forceLogoutMinutes = parseInt(getSystemSetting('force_logout_minutes', '480'));
    const loginTime = req.session.user.loginTime || Date.now();
    const currentTime = Date.now();
    const sessionDuration = (currentTime - loginTime) / 1000 / 60; // 分鐘
    
    if (sessionDuration > forceLogoutMinutes) {
        // 記錄強制登出操作
        logActivity(req, 'logout', `使用者 ${req.session.user.username} 因超過強制登出時間而登出`, 'user', req.session.user.id);
        
        req.session.destroy((err) => {
            if (err) {
                logger.error('強制登出錯誤:', err);
            }
            flash(req, 'warning', `您的登入時間已超過 ${forceLogoutMinutes} 分鐘，系統已自動登出。請重新登入。`);
            res.redirect('/login');
        });
        return;
    }
    
    next();
});

// ===== 掛載已抽出的路由模組 =====
// 儀表板首頁（見 routes/dashboard）
require('./routes/dashboard')({ app, db, config, ownedStockSql, loanedQtySql, physicalStockSql });

// 料件類型 + 單位（見 routes/categories、routes/units）
require('./routes/categories')({ app, db, config, flash, logActivity });
require('./routes/units')({ app, db, config, flash, logActivity });

// 料件管理 + 條碼/QR/詳情 API（見 routes/parts）
require('./routes/parts')({
    app, db, config, flash, logActivity, getSystemSetting,
    buildEmailHtml, sendNotificationEmail,
    physicalStockSql, loanedQtySql,
    hasPermission, requireAdmin, uploadPartImage
});

// 出入庫 / 借測 / 交易紀錄 / 作廢（見 routes/movements）
require('./routes/movements')({
    app, db, config, flash, logActivity, getSystemSetting,
    buildEmailHtml, sendNotificationEmail, physicalStockSql, requireAdmin
});

// 庫存盤點（見 routes/inventory-check）
require('./routes/inventory-check')({ app, db, config, flash, logActivity, physicalStockSql });

// 匯出 / 匯入（見 routes/reports）
require('./routes/reports')({ app, db, config, flash, logActivity, physicalStockSql, upload });

// 系統健康 + 強制登出設定（見 routes/system）
require('./routes/system')({ app, db, config, flash, logActivity, getSystemSetting, requireAdmin });








// 啟動伺服器
// ==================== 備份排程功能 ====================
let lastBackupCheck = null;
let lastBackupDate = null;

// 執行備份
function performScheduledBackup() {
    try {
        const scheduleFile = path.join(__dirname, 'backup-schedule.json');
        if (!fs.existsSync(scheduleFile)) {
            return;
        }
        
        const scheduleData = fs.readFileSync(scheduleFile, 'utf8');
        const schedule = JSON.parse(scheduleData);
        
        if (!schedule.enabled) {
            return;
        }
        
        // 確保備份目錄存在
        const backupDir = schedule.backupDir || BACKUP_DIR;
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }
        
        // 生成備份檔案名稱
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const backupFileName = `inventory_backup_${timestamp}.db`;
        const backupPath = path.join(backupDir, backupFileName);
        
        // 複製資料庫檔案
        const dbPath = path.join(__dirname, 'inventory.db');
        if (fs.existsSync(dbPath)) {
            // 執行 WAL checkpoint 以確保資料完整性（如果使用 WAL 模式）
            try {
                db.pragma('wal_checkpoint(TRUNCATE)');
            } catch (pragmaError) {
                // 如果失敗，繼續備份（可能不是 WAL 模式）
            }
            
            // 複製資料庫檔案
            fs.copyFileSync(dbPath, backupPath);
            logger.info(`✅ 自動備份完成：${backupFileName}`);
            lastBackupDate = new Date();

            // 記錄活動（使用系統用戶）
            try {
                const stmt = db.prepare(`
                    INSERT INTO activity_logs (username, action_type, action_detail, target_type, ip_address, created_at)
                    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                `);
                stmt.run('系統', 'backup', `自動備份：${backupFileName}`, 'backup', '127.0.0.1');
            } catch (logError) {
                logger.error('記錄備份活動失敗:', logError);
            }

            // 清理舊備份（保留策略）
            cleanupOldBackups(backupDir, schedule);
        }
    } catch (error) {
        logger.error('自動備份失敗:', error);
    }
}

// 備份保留策略：清理超過 N 天且超過 N 份的舊備份
// 設定來源：backup-schedule.json 的 retentionDays / retentionMinFiles，預設 30 天 / 7 份
function cleanupOldBackups(backupDir, schedule) {
    try {
        const retentionDays = parseInt(schedule.retentionDays || 30);
        const retentionMinFiles = parseInt(schedule.retentionMinFiles || 7);
        if (retentionDays <= 0 && retentionMinFiles <= 0) return;

        // 只清此前綴的檔案，絕不誤刪其他
        const PREFIX = 'inventory_backup_';
        const files = fs.readdirSync(backupDir)
            .filter(name => name.startsWith(PREFIX) && name.endsWith('.db'))
            .map(name => {
                const fp = path.join(backupDir, name);
                const stat = fs.statSync(fp);
                return { name, fp, mtimeMs: stat.mtimeMs };
            })
            .sort((a, b) => b.mtimeMs - a.mtimeMs);  // 新到舊

        if (files.length <= retentionMinFiles) return;  // 還沒到最低保留數

        const now = Date.now();
        const cutoffMs = retentionDays * 86400 * 1000;
        let deleted = 0;
        for (let i = retentionMinFiles; i < files.length; i++) {  // 跳過最近 N 份
            const ageMs = now - files[i].mtimeMs;
            if (ageMs > cutoffMs) {
                try {
                    fs.unlinkSync(files[i].fp);
                    deleted++;
                } catch (e) {
                    logger.warn(`刪除舊備份失敗 ${files[i].name}: ${e.message}`);
                }
            }
        }
        if (deleted > 0) logger.info(`🧹 已清理 ${deleted} 份舊備份（保留：${retentionDays} 天 / ${retentionMinFiles} 份）`);
    } catch (e) {
        logger.error('清理舊備份失敗:', e);
    }
}

// 檢查是否需要執行備份
function checkBackupSchedule() {
    try {
        const scheduleFile = path.join(__dirname, 'backup-schedule.json');
        if (!fs.existsSync(scheduleFile)) {
            return;
        }
        
        const scheduleData = fs.readFileSync(scheduleFile, 'utf8');
        const schedule = JSON.parse(scheduleData);
        
        if (!schedule.enabled) {
            return;
        }
        
        const now = new Date();
        const [scheduleHours, scheduleMinutes] = schedule.time.split(':').map(Number);
        
        // 根據頻率檢查是否需要備份
        let shouldBackup = false;
        
        if (schedule.frequency === 'daily') {
            // 每天執行
            shouldBackup = true;
        } else if (schedule.frequency === 'weekly') {
            // 每週指定天執行
            const dayOfWeek = now.getDay(); // 0 = Sunday, 1 = Monday, etc.
            shouldBackup = (dayOfWeek === parseInt(schedule.dayOfWeek || 0));
        } else if (schedule.frequency === 'monthly') {
            // 每月指定日期執行
            const dayOfMonth = now.getDate();
            shouldBackup = (dayOfMonth === parseInt(schedule.dayOfMonth || 1));
        }
        
        if (!shouldBackup) {
            return;
        }
        
        // 檢查時間是否接近設定時間（允許5分鐘誤差）
        const currentMinutes = now.getHours() * 60 + now.getMinutes();
        const scheduleMinutesTotal = scheduleHours * 60 + scheduleMinutes;
        const timeDiff = Math.abs(currentMinutes - scheduleMinutesTotal);
        
        // 在設定時間的前後5分鐘內
        if (timeDiff <= 5) {
            // 檢查今天是否已執行過備份
            const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            if (!lastBackupDate || 
                lastBackupDate < today || 
                (lastBackupDate.getDate() !== now.getDate() || 
                 lastBackupDate.getMonth() !== now.getMonth() || 
                 lastBackupDate.getFullYear() !== now.getFullYear())) {
                logger.info(`⏰ 檢查備份排程：時間已到達 ${schedule.time}，開始執行備份...`);
                performScheduledBackup();
            }
        }
    } catch (error) {
        logger.error('檢查備份排程失敗:', error);
    }
}

// 啟動備份排程檢查（每分鐘檢查一次），保留 handle 以便 SIGINT/SIGTERM 時清理
// 測試模式（require()）下不啟動，避免 timer 卡住 process
let backupIntervalHandle, backupKickoffHandle;
if (require.main === module) {
    backupIntervalHandle = setInterval(checkBackupSchedule, 60 * 1000);
    backupKickoffHandle = setTimeout(checkBackupSchedule, 10 * 1000);
}

// ===== activity_logs 自動清理 =====
// 預設每天 03:00 執行；保留天數來自 config，0 表示不清理
let lastLogCleanupDate = null;

function cleanupActivityLogs(options = {}) {
    const days = options.days != null ? options.days : config.ACTIVITY_LOG_RETENTION_DAYS;
    if (!days || days <= 0) {
        return { skipped: true, reason: 'retention 設為 0（不清理）' };
    }
    try {
        // 用 SQLite 的 datetime 計算邊界，避免時區誤差
        const result = db.prepare(
            `DELETE FROM activity_logs WHERE created_at < datetime('now', ?)`
        ).run(`-${days} days`);

        if (result.changes > 0) {
            logger.info(`🧹 已清理 ${result.changes} 筆超過 ${days} 天的 activity_logs`);
            // VACUUM 才能真的釋放磁碟空間（但會鎖庫，所以僅在大量刪除時做）
            if (result.changes > 1000) {
                try { db.exec('VACUUM'); logger.info('   已執行 VACUUM 釋放空間'); } catch (e) { logger.warn('VACUUM 失敗:', e.message); }
            }
        }
        return { deleted: result.changes, retentionDays: days };
    } catch (e) {
        logger.error('activity_logs 清理失敗:', e);
        return { error: e.message };
    }
}

function checkLogCleanupSchedule() {
    try {
        if (!config.ACTIVITY_LOG_RETENTION_DAYS || config.ACTIVITY_LOG_RETENTION_DAYS <= 0) return;
        const now = new Date();
        // 在 03:00–03:05 的視窗執行（與分鐘 timer 對齊）
        if (now.getHours() !== 3 || now.getMinutes() >= 5) return;
        // 每天只跑一次
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        if (lastLogCleanupDate === today) return;
        lastLogCleanupDate = today;
        cleanupActivityLogs();
    } catch (e) {
        logger.error('檢查 log 清理排程失敗:', e);
    }
}
let logCleanupIntervalHandle;
if (require.main === module) {
    logCleanupIntervalHandle = setInterval(checkLogCleanupSchedule, 60 * 1000);
}

// ===== 借測逾期通知排程（每天 09:00–09:05 檢查一次）=====
let loanReminderIntervalHandle;
if (require.main === module) {
    loanReminderIntervalHandle = setInterval(() => loanReminderChecker.check(), 60 * 1000);
}

// ===== Mount 抽出的路由模組 =====
// 在所有 helper / 排程函式定義之後掛載
{
    const routeCtx = {
        app, db, config, flash, logActivity, getSystemSetting, upsertSystemSetting,
        buildEmailHtml, sendNotificationEmail,
        requireAdmin,
        cleanupActivityLogs, performScheduledBackup
    };
    require('./routes/users')(routeCtx);
    require('./routes/backup')(routeCtx);
    require('./routes/settings')(routeCtx);
    require('./routes/roles')(routeCtx);
    require('./routes/activity-logs')(routeCtx);
}

// 發票管理（見 routes/invoices）
require('./routes/invoices')({ app, db, flash, logActivity, requireAdmin });

// ===== 全域錯誤處理（必須在所有路由之後）=====
// 404
app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ success: false, error: '找不到資源' });
    }
    res.status(404).send('<h2>404</h2><p>找不到頁面。<a href="/">回首頁</a></p>');
});

// 500 — 不洩漏 stack；僅在 dev 顯示錯誤訊息
app.use((err, req, res, next) => {
    logger.error(`[${req.method} ${req.path}]`, err);
    const isApi = req.path.startsWith('/api/') || (req.is && req.is('application/json'));
    const detail = config.isProd ? '伺服器內部錯誤' : (err.message || '伺服器內部錯誤');
    if (isApi) {
        return res.status(500).json({ success: false, error: detail });
    }
    if (!res.headersSent) {
        res.status(500).send(`<h2>系統發生錯誤</h2><pre>${detail.replace(/</g, '&lt;')}</pre>`);
    }
});

let server;
if (require.main === module) {
    server = app.listen(PORT, '0.0.0.0', () => {
        logger.info(`🚀 庫存管理系統已啟動 - port ${PORT} (NODE_ENV=${config.NODE_ENV})`);
        logger.info(`📡 http://localhost:${PORT}`);
        logger.info(`⏰ 備份排程檢查已啟動（每分鐘檢查一次）`);
        logger.info(`⏰ 借測逾期通知排程已啟動（每天 09:00 檢查一次）`);
    });

    // 明確處理 listen 錯誤（最常見：port 被佔用），給清楚指示而非堆疊
    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            logger.error(`❌ 連接埠 ${PORT} 已被佔用，無法啟動。`);
            logger.error(`   查出佔用程序：sudo lsof -i :${PORT}   或   sudo ss -lptn 'sport = :${PORT}'`);
            logger.error(`   結束舊程序：  kill <PID>          或改用其他埠：PORT=xxxx npm start`);
        } else if (err.code === 'EACCES') {
            logger.error(`❌ 沒有權限綁定連接埠 ${PORT}（1024 以下需 root）。請改用 >=1024 的埠。`);
        } else {
            logger.error('❌ 伺服器啟動錯誤:', err);
        }
        process.exit(1);
    });
}

// 優雅關閉：取消計時器、關閉 server、關閉 DB
let isShuttingDown = false;
function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(`收到 ${signal}，開始關閉服務...`);

    if (backupIntervalHandle) clearInterval(backupIntervalHandle);
    if (backupKickoffHandle) clearTimeout(backupKickoffHandle);
    if (logCleanupIntervalHandle) clearInterval(logCleanupIntervalHandle);
    if (loanReminderIntervalHandle) clearInterval(loanReminderIntervalHandle);
    if (loginRateLimiter && loginRateLimiter._stop) loginRateLimiter._stop();

    // 停止接受新連線
    const cleanup = () => {
        try { db.close(); } catch (e) { logger.error('關閉 DB 失敗:', e); }
        try { if (sessionDbHandle) sessionDbHandle.close(); } catch (e) { logger.error('關閉 session DB 失敗:', e); }
        logger.close && logger.close();
        process.exit(0);
    };
    if (server) {
        server.close(cleanup);
    } else {
        cleanup();
    }

    // 保險：10 秒後強制退出
    setTimeout(() => {
        logger.warn('強制退出（10s 超時）');
        process.exit(1);
    }, 10000).unref();
}

if (require.main === module) {
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('uncaughtException', (err) => {
        logger.error('未捕獲的例外:', err);
        gracefulShutdown('uncaughtException');
    });
    process.on('unhandledRejection', (reason) => {
        logger.error('未處理的 Promise rejection:', reason);
    });
}

// === 測試用 export ===
// 測試端可 require('./server') 取得 app（DB_FILE=:memory: 配合可隔離）
// 並透過 closeForTest() 釋放資源
module.exports = {
    app,
    db,
    sessionDbHandle,
    closeForTest: () => {
        try { db.close(); } catch {}
        try { if (sessionDbHandle) sessionDbHandle.close(); } catch {}
    }
};

