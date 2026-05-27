// 備份管理（僅管理員）：列表、創建、下載、還原、刪除、排程、/opt 資料夾操作、系統健康
const fs = require('fs');
const path = require('path');
const logger = require('../lib/logger');

module.exports = function mountBackupRoutes(ctx) {
    const { app, db, config, flash, logActivity, requireAdmin, performScheduledBackup } = ctx;
    const PAGE_TITLE = config.PAGE_TITLE;
    const BACKUP_DIR = config.BACKUP_DIR;

    app.get('/backup', requireAdmin, (req, res) => {
        logActivity(req, 'view', '查看備份列表', 'backup', null);
        if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
        let backups = [];
        try {
            backups = fs.readdirSync(BACKUP_DIR)
                .filter(f => f.endsWith('.db') || f.endsWith('.sqlite') || f.endsWith('.sqlite3'))
                .map(f => {
                    const p = path.join(BACKUP_DIR, f);
                    const s = fs.statSync(p);
                    return { filename: f, size: s.size, created: s.birthtime, modified: s.mtime };
                })
                .sort((a, b) => b.created - a.created);
        } catch (e) { logger.error('讀取備份目錄失敗:', e); }
        res.render('backup', { backups, user: req.session.user, title: PAGE_TITLE, backupDir: BACKUP_DIR });
    });

    app.post('/backup/create', requireAdmin, (req, res) => {
        if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const fileName = `inventory_backup_${timestamp}.db`;
            const backupPath = path.join(BACKUP_DIR, fileName);
            const dbPath = path.join(__dirname, '..', 'inventory.db');
            if (fs.existsSync(dbPath)) {
                fs.copyFileSync(dbPath, backupPath);
                logActivity(req, 'backup', `創建備份：${fileName}`, 'backup', null);
                flash(req, 'success', `備份創建成功！檔案名稱：${fileName}`);
            } else {
                flash(req, 'error', '找不到資料庫檔案！');
            }
            res.redirect('/backup');
        } catch (e) {
            flash(req, 'error', `備份失敗：${e.message}`);
            res.redirect('/backup');
        }
    });

    app.get('/backup/download/:filename', requireAdmin, (req, res) => {
        const { filename } = req.params;
        if (!filename.match(/^[a-zA-Z0-9._-]+\.db$/)) {
            flash(req, 'error', '無效的檔案名稱！');
            return res.redirect('/backup');
        }
        const filePath = path.join(BACKUP_DIR, filename);
        if (!fs.existsSync(filePath)) {
            flash(req, 'error', '備份檔案不存在！');
            return res.redirect('/backup');
        }
        res.download(filePath, filename, (err) => {
            if (err) {
                logger.error('下載備份失敗:', err);
                flash(req, 'error', '下載備份失敗！');
                res.redirect('/backup');
            }
        });
    });

    app.post('/backup/restore/:filename', requireAdmin, (req, res) => {
        const { filename } = req.params;
        const backupPath = path.join(BACKUP_DIR, filename);
        const dbPath = path.join(__dirname, '..', 'inventory.db');
        if (!filename.match(/^[a-zA-Z0-9._-]+\.db$/)) {
            flash(req, 'error', '無效的檔案名稱！');
            return res.redirect('/backup');
        }
        if (!fs.existsSync(backupPath)) {
            flash(req, 'error', '備份檔案不存在！');
            return res.redirect('/backup');
        }
        try {
            db.exec('PRAGMA wal_checkpoint(FULL)');
            if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
            if (fs.existsSync(dbPath)) {
                const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                const safety = path.join(BACKUP_DIR, `safety_backup_before_restore_${ts}.db`);
                fs.copyFileSync(dbPath, safety);
                flash(req, 'info', `已自動備份當前資料庫：${path.basename(safety)}`);
            }
            fs.copyFileSync(backupPath, dbPath + '.restore');
            logActivity(req, 'restore', `準備還原備份：${filename}`, 'backup', null);
            flash(req, 'success', '備份檔案已準備還原！');
            flash(req, 'warning', '⚠️ 請重新啟動伺服器以完成還原。');
            res.redirect('/backup');
        } catch (e) {
            flash(req, 'error', `還原準備失敗：${e.message}`);
            res.redirect('/backup');
        }
    });

    app.post('/backup/delete/:filename', requireAdmin, (req, res) => {
        const { filename } = req.params;
        if (!filename.match(/^[a-zA-Z0-9._-]+\.db$/)) {
            flash(req, 'error', '無效的檔案名稱！');
            return res.redirect('/backup');
        }
        const filePath = path.join(BACKUP_DIR, filename);
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                logActivity(req, 'delete', `刪除備份：${filename}`, 'backup', null);
                flash(req, 'success', '備份檔案刪除成功！');
            } else {
                flash(req, 'error', '備份檔案不存在！');
            }
            res.redirect('/backup');
        } catch (e) {
            flash(req, 'error', `刪除失敗：${e.message}`);
            res.redirect('/backup');
        }
    });

    app.get('/backup/schedule', requireAdmin, (req, res) => {
        try {
            const scheduleFile = path.join(__dirname, '..', 'backup-schedule.json');
            let schedule = { enabled: false, time: '02:00', frequency: 'daily', dayOfWeek: 0, dayOfMonth: 1, backupDir: BACKUP_DIR };
            if (fs.existsSync(scheduleFile)) {
                const data = fs.readFileSync(scheduleFile, 'utf8');
                schedule = { ...schedule, ...JSON.parse(data) };
            }
            res.json({ success: true, schedule });
        } catch (e) {
            res.json({ success: false, error: e.message });
        }
    });

    app.post('/backup/test', requireAdmin, (req, res) => {
        try {
            const scheduleFile = path.join(__dirname, '..', 'backup-schedule.json');
            if (!fs.existsSync(scheduleFile)) {
                flash(req, 'error', '請先設定備份排程');
                return res.redirect('/backup');
            }
            performScheduledBackup();
            logActivity(req, 'backup', '手動測試備份', 'backup', null);
            flash(req, 'success', '測試備份已執行！');
            res.redirect('/backup');
        } catch (e) {
            flash(req, 'error', `測試備份失敗：${e.message}`);
            res.redirect('/backup');
        }
    });

    app.post('/backup/schedule', requireAdmin, (req, res) => {
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
            if (!/^([0-1][0-9]|2[0-3]):[0-5][0-9]$/.test(schedule.time)) {
                flash(req, 'error', '時間格式錯誤，請使用 HH:MM 格式');
                return res.redirect('/backup');
            }
            const scheduleFile = path.join(__dirname, '..', 'backup-schedule.json');
            fs.writeFileSync(scheduleFile, JSON.stringify(schedule, null, 2));
            logActivity(req, 'update', `設定備份排程：${schedule.enabled ? '啟用' : '停用'} - ${schedule.frequency} ${schedule.time}`, 'backup', null);
            flash(req, 'success', schedule.enabled
                ? `備份排程已啟用！系統將自動在 ${schedule.frequency === 'daily' ? '每天' : schedule.frequency === 'weekly' ? '每週' : '每月'} ${schedule.time} 執行備份。`
                : '備份排程已停用。');
            res.redirect('/backup');
        } catch (e) {
            flash(req, 'error', `設定失敗：${e.message}`);
            res.redirect('/backup');
        }
    });

    app.get('/backup/opt-folders', requireAdmin, (req, res) => {
        try {
            const folders = [];
            if (fs.existsSync('/opt')) {
                const dirs = fs.readdirSync('/opt', { withFileTypes: true });
                for (const dir of dirs) {
                    if (dir.isDirectory()) {
                        const dirPath = path.join('/opt', dir.name);
                        const files = fs.readdirSync(dirPath).filter(f =>
                            f.endsWith('.db') || f.endsWith('.sqlite') || f.endsWith('.sqlite3'));
                        if (files.length > 0) {
                            folders.push({ name: dir.name, path: dirPath, fileCount: files.length, files: files.slice(0, 10) });
                        }
                    }
                }
            }
            res.json({ success: true, folders });
        } catch (e) {
            res.json({ success: false, error: e.message });
        }
    });

    app.post('/backup/restore-from-opt', requireAdmin, (req, res) => {
        const { folderPath, filename } = req.body;
        if (!folderPath || !filename) {
            flash(req, 'error', '請選擇資料夾和備份檔案');
            return res.redirect('/backup');
        }
        if (!folderPath.startsWith('/opt/') || !filename.match(/^[a-zA-Z0-9._-]+\.(db|sqlite|sqlite3)$/)) {
            flash(req, 'error', '無效的路徑或檔案名稱');
            return res.redirect('/backup');
        }
        const backupPath = path.join(folderPath, filename);
        const dbPath = path.join(__dirname, '..', 'inventory.db');
        if (!fs.existsSync(backupPath)) {
            flash(req, 'error', '備份檔案不存在！');
            return res.redirect('/backup');
        }
        try {
            db.exec('PRAGMA wal_checkpoint(FULL)');
            if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
            if (fs.existsSync(dbPath)) {
                const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                const safety = path.join(BACKUP_DIR, `safety_backup_before_restore_${ts}.db`);
                fs.copyFileSync(dbPath, safety);
                flash(req, 'info', `已自動備份當前資料庫：${path.basename(safety)}`);
            }
            fs.copyFileSync(backupPath, dbPath + '.restore');
            logActivity(req, 'restore', `從 ${folderPath} 還原備份：${filename}`, 'backup', null);
            flash(req, 'success', '備份檔案已準備還原！');
            flash(req, 'warning', '⚠️ 請重新啟動伺服器以完成還原。');
            res.redirect('/backup');
        } catch (e) {
            flash(req, 'error', `還原準備失敗：${e.message}`);
            res.redirect('/backup');
        }
    });

    app.post('/backup/remove-opt-folder', requireAdmin, (req, res) => {
        const { folderPath } = req.body;
        if (!folderPath) {
            flash(req, 'error', '請選擇要刪除的資料夾');
            return res.redirect('/backup');
        }
        if (!folderPath.startsWith('/opt/')) {
            flash(req, 'error', '只能刪除 /opt 下的資料夾');
            return res.redirect('/backup');
        }
        const forbidden = ['/opt/bin', '/opt/etc', '/opt/include', '/opt/lib', '/opt/lib64', '/opt/sbin', '/opt/share'];
        if (forbidden.some(p => folderPath.startsWith(p))) {
            flash(req, 'error', '不能刪除系統重要目錄');
            return res.redirect('/backup');
        }
        try {
            if (!fs.existsSync(folderPath)) {
                flash(req, 'error', '資料夾不存在！');
                return res.redirect('/backup');
            }
            const folderName = path.basename(folderPath);
            fs.rmSync(folderPath, { recursive: true, force: true });
            logActivity(req, 'delete', `刪除 /opt 備份資料夾：${folderPath}`, 'backup', null);
            flash(req, 'success', `資料夾 ${folderName} 已刪除！`);
            res.redirect('/backup');
        } catch (e) {
            flash(req, 'error', `刪除失敗：${e.message}`);
            res.redirect('/backup');
        }
    });

    app.get('/backup/list-folder/:folderPath(*)', requireAdmin, (req, res) => {
        try {
            const folderPath = decodeURIComponent(req.params.folderPath);
            if (!folderPath.startsWith('/opt/') && !folderPath.startsWith(BACKUP_DIR)) {
                return res.json({ success: false, error: '無效的路徑' });
            }
            if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
                return res.json({ success: false, error: '資料夾不存在' });
            }
            const files = fs.readdirSync(folderPath)
                .filter(f => f.endsWith('.db') || f.endsWith('.sqlite') || f.endsWith('.sqlite3'))
                .map(f => {
                    const p = path.join(folderPath, f);
                    const s = fs.statSync(p);
                    return { filename: f, size: s.size, created: s.birthtime, modified: s.mtime };
                })
                .sort((a, b) => b.created - a.created);
            res.json({ success: true, files });
        } catch (e) {
            res.json({ success: false, error: e.message });
        }
    });
};
