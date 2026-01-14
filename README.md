# 庫存管理系統 (Node.js 版本)

一個簡單的料件入庫管理系統，使用 Node.js + Express + SQLite 開發。

## 功能特色

- ✅ 料件資料管理（新增、查詢）
- ✅ 料件入庫記錄
- ✅ 庫存查詢
- ✅ 入庫記錄查詢

## 🚀 快速部署（推薦）

### 一鍵自動部署

在專案目錄中執行以下指令即可完成所有設置：

```bash
chmod +x deploy.sh
./deploy.sh
```

部署腳本會自動完成：
- ✅ 檢查並安裝 Node.js
- ✅ 安裝專案依賴
- ✅ 設定防火牆（可選）
- ✅ 建立 systemd 服務（可選）
- ✅ 啟動系統

## 📋 手動安裝說明

如果您想手動安裝，請按照以下步驟：

### 1. 安裝 Node.js
確保您的 Ubuntu 系統已安裝 Node.js 14 或更高版本。

```bash
# 檢查是否已安裝
node --version
npm --version

# 如果未安裝，執行以下指令
sudo apt update
sudo apt install nodejs npm -y
```

### 2. 安裝專案依賴套件
在專案目錄中執行：

```bash
npm install
```

### 3. 啟動系統

```bash
npm start
```

系統啟動後，您會看到：
```
🚀 庫存管理系統已啟動！
📡 請訪問：http://localhost:5000
🌐 區域網路訪問：http://[您的IP]:5000
```

開啟瀏覽器並訪問：

```
http://localhost:5000
```

## 🛠️ 管理腳本

系統提供了多個管理腳本，讓您輕鬆管理系統：

### 快速啟動
```bash
chmod +x quick-start.sh
./quick-start.sh
```

### 停止系統
```bash
chmod +x stop.sh
./stop.sh
```

### 查看狀態
```bash
chmod +x status.sh
./status.sh
```

### 更新系統
```bash
chmod +x update.sh
./update.sh
```

### 卸載系統
```bash
chmod +x uninstall.sh
./uninstall.sh
```

## 開發模式（可選）

如果您想要在開發時自動重啟伺服器，可以使用：

```bash
npm run dev
```

## 使用說明

### 1. 新增料件
- 點擊「料件管理」→「新增料件」
- 填寫料號、料件名稱、規格、單位
- 點擊「新增料件」

### 2. 料件入庫
- 點擊「料件入庫」
- 選擇料件、輸入數量、選擇日期
- 可選填備註
- 點擊「確認入庫」

### 3. 查詢庫存
- 點擊「庫存查詢」
- 即可看到所有料件的當前庫存數量

### 4. 查看入庫記錄
- 點擊「入庫記錄」
- 可查看最近 100 筆入庫記錄

## 資料庫

系統使用 SQLite 資料庫，檔案名稱為 `inventory.db`，會自動在首次啟動時建立。

## 技術架構

- **後端框架**：Express 4.x
- **模板引擎**：EJS
- **資料庫**：SQLite (better-sqlite3)
- **前端**：HTML + CSS（內建樣式）
- **響應式設計**：支援桌面版與手機版
- **UI/UX**：統一導航設計 + 手機版優化

## 📱 響應式設計特色

### 桌面版（> 768px）
- ✅ 分組式導航欄（主要功能、記錄查詢、系統管理）
- ✅ 完整表格顯示
- ✅ 大螢幕優化佈局

### 手機版（≤ 768px）
- ✅ 首頁儀表板式導航
- ✅ 功能頁面僅顯示「返回主頁」按鈕
- ✅ 表格橫向滾動查看
- ✅ 觸控優化，滑動流暢
- ✅ 節省螢幕空間

詳細技術資訊請參閱 [技術文件](TECHNICAL_NOTES.md)

## 專案結構

```
庫存管理系統/
├── server.js              # Node.js 主程式
├── package.json           # 套件設定檔
├── README.md             # 說明文件
├── .gitignore            # Git 忽略檔案
├── deploy.sh             # 🚀 一鍵部署腳本
├── quick-start.sh        # 快速啟動腳本
├── stop.sh               # 停止系統腳本
├── status.sh             # 狀態查詢腳本
├── update.sh             # 更新系統腳本
├── uninstall.sh          # 卸載系統腳本
├── views/                # EJS 模板目錄
│   ├── base.ejs         # 基礎模板
│   ├── index.ejs        # 庫存查詢頁面
│   ├── parts_list.ejs   # 料件列表頁面
│   ├── add_part.ejs     # 新增料件頁面
│   ├── inbound.ejs      # 入庫頁面
│   └── inbound_records.ejs # 入庫記錄頁面
└── inventory.db          # SQLite 資料庫（自動生成）
```

## 停止系統

在終端機中按 `Ctrl + C` 即可停止系統。

## 背景執行（可選）

如果您想讓系統在背景執行：

```bash
# 使用 nohup
nohup npm start > output.log 2>&1 &

# 查看執行狀態
ps aux | grep node

# 停止背景程序
kill <PID>
```

## 設定開機自動啟動（可選）

建立 systemd 服務檔案：

```bash
sudo nano /etc/systemd/system/inventory.service
```

內容如下：

```ini
[Unit]
Description=Inventory Management System
After=network.target

[Service]
Type=simple
User=你的使用者名稱
WorkingDirectory=/path/to/庫存管理系統
ExecStart=/usr/bin/npm start
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

啟用服務：

```bash
sudo systemctl enable inventory.service
sudo systemctl start inventory.service
sudo systemctl status inventory.service
```

## 注意事項

- 此為最簡單版本，適合單人或小團隊使用
- 資料庫檔案 `inventory.db` 請妥善備份
- 料號不可重複
- 預設在本機 5000 埠運行
- 系統可在區域網路內訪問

## 疑難排解

### 無法啟動系統

1. 檢查 Node.js 版本：`node --version`（需要 14 以上）
2. 重新安裝依賴：`rm -rf node_modules && npm install`
3. 檢查埠號是否被佔用：`lsof -i :5000`

### 無法連接資料庫

確保有寫入權限：`chmod 755 .`

## 授權

此專案為個人使用，無特定授權限制。
