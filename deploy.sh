#!/bin/bash

# 庫存管理系統 - Ubuntu 自動部署腳本
# 使用方式: chmod +x deploy.sh && ./deploy.sh

set -e  # 遇到錯誤立即停止

echo "=========================================="
echo "   庫存管理系統 - Ubuntu 自動部署工具"
echo "=========================================="
echo ""

# 顏色定義
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# 自定義配置
echo -e "${YELLOW}請輸入部署配置：${NC}"
echo ""

# 1. 自定義安裝目錄名稱
read -p "安裝目錄名稱（將安裝到 /opt/[名稱]，預設: inventory-system）: " INSTALL_DIR_NAME
INSTALL_DIR_NAME=${INSTALL_DIR_NAME:-inventory-system}
INSTALL_DIR="/opt/$INSTALL_DIR_NAME"

# 驗證目錄名稱（只允許字母、數字、連字號和底線）
if [[ ! "$INSTALL_DIR_NAME" =~ ^[a-zA-Z0-9_-]+$ ]]; then
    echo -e "${RED}錯誤：目錄名稱只能包含字母、數字、連字號和底線${NC}"
    exit 1
fi

# 2. 自定義端口
read -p "服務端口（預設: 5000）: " SERVICE_PORT
SERVICE_PORT=${SERVICE_PORT:-5000}

# 驗證端口範圍
if ! [[ "$SERVICE_PORT" =~ ^[0-9]+$ ]] || [ "$SERVICE_PORT" -lt 1024 ] || [ "$SERVICE_PORT" -gt 65535 ]; then
    echo -e "${RED}錯誤：端口必須是 1024-65535 之間的數字${NC}"
    exit 1
fi

# 3. 自定義瀏覽器標題
read -p "瀏覽器分頁顯示名稱（預設: 庫存管理系統）: " PAGE_TITLE
PAGE_TITLE=${PAGE_TITLE:-庫存管理系統}

# 4. 自定義備份目錄
read -p "備份目錄（預設: /opt/inventory-backups）: " BACKUP_DIR
BACKUP_DIR=${BACKUP_DIR:-/opt/inventory-backups}

echo ""
echo -e "${GREEN}配置摘要：${NC}"
echo "  安裝目錄: $INSTALL_DIR"
echo "  服務端口: $SERVICE_PORT"
echo "  瀏覽器標題: $PAGE_TITLE"
echo "  備份目錄: $BACKUP_DIR"
echo ""
read -p "確認以上配置？(y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "已取消部署"
    exit 0
fi
echo ""

# 1. 檢查是否為 root 或有 sudo 權限
echo -e "${YELLOW}[1/9] 檢查系統權限...${NC}"
if [ "$EUID" -ne 0 ]; then 
    if ! sudo -v; then
        echo -e "${RED}錯誤：需要 sudo 權限來安裝系統依賴${NC}"
        exit 1
    fi
fi
echo -e "${GREEN}✓ 權限檢查通過${NC}"
echo ""

# 1.5. 建立安裝目錄並複製文件
echo -e "${YELLOW}[2/9] 建立安裝目錄...${NC}"
if [ -d "$INSTALL_DIR" ]; then
    echo -e "${YELLOW}警告：目錄 $INSTALL_DIR 已存在${NC}"
    read -p "是否要覆蓋現有安裝？(y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        sudo rm -rf "$INSTALL_DIR"
    else
        echo "已取消部署"
        exit 0
    fi
fi

sudo mkdir -p "$INSTALL_DIR"
CURRENT_DIR=$(pwd)
# 複製所有文件（包括隱藏文件）
sudo sh -c "cd '$CURRENT_DIR' && cp -r . '$INSTALL_DIR/'"
sudo chown -R $USER:$USER "$INSTALL_DIR"
cd "$INSTALL_DIR"

