#!/bin/bash

# 庫存管理系統 - 還原腳本
# 使用方式: ./restore.sh [備份資料夾路徑] [備份檔案名稱]

# 顏色定義
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

# 獲取腳本所在目錄
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# 嘗試從 .env 檔案獲取安裝目錄
INSTALL_DIR=""
if [ -f "$SCRIPT_DIR/.env" ]; then
    INSTALL_DIR_FROM_ENV=$(grep "^INSTALL_DIR=" "$SCRIPT_DIR/.env" | cut -d'=' -f2 | tr -d '"' | tr -d "'")
    if [ -n "$INSTALL_DIR_FROM_ENV" ] && [ -d "$INSTALL_DIR_FROM_ENV" ]; then
        INSTALL_DIR="$INSTALL_DIR_FROM_ENV"
    fi
fi

# 如果找到安裝目錄，使用它；否則使用腳本所在目錄
if [ -n "$INSTALL_DIR" ]; then
    WORK_DIR="$INSTALL_DIR"
    echo -e "${BLUE}📂 偵測到安裝目錄: $INSTALL_DIR${NC}"
    echo ""
else
    WORK_DIR="$SCRIPT_DIR"
    echo -e "${YELLOW}⚠️  未找到安裝目錄配置，使用腳本所在目錄: $SCRIPT_DIR${NC}"
    echo ""
fi

cd "$WORK_DIR"

# 資料庫檔案路徑
DB_FILE="$WORK_DIR/inventory.db"
DB_WAL="$WORK_DIR/inventory.db-wal"
DB_SHM="$WORK_DIR/inventory.db-shm"

