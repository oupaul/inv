#!/usr/bin/env node

/**
 * 重置管理員密碼腳本
 * 使用方法：
 *   node reset-admin-password.js [新密碼]
 *   如果不提供密碼參數，腳本會提示您輸入新密碼
 */

const Database = require('better-sqlite3');
const argon2 = require('argon2');
const readline = require('readline');
const path = require('path');
const fs = require('fs');

// 資料庫檔案路徑
const dbPath = path.join(__dirname, 'inventory.db');

// 檢查資料庫檔案是否存在
if (!fs.existsSync(dbPath)) {
    console.error('❌ 錯誤：找不到資料庫檔案 inventory.db');
    console.error(`   預期位置：${dbPath}`);
    process.exit(1);
}

// 創建 readline 介面用於互動式輸入
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// 從命令行參數或互動式輸入獲取新密碼
function getNewPassword() {
    return new Promise((resolve) => {
        // 如果提供了命令行參數，直接使用
        if (process.argv.length > 2) {
            const newPassword = process.argv[2];
            if (newPassword.length < 6) {
                console.error('❌ 錯誤：密碼長度至少需要 6 個字元');
                process.exit(1);
            }
            resolve(newPassword);
        } else {
            // 否則使用互動式輸入
            rl.question('請輸入新的管理員密碼（至少 6 個字元）：', (password) => {
                if (password.length < 6) {
                    console.error('❌ 錯誤：密碼長度至少需要 6 個字元');
                    rl.close();
                    process.exit(1);
                }
                rl.question('請再次確認密碼：', (confirmPassword) => {
                    if (password !== confirmPassword) {
                        console.error('❌ 錯誤：兩次輸入的密碼不一致');
                        rl.close();
                        process.exit(1);
                    }
                    rl.close();
                    resolve(password);
                });
            });
        }
    });
}

// 重置密碼主函數
async function resetAdminPassword() {
    try {
        console.log('🔐 開始重置管理員密碼...\n');
        
        // 獲取新密碼
        const newPassword = await getNewPassword();
        
        // 連接資料庫
        console.log('📂 正在連接資料庫...');
        const db = new Database(dbPath);
        db.pragma('journal_mode = WAL');
        
        // 檢查 admin 帳號是否存在
        const checkAdmin = db.prepare('SELECT id, username FROM users WHERE username = ?');
        const admin = checkAdmin.get('admin');
        
        if (!admin) {
            console.error('❌ 錯誤：找不到 admin 帳號');
            console.error('   請確認資料庫中是否存在 admin 使用者');
            db.close();
            process.exit(1);
        }
        
        console.log(`✅ 找到管理員帳號：${admin.username} (ID: ${admin.id})`);
        
        // 使用 argon2 加密新密碼
        console.log('🔒 正在加密新密碼...');
        const passwordHash = await argon2.hash(newPassword, { type: argon2.argon2id });
        
        // 更新密碼
        console.log('💾 正在更新資料庫...');
        const updatePassword = db.prepare('UPDATE users SET password_hash = ? WHERE username = ?');
        const result = updatePassword.run(passwordHash, 'admin');
        
        if (result.changes > 0) {
            console.log('\n✅ 密碼重置成功！');
            console.log(`   帳號：admin`);
            console.log(`   新密碼：${newPassword}`);
            console.log('\n⚠️  請妥善保管新密碼，並在登入後考慮再次修改！');
        } else {
            console.error('❌ 錯誤：更新密碼失敗，未找到要更新的記錄');
            db.close();
            process.exit(1);
        }
        
        // 關閉資料庫連接
        db.close();
        console.log('\n✅ 操作完成！');
        
    } catch (error) {
        console.error('❌ 發生錯誤：', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

// 執行重置密碼
resetAdminPassword();