# 修復腳本文件的行尾符並設置執行權限
echo "修復腳本文件格式和權限..."
for script in backup.sh restore.sh deploy.sh quick-start.sh stop.sh status.sh update.sh uninstall.sh fix-all-scripts.sh fix-scripts-now.sh; do
    if [ -f "$script" ]; then
        # 方法1: 使用 tr 徹底移除所有 CR 字符（最可靠）
        tr -d '\r' < "$script" > "${script}.tmp" 2>/dev/null
        if [ $? -eq 0 ] && [ -f "${script}.tmp" ]; then
            mv "${script}.tmp" "$script" 2>/dev/null || true
        fi
        
        # 方法2: 使用 sed 作為備用（處理行尾的 CR）
        sed -i 's/\r$//' "$script" 2>/dev/null || true
        
        # 方法3: 使用 dos2unix（如果已安裝）
        if command -v dos2unix > /dev/null 2>&1; then
            dos2unix "$script" 2>/dev/null || true
        fi
        
        # 確保 shebang 行正確（只對 .sh 文件）
        if [[ "$script" == *.sh ]]; then
            FIRST_LINE=$(head -n 1 "$script" 2>/dev/null | tr -d '\r\n')
            if [ -z "$FIRST_LINE" ] || ! echo "$FIRST_LINE" | grep -q "^#!/bin/bash"; then
                # 如果第一行不是正確的 shebang，修復它
                if echo "$FIRST_LINE" | grep -q "^#"; then
                    # 如果第一行是註釋，替換為正確的 shebang
                    sed -i '1s|^.*$|#!/bin/bash|' "$script" 2>/dev/null || true
                else
                    # 如果第一行不是註釋，在前面插入 shebang
                    printf '#!/bin/bash\n' > "${script}.tmp"
                    tail -n +1 "$script" >> "${script}.tmp" 2>/dev/null
                    mv "${script}.tmp" "$script" 2>/dev/null || true
                fi
            fi
        fi
        
        # 最後一次確保沒有 CR 字符
        tr -d '\r' < "$script" > "${script}.tmp" 2>/dev/null && mv "${script}.tmp" "$script" 2>/dev/null || true
        
        # 設置執行權限
        chmod +x "$script"
        
        # 驗證修復結果
        if head -n 1 "$script" 2>/dev/null | tr -d '\r' | grep -q "^#!/bin/bash"; then
            echo "  ✓ $script"
        else
            echo "  ⚠ $script (可能需要手動檢查)"
        fi
    fi
done
echo -e "${GREEN}✓ 安裝目錄已建立，腳本文件已修復${NC}"
echo ""

# 2. 更新系統套件
echo -e "${YELLOW}[3/9] 更新系統套件...${NC}"
sudo apt update
echo -e "${GREEN}✓ 系統套件已更新${NC}"
echo ""

# 3. 檢查並安裝 Node.js
echo -e "${YELLOW}[4/9] 檢查 Node.js...${NC}"
if ! command -v node &> /dev/null; then
    echo "Node.js 未安裝，正在安裝..."
    
    # 安裝 Node.js 18.x LTS
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt install -y nodejs
    
    echo -e "${GREEN}✓ Node.js 已安裝${NC}"
else
    NODE_VERSION=$(node -v)
    echo -e "${GREEN}✓ Node.js 已安裝 ($NODE_VERSION)${NC}"
fi

# 檢查 npm
if ! command -v npm &> /dev/null; then
    sudo apt install -y npm
fi

NPM_VERSION=$(npm -v)
echo -e "${GREEN}✓ npm 已安裝 ($NPM_VERSION)${NC}"
echo ""

# 4. 安裝專案依賴
echo -e "${YELLOW}[5/9] 安裝專案依賴套件...${NC}"
npm install
echo -e "${GREEN}✓ 依賴套件安裝完成${NC}"
echo ""

# 5. 建立配置文件
echo -e "${YELLOW}[6/9] 建立配置文件...${NC}"
cat > "$INSTALL_DIR/.env" <<EOF
PORT=$SERVICE_PORT
PAGE_TITLE=$PAGE_TITLE
INSTALL_DIR=$INSTALL_DIR
SERVICE_NAME=$INSTALL_DIR_NAME
BACKUP_DIR=$BACKUP_DIR
EOF
echo -e "${GREEN}✓ 配置文件已建立${NC}"
echo ""

# 5.5. 建立備份目錄
echo -e "${YELLOW}[6.5/9] 建立備份目錄...${NC}"
if [ ! -d "$BACKUP_DIR" ]; then
    sudo mkdir -p "$BACKUP_DIR"
    sudo chown -R $USER:$USER "$BACKUP_DIR"
    echo -e "${GREEN}✓ 備份目錄已建立: $BACKUP_DIR${NC}"
else
    echo -e "${GREEN}✓ 備份目錄已存在: $BACKUP_DIR${NC}"
    # 確保目錄權限正確
    sudo chown -R $USER:$USER "$BACKUP_DIR" 2>/dev/null || true
fi
echo ""

# 6. 檢查防火牆設定
echo -e "${YELLOW}[7/9] 檢查防火牆設定...${NC}"
if command -v ufw &> /dev/null; then
    if sudo ufw status | grep -q "Status: active"; then
        echo "偵測到 UFW 防火牆已啟用"
        read -p "是否要開放 $SERVICE_PORT 埠？(y/n) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            sudo ufw allow $SERVICE_PORT/tcp
            echo -e "${GREEN}✓ 已開放 $SERVICE_PORT 埠${NC}"
        fi
    else
        echo "防火牆未啟用，跳過"
    fi
else
    echo "未偵測到 UFW 防火牆，跳過"
fi
echo ""

# 7. 建立 systemd 服務（可選）
echo -e "${YELLOW}[8/9] 設定系統服務...${NC}"
read -p "是否要建立 systemd 服務（開機自動啟動）？(y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    SERVICE_NAME="$INSTALL_DIR_NAME.service"
    SERVICE_FILE="/etc/systemd/system/$SERVICE_NAME"
    
    sudo tee $SERVICE_FILE > /dev/null <<EOF
