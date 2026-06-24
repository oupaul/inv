#!/bin/bash
# 庫存管理系統 - 更新腳本
# 流程：git pull → npm install → 重啟 systemd 服務 → 健康檢查（失敗自動回滾）
# 用法：在安裝目錄下 sudo ./update.sh
#       可選環境變數：
#         SERVICE_NAME=xxx        手動指定服務名（不指定則從目錄名推導）
#         PORT=5000               健康檢查用的 port（不指定則嘗試讀 .env）
#         SKIP_HEALTHCHECK=1      跳過健康檢查
#         SKIP_BACKUP=1           跳過更新前備份

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[i]${NC} $*"; }
log_warn()  { echo -e "${YELLOW}[!]${NC} $*"; }
log_error() { echo -e "${RED}[x]${NC} $*"; }

# 一定要在 git repo 內
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

if [ ! -d ".git" ]; then
    log_error "目前目錄不是 git repo：$SCRIPT_DIR"
    log_error "請在已用 deploy.sh 部署的安裝目錄下執行（如 /opt/inv-prod）"
    exit 1
fi

# 推導服務名：可由 SERVICE_NAME 覆寫，否則用目錄名 + .service
if [ -z "$SERVICE_NAME" ]; then
    SERVICE_NAME="$(basename "$SCRIPT_DIR").service"
fi
log_info "服務名：$SERVICE_NAME"

# 確認服務存在
if ! systemctl list-unit-files --type=service 2>/dev/null | grep -q "^${SERVICE_NAME}"; then
    log_warn "找不到 systemd 服務 $SERVICE_NAME"
    log_warn "請用 SERVICE_NAME=正確服務名 ./update.sh 重跑，或先用 deploy.sh 建立服務"
    exit 1
fi

# 推導 port（供健康檢查）：先看 env、再看 .env、預設 5000
if [ -z "$PORT" ] && [ -f .env ]; then
    PORT=$(grep -E '^PORT=' .env | head -1 | cut -d'=' -f2 | tr -d '"' | tr -d "'" | tr -d '\r')
fi
PORT=${PORT:-5000}

# 紀錄目前 commit，失敗時用來回滾
PREV_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
log_info "目前版本：$PREV_COMMIT"

# 在這個 repo 內忽略檔案權限位元變更（chmod +x 不會被視為「修改」）
git config core.fileMode false 2>/dev/null || true

# 工作目錄乾淨度檢查：只擋 tracked 檔案有實質內容變更或衝突
# - 忽略 mode-only 變更（透過 core.fileMode=false 已過濾）
# - 忽略 untracked 檔案（git pull 不會碰它們，例如 backup-schedule.json）
# - 用 SKIP_DIRTY_CHECK=1 可跳過整段檢查
if [ -z "$SKIP_DIRTY_CHECK" ]; then
    DIRTY_FILES=$(git diff --name-only HEAD 2>/dev/null)
    STAGED_FILES=$(git diff --cached --name-only 2>/dev/null)
    if [ -n "$DIRTY_FILES" ] || [ -n "$STAGED_FILES" ]; then
        log_warn "工作目錄有未提交的 tracked 檔案變更："
        [ -n "$STAGED_FILES" ] && echo "已暫存：" && echo "$STAGED_FILES" | sed 's/^/  /'
        [ -n "$DIRTY_FILES" ]  && echo "未暫存：" && echo "$DIRTY_FILES" | sed 's/^/  /'
        log_warn "請先處理（commit / stash / 還原）後再執行 update.sh，以免 git pull 失敗或衝突"
        log_warn "（若確定變更可拋棄，可：git checkout -- . 然後重跑）"
        exit 1
    fi
fi

# 更新前先備份（除非設 SKIP_BACKUP=1）
if [ -z "$SKIP_BACKUP" ] && [ -x "./backup.sh" ]; then
    log_info "更新前備份..."
    ./backup.sh || log_warn "備份失敗（繼續更新；建議事後手動備份）"
else
    log_warn "跳過更新前備份"
fi

# 抓取最新代碼
log_info "git pull..."
if ! git pull --ff-only; then
    log_error "git pull 失敗（可能有衝突或網路問題）"
    exit 1
fi

NEW_COMMIT=$(git rev-parse HEAD)
if [ "$PREV_COMMIT" = "$NEW_COMMIT" ]; then
    log_info "已是最新版本（$NEW_COMMIT），不需重啟"
    exit 0
fi
log_info "新版本：$NEW_COMMIT"

# 安裝/更新相依
log_info "npm install --omit=dev..."
if ! npm install --omit=dev --no-audit --no-fund; then
    log_error "npm install 失敗，正在回滾代碼..."
    git reset --hard "$PREV_COMMIT"
    exit 1
fi

# 重啟服務
log_info "重啟服務 $SERVICE_NAME..."
sudo systemctl restart "$SERVICE_NAME"

# 等服務起來
sleep 3

# 服務狀態檢查
if ! sudo systemctl is-active --quiet "$SERVICE_NAME"; then
    log_error "服務啟動失敗，正在回滾..."
    sudo systemctl status "$SERVICE_NAME" --no-pager -n 30 || true
    git reset --hard "$PREV_COMMIT"
    npm install --omit=dev --no-audit --no-fund || true
    sudo systemctl restart "$SERVICE_NAME"
    log_error "已回滾至 $PREV_COMMIT，請查看上面的錯誤訊息"
    exit 1
fi

# /healthz 健康檢查（除非 SKIP_HEALTHCHECK=1）
if [ -z "$SKIP_HEALTHCHECK" ]; then
    log_info "健康檢查：http://localhost:$PORT/healthz"
    if command -v curl > /dev/null 2>&1; then
        HEALTH=$(curl -fsS -m 5 "http://localhost:$PORT/healthz" 2>/dev/null || echo "")
        if echo "$HEALTH" | grep -q '"ok":true'; then
            log_info "✅ 健康檢查通過：$HEALTH"
        else
            log_error "健康檢查失敗（回應：${HEALTH:-無回應}），正在回滾..."
            sudo systemctl status "$SERVICE_NAME" --no-pager -n 30 || true
            git reset --hard "$PREV_COMMIT"
            npm install --omit=dev --no-audit --no-fund || true
            sudo systemctl restart "$SERVICE_NAME"
            log_error "已回滾至 $PREV_COMMIT"
            exit 1
        fi
    else
        log_warn "未安裝 curl，跳過健康檢查（建議：apt install curl）"
    fi
fi

echo ""
log_info "✅ 更新完成：$PREV_COMMIT → $NEW_COMMIT"
echo ""
echo "變更摘要："
git log --oneline "$PREV_COMMIT..$NEW_COMMIT"
