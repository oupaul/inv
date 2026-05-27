#!/bin/bash

# 庫存管理系統 - 備份腳本
# 使用方式: ./backup.sh [備份目標目錄] [備份檔案名稱前綴]

# 顏色定義
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# 獲取腳本所在目錄
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# 讀取 .env 檔案獲取備份目錄
DEFAULT_BACKUP_DIR="$SCRIPT_DIR/backups"
if [ -f "$SCRIPT_DIR/.env" ]; then
    BACKUP_DIR_FROM_ENV=$(grep "^BACKUP_DIR=" "$SCRIPT_DIR/.env" | cut -d'=' -f2 | tr -d '"' | tr -d "'")
    if [ -n "$BACKUP_DIR_FROM_ENV" ]; then
        DEFAULT_BACKUP_DIR="$BACKUP_DIR_FROM_ENV"
    fi
fi

# 預設備份目錄
BACKUP_DIR="${1:-$DEFAULT_BACKUP_DIR}"
BACKUP_PREFIX="${2:-inventory_backup}"

# 資料庫檔案路徑
DB_FILE="$SCRIPT_DIR/inventory.db"
DB_WAL="$SCRIPT_DIR/inventory.db-wal"
DB_SHM="$SCRIPT_DIR/inventory.db-shm"

# 檢查資料庫檔案是否存在
if [ ! -f "$DB_FILE" ]; then
    echo -e "${RED}❌ 錯誤：找不到資料庫檔案 $DB_FILE${NC}"
    exit 1
fi

# 創建備份目錄（如果不存在）
mkdir -p "$BACKUP_DIR"

# 生成備份檔案名稱（包含時間戳）
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILENAME="${BACKUP_PREFIX}_${TIMESTAMP}.db"
BACKUP_PATH="$BACKUP_DIR/$BACKUP_FILENAME"

echo -e "${YELLOW}📦 開始備份資料庫...${NC}"
echo "  資料庫檔案: $DB_FILE"
echo "  備份目標: $BACKUP_PATH"
echo ""