# 如果提供了參數，直接使用
if [ $# -ge 2 ]; then
    BACKUP_DIR="$1"
    BACKUP_FILE="$2"
    BACKUP_PATH="$BACKUP_DIR/$BACKUP_FILE"
    
    if [ ! -f "$BACKUP_PATH" ]; then
        echo -e "${RED}❌ 錯誤：找不到備份檔案 $BACKUP_PATH${NC}"
        exit 1
    fi
    
    SELECTED_BACKUP="$BACKUP_PATH"
else
    # 互動式選擇備份檔案
    echo -e "${BLUE}📂 選擇備份資料夾：${NC}"
    echo ""
    
    # 讀取 .env 檔案獲取備份目錄
    BACKUP_DIR_FROM_ENV=""
    if [ -f "$WORK_DIR/.env" ]; then
        BACKUP_DIR_FROM_ENV=$(grep "^BACKUP_DIR=" "$WORK_DIR/.env" | cut -d'=' -f2 | tr -d '"' | tr -d "'")
    fi
    
    # 預設備份目錄列表
    DEFAULT_DIRS=(
        "$WORK_DIR/backups"
    )
    
    # 如果有從 .env 讀取的備份目錄，加入列表
    if [ -n "$BACKUP_DIR_FROM_ENV" ] && [ -d "$BACKUP_DIR_FROM_ENV" ]; then
        DEFAULT_DIRS+=("$BACKUP_DIR_FROM_ENV")
    fi
    
    # 查找 /opt 下的其他備份資料夾
    OPT_DIRS=()
    if [ -d "/opt" ]; then
        while IFS= read -r dir; do
            if [ -d "$dir" ] && [ "$dir" != "/opt" ]; then
                OPT_DIRS+=("$dir")
            fi
        done < <(find /opt -maxdepth 2 -type d 2>/dev/null | grep -E "(backup|inventory)" | sort)
    fi
    
    # 合併所有目錄並去重
    ALL_DIRS=("${DEFAULT_DIRS[@]}" "${OPT_DIRS[@]}")
    
    # 去重：只保留唯一的目錄路徑
    UNIQUE_DIRS=()
    for dir in "${ALL_DIRS[@]}"; do
        # 標準化路徑（移除尾隨斜線）
        NORMALIZED_DIR=$(echo "$dir" | sed 's|/$||')
        # 檢查是否已經存在
        FOUND=0
        for unique_dir in "${UNIQUE_DIRS[@]}"; do
            if [ "$NORMALIZED_DIR" = "$unique_dir" ]; then
                FOUND=1
                break
            fi
        done
        if [ $FOUND -eq 0 ]; then
            UNIQUE_DIRS+=("$NORMALIZED_DIR")
        fi
    done
    
    # 顯示可用的備份目錄
    AVAILABLE_DIRS=()
    DIR_INDEX=1
    
    echo "可用的備份資料夾："
    for dir in "${UNIQUE_DIRS[@]}"; do
        if [ -d "$dir" ]; then
            BACKUP_COUNT=$(find "$dir" -maxdepth 1 -type f \( -name "*.db" -o -name "*.sqlite" -o -name "*.sqlite3" \) 2>/dev/null | wc -l)
            if [ "$BACKUP_COUNT" -gt 0 ]; then
                echo "  $DIR_INDEX) $dir ($BACKUP_COUNT 個備份檔案)"
                AVAILABLE_DIRS+=("$dir")
                ((DIR_INDEX++))
            fi
        fi
    done
    
    if [ ${#AVAILABLE_DIRS[@]} -eq 0 ]; then
        echo -e "${RED}❌ 找不到任何備份資料夾或備份檔案${NC}"
        exit 1
    fi
    
    echo ""
    read -p "請選擇備份資料夾編號 (1-${#AVAILABLE_DIRS[@]}): " SELECTED_DIR_INDEX
    
    if ! [[ "$SELECTED_DIR_INDEX" =~ ^[0-9]+$ ]] || [ "$SELECTED_DIR_INDEX" -lt 1 ] || [ "$SELECTED_DIR_INDEX" -gt ${#AVAILABLE_DIRS[@]} ]; then
        echo -e "${RED}❌ 無效的選擇${NC}"
        exit 1
    fi
    
    SELECTED_DIR="${AVAILABLE_DIRS[$((SELECTED_DIR_INDEX-1))]}"
    
    echo ""
    echo -e "${BLUE}📄 選擇備份檔案：${NC}"
    echo ""
    
    # 列出備份檔案
    BACKUP_FILES=()
    FILE_INDEX=1
    
    while IFS= read -r file; do
        if [ -f "$file" ]; then
            FILENAME=$(basename "$file")
            FILESIZE=$(du -h "$file" | cut -f1)
            FILEDATE=$(stat -c %y "$file" 2>/dev/null | cut -d' ' -f1,2 | cut -d'.' -f1)
            echo "  $FILE_INDEX) $FILENAME"
            echo "     大小: $FILESIZE | 日期: $FILEDATE"
            BACKUP_FILES+=("$file")
            ((FILE_INDEX++))
        fi
    done < <(find "$SELECTED_DIR" -maxdepth 1 -type f \( -name "*.db" -o -name "*.sqlite" -o -name "*.sqlite3" \) 2>/dev/null | sort -r)
    
    if [ ${#BACKUP_FILES[@]} -eq 0 ]; then
        echo -e "${RED}❌ 該資料夾中沒有找到備份檔案${NC}"
        exit 1
    fi
    
    echo ""
    read -p "請選擇備份檔案編號 (1-${#BACKUP_FILES[@]}): " SELECTED_FILE_INDEX
    
    if ! [[ "$SELECTED_FILE_INDEX" =~ ^[0-9]+$ ]] || [ "$SELECTED_FILE_INDEX" -lt 1 ] || [ "$SELECTED_FILE_INDEX" -gt ${#BACKUP_FILES[@]} ]; then
        echo -e "${RED}❌ 無效的選擇${NC}"
        exit 1
    fi
    
    SELECTED_BACKUP="${BACKUP_FILES[$((SELECTED_FILE_INDEX-1))]}"
fi

echo ""
echo -e "${YELLOW}⚠️  警告：此操作將覆蓋現有的資料庫！${NC}"
echo "  備份檔案: $SELECTED_BACKUP"
echo "  目標資料庫: $DB_FILE"
echo ""
read -p "確定要還原嗎？(yes/no): " CONFIRM

if [ "$CONFIRM" != "yes" ]; then
    echo -e "${YELLOW}取消還原操作${NC}"
    exit 0
fi

# 檢查備份檔案是否存在
if [ ! -f "$SELECTED_BACKUP" ]; then
    echo -e "${RED}❌ 錯誤：找不到備份檔案 $SELECTED_BACKUP${NC}"
    exit 1
fi

# 驗證備份檔案大小
BACKUP_SIZE=$(stat -f%z "$SELECTED_BACKUP" 2>/dev/null || stat -c%s "$SELECTED_BACKUP" 2>/dev/null || echo "0")
if [ "$BACKUP_SIZE" -lt 10240 ]; then
    echo -e "${RED}⚠️  警告：備份檔案很小（${BACKUP_SIZE} 位元組），可能是空資料庫！${NC}"
    read -p "是否仍要繼續還原？(y/n): " CONTINUE_SMALL
    if [[ ! "$CONTINUE_SMALL" =~ ^[Yy]$ ]]; then
        echo -e "${YELLOW}取消還原操作${NC}"
        exit 0
    fi
fi

# 創建安全備份（如果資料庫存在）
if [ -f "$DB_FILE" ]; then
    # 讀取備份目錄設定
    SAFETY_BACKUP_DIR="$WORK_DIR/backups"
    if [ -f "$WORK_DIR/.env" ]; then
        BACKUP_DIR_FROM_ENV=$(grep "^BACKUP_DIR=" "$WORK_DIR/.env" | cut -d'=' -f2 | tr -d '"' | tr -d "'")
        if [ -n "$BACKUP_DIR_FROM_ENV" ]; then
            SAFETY_BACKUP_DIR="$BACKUP_DIR_FROM_ENV"
        fi
    fi
    
    mkdir -p "$SAFETY_BACKUP_DIR"
    SAFETY_BACKUP="$SAFETY_BACKUP_DIR/safety_backup_before_restore_$(date +%Y%m%d_%H%M%S).db"
    echo ""
    echo -e "${YELLOW}📦 創建當前資料庫的安全備份...${NC}"
    cp "$DB_FILE" "$SAFETY_BACKUP" && \
    echo -e "${GREEN}✓ 安全備份已創建: $(basename $SAFETY_BACKUP)${NC}"
fi

# 停止伺服器（如果正在運行）
echo ""
echo -e "${YELLOW}⏸️  檢查伺服器狀態...${NC}"
if pgrep -f "node.*server.js" > /dev/null; then
    echo -e "${YELLOW}⚠️  偵測到伺服器正在運行，建議先停止伺服器${NC}"
    read -p "是否要停止伺服器？(y/n): " STOP_SERVER
    if [[ "$STOP_SERVER" =~ ^[Yy]$ ]]; then
        if [ -f "$WORK_DIR/stop.sh" ]; then
            bash "$WORK_DIR/stop.sh"
        else
            pkill -f "node.*server.js"
        fi
        sleep 2
    fi
fi

# 執行 WAL checkpoint（如果使用 WAL 模式）
if [ -f "$DB_WAL" ]; then
    echo ""
    echo -e "${YELLOW}⚠️  偵測到 WAL 檔案，正在處理...${NC}"
    if command -v sqlite3 > /dev/null 2>&1; then
        sqlite3 "$DB_FILE" "PRAGMA wal_checkpoint(FULL);" 2>/dev/null || true
    fi
fi

# 還原備份
echo ""
echo -e "${YELLOW}🔄 正在還原備份...${NC}"

# 刪除現有的 WAL 和 SHM 檔案
[ -f "$DB_WAL" ] && rm -f "$DB_WAL"
[ -f "$DB_SHM" ] && rm -f "$DB_SHM"

# 複製備份檔案
echo ""
echo -e "${YELLOW}📋 還原資訊：${NC}"
echo "  來源: $SELECTED_BACKUP"
echo "  目標: $DB_FILE"
echo "  備份大小: $(du -h "$SELECTED_BACKUP" | cut -f1)"
echo ""

if cp "$SELECTED_BACKUP" "$DB_FILE"; then
    RESTORED_SIZE=$(stat -f%z "$DB_FILE" 2>/dev/null || stat -c%s "$DB_FILE" 2>/dev/null || echo "0")
    echo -e "${GREEN}✅ 還原成功！${NC}"
    echo "  還原後資料庫大小: $(du -h "$DB_FILE" | cut -f1)"
    echo ""
    
    if command -v sqlite3 > /dev/null 2>&1; then
        echo -e "${YELLOW}🔍 驗證資料庫完整性...${NC}"
        if sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM sqlite_master WHERE type='table';" > /dev/null 2>&1; then
            TABLE_COUNT=$(sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM sqlite_master WHERE type='table';" 2>/dev/null || echo "0")
            echo -e "${GREEN}✓ 資料庫包含 $TABLE_COUNT 個資料表${NC}"
            
            if [ "$TABLE_COUNT" -gt 0 ]; then
                USER_COUNT=$(sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM users;" 2>/dev/null || echo "0")
                PART_COUNT=$(sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM parts;" 2>/dev/null || echo "0")
                echo "  使用者數量: $USER_COUNT"
                echo "  料件數量: $PART_COUNT"
            fi
        else
            echo -e "${RED}⚠️  警告：無法讀取資料庫，可能已損壞${NC}"
        fi
        echo ""
    fi
    
    echo "下一步："
    echo "  1. 檢查資料庫是否正確還原"
    echo "  2. 重新啟動伺服器"
    echo ""
    read -p "是否要立即啟動伺服器？(y/n): " START_SERVER
    if [[ "$START_SERVER" =~ ^[Yy]$ ]]; then
        if [ -f "$WORK_DIR/quick-start.sh" ]; then
            cd "$WORK_DIR"
            bash "$WORK_DIR/quick-start.sh"
        elif [ -f "$WORK_DIR/server.js" ]; then
            cd "$WORK_DIR"
            node "$WORK_DIR/server.js" &
            echo -e "${GREEN}✓ 伺服器已啟動${NC}"
        else
            echo -e "${YELLOW}⚠️  找不到啟動腳本，請手動啟動伺服器${NC}"
        fi
    fi
    exit 0
else
    echo -e "${RED}❌ 還原失敗！${NC}"
    exit 1
fi
