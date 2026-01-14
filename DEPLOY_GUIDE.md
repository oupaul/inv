# Ubuntu 部署指南

本指南將協助您在 Ubuntu 伺服器上快速部署庫存管理系統。

## 📦 方案一：一鍵自動部署（推薦）

### 步驟 1：上傳檔案到 Ubuntu

使用以下任一方式上傳專案檔案：

#### 方式 A：使用 SCP（從 Windows）
```bash
scp -r "C:\Users\Paul Ou\Dropbox\Cursor 專案開發\庫存管理系統" username@ubuntu-server-ip:/home/username/
```

#### 方式 B：使用 SFTP 工具
- 使用 WinSCP、FileZilla 等工具
- 連接到 Ubuntu 伺服器
- 將整個專案資料夾上傳

#### 方式 C：使用 Git（如果程式碼已推送到 Git）
```bash
git clone https://your-repository-url.git
cd 庫存管理系統
```

### 步驟 2：執行部署腳本

SSH 連接到 Ubuntu 伺服器後：

```bash
# 進入專案目錄
cd 庫存管理系統

# 給予執行權限
chmod +x deploy.sh

# 執行一鍵部署
./deploy.sh
```

### 步驟 3：選擇部署選項

部署腳本會詢問您幾個問題：

1. **是否開放防火牆 5000 埠？** 
   - 如果要從其他電腦訪問，選擇 `y`

2. **是否建立 systemd 服務？**
   - 如果要開機自動啟動，選擇 `y`

3. **選擇啟動方式**：
   - `1` - 前景執行（適合測試）
   - `2` - 背景執行
   - `3` - systemd 服務（推薦）

### 完成！

部署完成後，您可以透過瀏覽器訪問：
- **本機**：http://localhost:5000
- **區域網路**：http://[伺服器IP]:5000

---

## 🔧 方案二：手動部署

### 步驟 1：安裝 Node.js

```bash
# 更新套件列表
sudo apt update

# 安裝 Node.js 18.x LTS
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# 確認安裝
node --version
npm --version
```

### 步驟 2：準備專案

```bash
# 進入專案目錄
cd 庫存管理系統

# 安裝依賴
npm install
```

### 步驟 3：設定防火牆（可選）

```bash
# 如果使用 UFW 防火牆
sudo ufw allow 5000/tcp
sudo ufw status
```

### 步驟 4：啟動系統

```bash
# 方式 1：前景執行
npm start

# 方式 2：背景執行
nohup npm start > inventory.log 2>&1 &

# 方式 3：使用提供的腳本
chmod +x quick-start.sh
./quick-start.sh
```

---

## 🚀 日常管理指令

### 啟動系統
```bash
./quick-start.sh
```

### 停止系統
```bash
./stop.sh
```

### 查看狀態
```bash
./status.sh
```

### 查看日誌
```bash
# 如果使用背景執行
tail -f inventory.log

# 如果使用 systemd
sudo journalctl -u inventory-system -f
```

### 重啟系統
```bash
# 使用 systemd
sudo systemctl restart inventory-system

# 手動重啟
./stop.sh && ./quick-start.sh
```

---

## 🔐 設定開機自動啟動

如果在部署時沒有選擇建立 systemd 服務，可以手動建立：

### 1. 建立服務檔案

```bash
sudo nano /etc/systemd/system/inventory-system.service
```

### 2. 貼上以下內容

```ini
[Unit]
Description=Inventory Management System
After=network.target

[Service]
Type=simple
User=你的使用者名稱
WorkingDirectory=/完整路徑/到/庫存管理系統
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=10
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=inventory-system

[Install]
WantedBy=multi-user.target
```

**注意**：記得修改 `User` 和 `WorkingDirectory` 為實際值！

### 3. 啟用並啟動服務

```bash
# 重新載入 systemd
sudo systemctl daemon-reload

# 啟用開機自動啟動
sudo systemctl enable inventory-system

# 立即啟動服務
sudo systemctl start inventory-system

# 查看狀態
sudo systemctl status inventory-system
```

### 4. systemd 管理指令

```bash
# 啟動
sudo systemctl start inventory-system

# 停止
sudo systemctl stop inventory-system

# 重啟
sudo systemctl restart inventory-system

# 查看狀態
sudo systemctl status inventory-system

# 查看日誌
sudo journalctl -u inventory-system -f

# 停用開機自動啟動
sudo systemctl disable inventory-system
```

---

## 🌐 反向代理設定（進階）

如果您想使用 80 埠或設定域名，可以使用 Nginx 反向代理：

### 安裝 Nginx

```bash
sudo apt install nginx -y
```

### 設定 Nginx

```bash
sudo nano /etc/nginx/sites-available/inventory
```

貼上以下內容：

```nginx
server {
    listen 80;
    server_name your-domain.com;  # 改成您的域名或伺服器 IP

    location / {
        proxy_pass http://localhost:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

啟用設定：

```bash
# 建立符號連結
sudo ln -s /etc/nginx/sites-available/inventory /etc/nginx/sites-enabled/

# 測試設定
sudo nginx -t

# 重新載入 Nginx
sudo systemctl reload nginx

# 開放 80 埠
sudo ufw allow 'Nginx Full'
```

現在可以透過 http://your-domain.com 訪問系統！

---

## 📊 效能監控

### 檢查系統資源使用

```bash
# 查看 Node.js 程序
ps aux | grep node

# 查看記憶體使用
free -h

# 查看磁碟空間
df -h

# 即時監控（需安裝 htop）
sudo apt install htop
htop
```

### 查看資料庫大小

```bash
du -h inventory.db
```

---

## 🔒 安全性建議

1. **設定防火牆**
```bash
sudo ufw enable
sudo ufw allow ssh
sudo ufw allow 5000/tcp  # 或只允許特定 IP
```

2. **定期備份資料庫**
```bash
# 手動備份
cp inventory.db inventory.db.backup.$(date +%Y%m%d)

# 建立自動備份腳本
crontab -e
# 加入：每天凌晨 2 點備份
0 2 * * * cp /path/to/inventory.db /path/to/backup/inventory.db.$(date +\%Y\%m\%d)
```

3. **更新系統套件**
```bash
sudo apt update && sudo apt upgrade -y
```

---

## ❓ 常見問題

### Q1: 無法訪問 5000 埠？
**A:** 檢查防火牆設定
```bash
sudo ufw status
sudo ufw allow 5000/tcp
```

### Q2: 系統無法啟動？
**A:** 查看錯誤日誌
```bash
# 背景執行時
cat inventory.log

# systemd 服務時
sudo journalctl -u inventory-system -n 50
```

### Q3: Node.js 版本太舊？
**A:** 升級到 Node.js 18
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs
```

### Q4: 如何變更埠號？
**A:** 編輯 `server.js`
```bash
nano server.js
# 修改 PORT = 5000 為其他埠號
```

### Q5: 忘記資料庫在哪？
**A:** 資料庫檔案在專案根目錄
```bash
ls -lh inventory.db
```

---

## 📞 需要協助？

如遇到問題，請檢查：
1. Node.js 版本（`node --version`）需要 14 以上
2. 埠號是否被佔用（`lsof -i :5000`）
3. 檔案權限是否正確（`ls -la`）
4. 防火牆設定（`sudo ufw status`）

---

**祝您部署順利！** 🎉

