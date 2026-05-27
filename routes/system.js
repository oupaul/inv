// 系統健康狀態 + 強制登出設定（僅管理員）
const fs = require('fs');
const path = require('path');
const logger = require('../lib/logger');

module.exports = function mountSystemRoutes(ctx) {
    const { app, db, config, flash, logActivity, getSystemSetting, requireAdmin } = ctx;
    const PAGE_TITLE = config.PAGE_TITLE;
    const baseDir = path.join(__dirname, '..');  // 專案根目錄

    // 系統健康狀態頁面（需要管理員權限）
    app.get('/health', requireAdmin, (req, res) => {
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
                path: path.join(baseDir, 'inventory.db'),
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
            const dbPath = path.join(baseDir, 'inventory.db');
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
        
        // 讀取強制登出時間設定
        const forceLogoutMinutes = getSystemSetting('force_logout_minutes', '480');
        
        res.render('health', { 
            health: healthInfo, 
            user: req.session.user, 
            title: PAGE_TITLE,
            forceLogoutMinutes: parseInt(forceLogoutMinutes)
        });
    });
    
    // API: 獲取系統健康狀態（用於 AJAX 更新）
    app.get('/api/health', requireAdmin, (req, res) => {
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
    
    // API: 獲取強制登出時間設定
    app.get('/api/settings/force-logout', requireAdmin, (req, res) => {
        try {
            const forceLogoutMinutes = getSystemSetting('force_logout_minutes', '480');
            res.json({ success: true, forceLogoutMinutes: parseInt(forceLogoutMinutes) });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });
    
    // API: 保存強制登出時間設定
    app.post('/api/settings/force-logout', requireAdmin, (req, res) => {
        try {
            const { minutes } = req.body;
            
            // 驗證輸入
            const minutesInt = parseInt(minutes);
            if (isNaN(minutesInt) || minutesInt < 1 || minutesInt > 10080) { // 1分鐘到7天（10080分鐘）
                return res.json({ success: false, error: '請輸入 1 到 10080 之間的有效數字（分鐘）' });
            }
            
            // 更新或插入設定
            const upsertStmt = db.prepare(`
                INSERT INTO system_settings (setting_key, setting_value, description, updated_at)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(setting_key) DO UPDATE SET
                    setting_value = excluded.setting_value,
                    updated_at = CURRENT_TIMESTAMP
            `);
            upsertStmt.run('force_logout_minutes', minutesInt.toString(), '強制使用者登出時間（分鐘）');
            
            // 記錄操作
            logActivity(req, 'update', `修改強制登出時間設定為 ${minutesInt} 分鐘`, 'system', null);
            
            res.json({ success: true, message: '設定已保存', forceLogoutMinutes: minutesInt });
        } catch (error) {
            logger.error('保存強制登出時間設定失敗:', error);
            res.json({ success: false, error: error.message });
        }
    });
};
