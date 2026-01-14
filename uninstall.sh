#!/bin/bash

# 系統卸載腳本
# 使用方式: ./uninstall.sh

echo "=========================================="
echo "   庫存管理系統 - 卸載工具"
echo "=========================================="
echo ""

# 顏色定義
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# 1. 顯示 /opt 下的庫存管理系統資料夾列表
echo -e "${YELLOW}[1/4] 選擇要卸載的安裝目錄...${NC}"
echo ""

# 查找 /opt 下可能的安裝目錄
INSTALL_DIRS=()
if [ -d "/opt" ]; then
    for dir in /opt/*; do
        if [ -d "$dir" ] && [ -f "$dir/server.js" ] && [ -f "$dir/package.json" ]; then
            INSTALL_DIRS+=("$dir")
        fi
    done
fi

if [ ${#INSTALL_DIRS[@]} -eq 0 ]; then
    echo -e "${RED}未找到任何庫存管理系統安裝目錄${NC}"
    exit 1
fi

echo "找到以下安裝目錄："
for i in "${!INSTALL_DIRS[@]}"; do
    echo "  $((i+1))) ${INSTALL_DIRS[$i]}"
done
echo ""

read -p "請選擇要卸載的目錄編號 (1-${#INSTALL_DIRS[@]}): " SELECTED_INDEX
if ! [[ "$SELECTED_INDEX" =~ ^[0-9]+$ ]] || [ "$SELECTED_INDEX" -lt 1 ] || [ "$SELECTED_INDEX" -gt ${#INSTALL_DIRS[@]} ]; then
    echo -e "${RED}無效的選擇${NC}"
    exit 1
fi

SELECTED_DIR="${INSTALL_DIRS[$((SELECTED_INDEX-1))]}"
INSTALL_DIR_NAME=$(basename "$SELECTED_DIR")

echo -e "${GREEN}已選擇: $SELECTED_DIR${NC}"
echo ""

# 2. 顯示相關的 systemd 服務列表
echo -e "${YELLOW}[2/4] 查找相關的 systemd 服務...${NC}"
echo ""

SERVICES=()
# 查找可能的服務名稱
POSSIBLE_SERVICES=("$INSTALL_DIR_NAME.service" "inventory-system.service")

for service_name in "${POSSIBLE_SERVICES[@]}"; do
    if systemctl list-unit-files | grep -q "$service_name"; then
        SERVICES+=("$service_name")
    fi
done

if [ ${#SERVICES[@]} -gt 0 ]; then
    echo "找到以下相關服務："
    for i in "${!SERVICES[@]}"; do
        SERVICE_STATUS=$(systemctl is-active "${SERVICES[$i]}" 2>/dev/null || echo "inactive")
        echo "  $((i+1))) ${SERVICES[$i]} (狀態: $SERVICE_STATUS)"
    done
    echo ""
    read -p "是否要移除這些服務？(y/n) " -n 1 -r
    echo
    REMOVE_SERVICES=$REPLY
else
    echo "未找到相關的 systemd 服務"
    REMOVE_SERVICES="n"
fi
echo ""

# 3. 確認卸載
echo -e "${YELLOW}[3/4] 確認卸載...${NC}"
echo ""
echo "將要卸載："
echo "  安裝目錄: $SELECTED_DIR"
if [ ${#SERVICES[@]} -gt 0 ] && [[ $REMOVE_SERVICES =~ ^[Yy]$ ]]; then
    echo "  服務: ${SERVICES[*]}"
fi
echo ""
read -p "⚠️  確定要卸載嗎？(y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "取消卸載"
    exit 0
fi

# 4. 備份資料
echo ""
echo -e "${YELLOW}[4/4] 執行備份...${NC}"

# 讀取備份目錄設定
BACKUP_BASE="/opt/inventory-backups"
if [ -f "$SELECTED_DIR/.env" ]; then
    BACKUP_BASE_FROM_ENV=$(grep "^BACKUP_DIR=" "$SELECTED_DIR/.env" | cut -d'=' -f2 | tr -d '"' | tr -d "'")
    if [ -n "$BACKUP_BASE_FROM_ENV" ]; then
        BACKUP_BASE="$BACKUP_BASE_FROM_ENV"
    fi
fi

# 建立備份目錄
BACKUP_DIR="$BACKUP_BASE/$(date +%Y%m%d_%H%M%S)_${INSTALL_DIR_NAME}"

mkdir -p "$BACKUP_DIR"

# 備份重要文件
echo "正在備份資料..."
if [ -f "$SELECTED_DIR/inventory.db" ]; then
    cp "$SELECTED_DIR/inventory.db" "$BACKUP_DIR/" 2>/dev/null || true
    echo -e "${GREEN}✓ 資料庫已備份${NC}"
fi

if [ -f "$SELECTED_DIR/inventory.db-shm" ]; then
    cp "$SELECTED_DIR/inventory.db-shm" "$BACKUP_DIR/" 2>/dev/null || true
fi

if [ -f "$SELECTED_DIR/inventory.db-wal" ]; then
    cp "$SELECTED_DIR/inventory.db-wal" "$BACKUP_DIR/" 2>/dev/null || true
fi

# 備份配置文件
if [ -f "$SELECTED_DIR/.env" ]; then
    cp "$SELECTED_DIR/.env" "$BACKUP_DIR/" 2>/dev/null || true
    echo -e "${GREEN}✓ 配置文件已備份${NC}"
fi

# 備份整個目錄結構（可選）
read -p "是否要備份整個安裝目錄？(y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "正在備份整個目錄..."
    tar -czf "$BACKUP_DIR/full_backup.tar.gz" -C "$(dirname "$SELECTED_DIR")" "$INSTALL_DIR_NAME" 2>/dev/null || true
    echo -e "${GREEN}✓ 完整備份已建立${NC}"
fi

echo -e "${GREEN}✓ 備份完成: $BACKUP_DIR${NC}"
echo ""

# 5. 停止服務
echo "🛑 停止服務..."
if [ ${#SERVICES[@]} -gt 0 ] && [[ $REMOVE_SERVICES =~ ^[Yy]$ ]]; then
    for service_name in "${SERVICES[@]}"; do
        sudo systemctl stop "$service_name" 2>/dev/null || true
        echo "  已停止: $service_name"
    done
fi

# 停止可能運行的進程
if [ -f "$SELECTED_DIR/package.json" ]; then
    cd "$SELECTED_DIR"
    pkill -f "node.*server.js" 2>/dev/null || true
fi
echo ""

# 6. 移除 systemd 服務
if [ ${#SERVICES[@]} -gt 0 ] && [[ $REMOVE_SERVICES =~ ^[Yy]$ ]]; then
    echo "🗑️  移除 systemd 服務..."
    for service_name in "${SERVICES[@]}"; do
        sudo systemctl disable "$service_name" 2>/dev/null || true
        sudo rm -f "/etc/systemd/system/$service_name"
        echo "  已移除: $service_name"
    done
    sudo systemctl daemon-reload
    echo -e "${GREEN}✓ systemd 服務已移除${NC}"
    echo ""
fi

# 7. 移除安裝目錄
echo "🗑️  移除安裝目錄..."
read -p "是否要完全刪除安裝目錄 $SELECTED_DIR？(y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    sudo rm -rf "$SELECTED_DIR"
    echo -e "${GREEN}✓ 安裝目錄已移除${NC}"
else
    echo "保留安裝目錄，僅移除以下內容："
    # 移除 node_modules
    if [ -d "$SELECTED_DIR/node_modules" ]; then
        rm -rf "$SELECTED_DIR/node_modules"
        echo "  ✓ node_modules 已移除"
    fi
    
    # 移除日誌
    rm -f "$SELECTED_DIR/inventory.log" "$SELECTED_DIR/nohup.out"
    echo "  ✓ 日誌文件已移除"
    
    # 詢問是否移除資料庫
    read -p "是否要移除資料庫檔案？(y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        rm -f "$SELECTED_DIR/inventory.db" "$SELECTED_DIR/inventory.db-shm" "$SELECTED_DIR/inventory.db-wal"
        echo "  ✓ 資料庫檔案已移除"
    else
        echo "  ✓ 資料庫檔案已保留"
    fi
fi
echo ""

echo "=========================================="
echo -e "   ${GREEN}✓ 卸載完成${NC}"
echo "=========================================="
echo ""
echo "備份位置: $BACKUP_DIR"
echo ""
if [ -d "$SELECTED_DIR" ]; then
    echo "以下內容仍然保留："
    echo "  - 安裝目錄: $SELECTED_DIR"
    echo "  - 原始碼檔案 (server.js, views/, 等)"
    echo "  - 腳本檔案 (*.sh)"
    if [ -f "$SELECTED_DIR/inventory.db" ]; then
        echo "  - 資料庫檔案 (inventory.db)"
    fi
    echo ""
    echo "如需完全刪除，請手動執行："
    echo "  sudo rm -rf $SELECTED_DIR"
fi
echo ""