[Unit]
Description=$PAGE_TITLE
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$INSTALL_DIR
Environment="PORT=$SERVICE_PORT"
Environment="PAGE_TITLE=$PAGE_TITLE"
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=10
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=$INSTALL_DIR_NAME

[Install]
WantedBy=multi-user.target
EOF

    sudo systemctl daemon-reload
    sudo systemctl enable $SERVICE_NAME
    echo -e "${GREEN}✓ systemd 服務已建立 ($SERVICE_NAME)${NC}"
    SERVICE_CREATED=true
else
    echo "跳過 systemd 服務建立"
    SERVICE_CREATED=false
fi
echo ""

# 8. 取得本機 IP
echo -e "${YELLOW}[9/9] 取得網路資訊...${NC}"
LOCAL_IP=$(hostname -I | awk '{print $1}')
echo -e "本機 IP: ${GREEN}$LOCAL_IP${NC}"
echo ""

# 9. 啟動系統
echo -e "${YELLOW}啟動系統...${NC}"
echo ""
echo "請選擇啟動方式："
echo "1) 前景執行（可直接看到日誌，按 Ctrl+C 停止）"
echo "2) 背景執行（使用 nohup）"
if [ "$SERVICE_CREATED" = true ]; then
    echo "3) 使用 systemd 服務啟動（推薦）"
fi
echo ""

read -p "請選擇 (1/2/3): " -n 1 -r
echo
echo ""

case $REPLY in
    1)
        echo -e "${GREEN}=========================================="
        echo "   系統部署完成！正在啟動..."
        echo "==========================================${NC}"
        echo ""
        echo -e "📡 本機訪問: ${GREEN}http://localhost:$SERVICE_PORT${NC}"
        echo -e "🌐 區域網路: ${GREEN}http://$LOCAL_IP:$SERVICE_PORT${NC}"
        echo ""
        echo -e "${YELLOW}按 Ctrl+C 可停止系統${NC}"
        echo ""
        PORT=$SERVICE_PORT PAGE_TITLE="$PAGE_TITLE" npm start
        ;;
    2)
        PORT=$SERVICE_PORT PAGE_TITLE="$PAGE_TITLE" nohup npm start > inventory.log 2>&1 &
        PID=$!
        echo -e "${GREEN}=========================================="
        echo "   系統部署完成！已在背景啟動"
        echo "==========================================${NC}"
        echo ""
        echo -e "📡 本機訪問: ${GREEN}http://localhost:$SERVICE_PORT${NC}"
        echo -e "🌐 區域網路: ${GREEN}http://$LOCAL_IP:$SERVICE_PORT${NC}"
        echo -e "🔢 程序 PID: ${GREEN}$PID${NC}"
        echo -e "📝 日誌檔案: ${GREEN}$INSTALL_DIR/inventory.log${NC}"
        echo ""
        echo -e "${YELLOW}停止系統指令: kill $PID${NC}"
        echo -e "${YELLOW}查看日誌指令: tail -f $INSTALL_DIR/inventory.log${NC}"
        ;;
    3)
        if [ "$SERVICE_CREATED" = true ]; then
            sudo systemctl start $SERVICE_NAME
            sleep 2
            if sudo systemctl is-active --quiet $SERVICE_NAME; then
                echo -e "${GREEN}=========================================="
                echo "   系統部署完成！服務已啟動"
                echo "==========================================${NC}"
                echo ""
                echo -e "📡 本機訪問: ${GREEN}http://localhost:$SERVICE_PORT${NC}"
                echo -e "🌐 區域網路: ${GREEN}http://$LOCAL_IP:$SERVICE_PORT${NC}"
                echo ""
                echo -e "${YELLOW}常用指令：${NC}"
                echo "  啟動服務: sudo systemctl start $SERVICE_NAME"
                echo "  停止服務: sudo systemctl stop $SERVICE_NAME"
                echo "  重啟服務: sudo systemctl restart $SERVICE_NAME"
                echo "  查看狀態: sudo systemctl status $SERVICE_NAME"
                echo "  查看日誌: sudo journalctl -u $SERVICE_NAME -f"
            else
                echo -e "${RED}服務啟動失敗，請查看日誌：${NC}"
                echo "sudo journalctl -u $SERVICE_NAME -n 50"
            fi
        else
            echo -e "${RED}錯誤：systemd 服務未建立${NC}"
            exit 1
        fi
        ;;
    *)
        echo -e "${YELLOW}未選擇啟動方式，部署完成但未啟動系統${NC}"
        echo ""
        echo "您可以稍後手動啟動："
        echo "  cd $INSTALL_DIR"
        echo "  PORT=$SERVICE_PORT PAGE_TITLE=\"$PAGE_TITLE\" npm start"
        ;;
esac

echo ""
echo -e "${GREEN}=========================================="
echo "   🎉 部署完成！"
echo "==========================================${NC}"