# 執行 WAL checkpoint（如果使用 WAL 模式）
if [ -f "$DB_WAL" ]; then
    echo -e "${YELLOW}⚠️  偵測到 WAL 檔案，正在執行 checkpoint 以確保資料完整性...${NC}"
    
    # 方法1: 使用 Node.js 執行 checkpoint（優先，因為系統已有 Node.js）
    if command -v node > /dev/null 2>&1 && [ -f "$SCRIPT_DIR/package.json" ]; then
        echo "  使用 Node.js 執行 WAL checkpoint..."
        cd "$SCRIPT_DIR"
        
        CHECKPOINT_OUTPUT=$(node -e "
            const Database = require('better-sqlite3');
            try {
                const db = new Database('inventory.db', {timeout: 5000});
                const result = db.pragma('wal_checkpoint(FULL)', {simple: true});
                db.close();
                if (result === 0) {
                    console.log('SUCCESS');
                    process.exit(0);
                } else {
                    console.log('PARTIAL');
                    process.exit(0);
                }
            } catch (err) {
                if (err.message.includes('database is locked')) {
                    console.log('LOCKED');
                } else {
                    console.log('ERROR: ' + err.message);
                }
                process.exit(1);
            }
        " 2>&1)
        
        CHECKPOINT_EXIT_CODE=$?
        if [ $CHECKPOINT_EXIT_CODE -eq 0 ] && echo "$CHECKPOINT_OUTPUT" | grep -q "SUCCESS"; then
            echo -e "${GREEN}✓ WAL checkpoint 完成${NC}"
        elif [ $CHECKPOINT_EXIT_CODE -eq 0 ] && echo "$CHECKPOINT_OUTPUT" | grep -q "PARTIAL"; then
            echo -e "${YELLOW}⚠️  WAL checkpoint 部分完成（部分 WAL 資料未合併）${NC}"
        elif echo "$CHECKPOINT_OUTPUT" | grep -q "LOCKED"; then
            echo -e "${RED}⚠️  資料庫被鎖定，無法執行 checkpoint${NC}"
            echo -e "${YELLOW}   建議先停止伺服器，然後再執行備份${NC}"
            read -p "   是否仍要繼續備份（可能不完整）？(y/n): " CONTINUE_BACKUP
            if [[ ! "$CONTINUE_BACKUP" =~ ^[Yy]$ ]]; then
                echo -e "${YELLOW}取消備份操作${NC}"
                exit 0
            fi
        else
            echo -e "${YELLOW}⚠️  WAL checkpoint 失敗${NC}"
            if echo "$CHECKPOINT_OUTPUT" | grep -q "ERROR"; then
                ERROR_MSG=$(echo "$CHECKPOINT_OUTPUT" | grep "ERROR" | cut -d':' -f2-)
                echo "  錯誤: $ERROR_MSG"
            fi
            echo -e "${YELLOW}   建議先停止伺服器，然後再執行備份${NC}"
            read -p "   是否仍要繼續備份（可能不完整）？(y/n): " CONTINUE_BACKUP
            if [[ ! "$CONTINUE_BACKUP" =~ ^[Yy]$ ]]; then
                echo -e "${YELLOW}取消備份操作${NC}"
                exit 0
            fi
        fi
    # 方法2: 使用 sqlite3 命令（如果已安裝）
    elif command -v sqlite3 > /dev/null 2>&1; then
        echo "  使用 sqlite3 執行 WAL checkpoint..."
        sqlite3 "$DB_FILE" "PRAGMA wal_checkpoint(FULL);" 2>/dev/null
        if [ $? -eq 0 ]; then
            echo -e "${GREEN}✓ WAL checkpoint 完成${NC}"
        else
            echo -e "${YELLOW}⚠️  WAL checkpoint 失敗，建議先停止伺服器${NC}"
        fi
    else
        echo -e "${YELLOW}⚠️  無法執行 checkpoint（需要 Node.js 或 sqlite3），建議先停止伺服器${NC}"
        echo -e "${YELLOW}   或者安裝 sqlite3: apt-get install sqlite3${NC}"
    fi
    echo ""
fi

# 複製資料庫檔案
echo -e "${YELLOW}📋 正在複製資料庫檔案...${NC}"
if cp "$DB_FILE" "$BACKUP_PATH" 2>/dev/null; then
    # 獲取檔案大小
    FILE_SIZE=$(du -h "$BACKUP_PATH" | cut -f1)
    
    # 驗證備份檔案
    BACKUP_SIZE=$(stat -f%z "$BACKUP_PATH" 2>/dev/null || stat -c%s "$BACKUP_PATH" 2>/dev/null || echo "0")
    ORIGINAL_SIZE=$(stat -f%z "$DB_FILE" 2>/dev/null || stat -c%s "$DB_FILE" 2>/dev/null || echo "0")
    
    echo -e "${GREEN}✅ 備份成功！${NC}"
    echo "  檔案名稱: $BACKUP_FILENAME"
    echo "  檔案大小: $FILE_SIZE"
    echo "  備份位置: $BACKUP_PATH"
    echo ""
    
    # 驗證備份檔案完整性
    echo -e "${YELLOW}🔍 驗證備份檔案完整性...${NC}"
    
    # 方法1: 使用 Node.js 驗證（優先）
    if command -v node > /dev/null 2>&1 && [ -f "$SCRIPT_DIR/package.json" ]; then
        VALIDATION_RESULT=$(cd "$SCRIPT_DIR" && node -e "
            const Database = require('better-sqlite3');
            try {
                const db = new Database('$BACKUP_PATH');
                const tableCount = db.prepare('SELECT COUNT(*) as count FROM sqlite_master WHERE type=\"table\"').get().count;
                let userCount = 0;
                let partCount = 0;
                try {
                    userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
                } catch(e) {}
                try {
                    partCount = db.prepare('SELECT COUNT(*) as count FROM parts').get().count;
                } catch(e) {}
                db.close();
                console.log(JSON.stringify({success: true, tables: tableCount, users: userCount, parts: partCount}));
            } catch (err) {
                console.log(JSON.stringify({success: false, error: err.message}));
            }
        " 2>/dev/null)
        
        if echo "$VALIDATION_RESULT" | grep -q '"success":true'; then
            TABLE_COUNT=$(echo "$VALIDATION_RESULT" | grep -o '"tables":[0-9]*' | cut -d':' -f2)
            USER_COUNT=$(echo "$VALIDATION_RESULT" | grep -o '"users":[0-9]*' | cut -d':' -f2)
            PART_COUNT=$(echo "$VALIDATION_RESULT" | grep -o '"parts":[0-9]*' | cut -d':' -f2)
            echo -e "${GREEN}✓ 備份檔案包含 ${TABLE_COUNT} 個資料表${NC}"
            echo "  使用者數量: ${USER_COUNT}"
            echo "  料件數量: ${PART_COUNT}"
        else
            echo -e "${RED}⚠️  警告：無法讀取備份檔案，可能已損壞${NC}"
        fi
    # 方法2: 使用 sqlite3 驗證
    elif command -v sqlite3 > /dev/null 2>&1; then
        if sqlite3 "$BACKUP_PATH" "SELECT COUNT(*) FROM sqlite_master WHERE type='table';" > /dev/null 2>&1; then
            TABLE_COUNT=$(sqlite3 "$BACKUP_PATH" "SELECT COUNT(*) FROM sqlite_master WHERE type='table';" 2>/dev/null || echo "0")
            echo -e "${GREEN}✓ 備份檔案包含 $TABLE_COUNT 個資料表${NC}"
            
            if [ "$TABLE_COUNT" -gt 0 ]; then
                USER_COUNT=$(sqlite3 "$BACKUP_PATH" "SELECT COUNT(*) FROM users;" 2>/dev/null || echo "0")
                PART_COUNT=$(sqlite3 "$BACKUP_PATH" "SELECT COUNT(*) FROM parts;" 2>/dev/null || echo "0")
                echo "  使用者數量: $USER_COUNT"
                echo "  料件數量: $PART_COUNT"
            fi
        else
            echo -e "${RED}⚠️  警告：無法讀取備份檔案，可能已損壞${NC}"
        fi
    else
        echo -e "${YELLOW}⚠️  無法驗證備份檔案（需要 Node.js 或 sqlite3）${NC}"
    fi
    echo ""
    
    # 注意：不再備份 WAL 和 SHM 檔案，因為已經執行 checkpoint 合併到主資料庫
    # 備份單一的 .db 檔案即可包含所有資料

    # ===== 保留策略：清理舊備份 =====
    # 預設：保留最近 30 天，且至少保留最近 7 份（取較多者）
    # 可用環境變數覆蓋：BACKUP_RETENTION_DAYS、BACKUP_RETENTION_MIN_FILES
    RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
    RETENTION_MIN_FILES="${BACKUP_RETENTION_MIN_FILES:-7}"

    if [ "$RETENTION_DAYS" -gt 0 ] || [ "$RETENTION_MIN_FILES" -gt 0 ]; then
        echo -e "${YELLOW}🧹 清理舊備份（保留策略：${RETENTION_DAYS} 天 / 至少 ${RETENTION_MIN_FILES} 份）...${NC}"

        # 列出此前綴的備份檔案，依時間新到舊排序
        # 注意：限定 BACKUP_PREFIX 開頭，絕不刪到其他檔案
        cd "$BACKUP_DIR" || exit 0
        ALL_BACKUPS=$(ls -1t "${BACKUP_PREFIX}"_*.db 2>/dev/null)
        TOTAL=$(echo "$ALL_BACKUPS" | grep -c .)
        DELETED=0

        if [ "$TOTAL" -le "$RETENTION_MIN_FILES" ]; then
            echo "  目前 ${TOTAL} 份備份 ≤ 最低保留 ${RETENTION_MIN_FILES} 份，不刪除"
        else
            # 跳過前 N 份最新的（至少保留），其餘按天數判斷
            INDEX=0
            for f in $ALL_BACKUPS; do
                INDEX=$((INDEX+1))
                if [ "$INDEX" -le "$RETENTION_MIN_FILES" ]; then
                    continue  # 保留最近 N 份不管多舊
                fi
                # 取得檔案修改時間（mtime）距今的天數
                # GNU stat (Linux) 與 BSD stat (macOS) 不同，兩者都試
                MTIME=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null)
                if [ -z "$MTIME" ]; then continue; fi
                NOW=$(date +%s)
                AGE_DAYS=$(( (NOW - MTIME) / 86400 ))
                if [ "$AGE_DAYS" -gt "$RETENTION_DAYS" ]; then
                    rm -f "$f"
                    echo "  - 刪除 $f（${AGE_DAYS} 天前）"
                    DELETED=$((DELETED+1))
                fi
            done
            if [ "$DELETED" -eq 0 ]; then
                echo "  沒有超過 ${RETENTION_DAYS} 天的舊備份"
            else
                echo -e "${GREEN}✓ 已清理 ${DELETED} 份舊備份${NC}"
            fi
        fi
        cd "$SCRIPT_DIR" || true
    fi

    exit 0
else
    echo -e "${RED}❌ 備份失敗！${NC}"
    echo "  請檢查："
    echo "  1. 是否有寫入權限"
    echo "  2. 磁碟空間是否足夠"
    echo "  3. 備份目錄是否存在"
    exit 1
fi
