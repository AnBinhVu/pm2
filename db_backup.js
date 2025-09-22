const { execSync } = require("child_process");
const axios = require("axios");
require("dotenv").config();

const BACKUP_DIR = "/var/backups/db";
const RSYNC_TARGETS = process.env.RSYNC_TARGETS.split(",");
const NODE_IP = process.env.NODE_IP;

const DB_USER = process.env.DB_USER || "root";
const DB_PASS = process.env.DB_PASS || "";
const DB_NAME = process.env.DB_NAME || "virtualizor";
const MYSQLDUMP_BIN = "/usr/local/emps/bin/mysqldump";
const MYSQL_SOCKET = "/usr/local/emps/var/mysql/mysql.sock";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PUSHGATEWAY_URL = process.env.PUSHGATEWAY_URL;

// ======================
// Gửi Telegram
// ======================
function sendTelegram(message) {
    axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: TELEGRAM_CHAT_ID,
        text: `[${NODE_IP}] ${message}`
    }).catch(err => console.error("Telegram send error:", err.message));
}

// ======================
// Gửi metric
// ======================
function pushMetric(status) {
    try {
        const pushUrl = `${PUSHGATEWAY_URL}/instance/${DB_NAME}`;
        const metric = `db_backup{db="${DB_NAME}", node="${NODE_IP}"} ${status}\n`;
        execSync(`echo '${metric}' | curl --data-binary @- ${pushUrl}`);
    } catch (e) {
        console.error("Push metric lỗi DB:", e.message);
    }
}

// ======================
// Backup DB
// ======================
function backupDB() {
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const dumpFile = `${BACKUP_DIR}/db_${DB_NAME}_${timestamp}.sql.gz`;

        execSync(`mkdir -p ${BACKUP_DIR}`);
        execSync(`${MYSQLDUMP_BIN} --socket=${MYSQL_SOCKET} -u${DB_USER} -p${DB_PASS} ${DB_NAME} | gzip > ${dumpFile}`);

        sendTelegram(`Backup DB ${DB_NAME} OK: ${dumpFile}`);
        pushMetric(1);

        // 👉 Xóa tất cả file cũ, chỉ giữ lại file mới nhất
        execSync(`ls -1t ${BACKUP_DIR}/db_${DB_NAME}_*.sql.gz | tail -n +2 | xargs -r rm -f`);
        console.log(`[${NODE_IP}] Cleanup old local DB backups, giữ lại bản mới nhất`);

        return dumpFile;
    } catch (e) {
        sendTelegram(`Backup DB ${DB_NAME} FAILED: ${e.message}`);
        pushMetric(0);
        return null;
    }
}

// ======================
// Rsync
// ======================
function syncBackup(file) {
    if (!file) return;
    RSYNC_TARGETS.forEach(target => {
        if (!target) return;
        try {
            execSync(`rsync -avz ${file} root@${target}:${BACKUP_DIR}/`);
            sendTelegram(`Rsync DB backup to ${target} done!`);

            // 👉 Cleanup: chỉ giữ lại bản mới nhất ở remote
            execSync(`ssh root@${target} "ls -1t ${BACKUP_DIR}/db_${DB_NAME}_*.sql.gz | tail -n +2 | xargs -r rm -f"`);
            sendTelegram(`Cleanup old DB backups trên ${target} xong`);
        } catch (e) {
            sendTelegram(`Rsync/cleanup DB backup to ${target} FAILED: ${e.message}`);
        }
    });
}

// ======================
// Main job
// ======================
function job() {
    sendTelegram(`Starting DB backup for ${DB_NAME}...`);
    const dumpFile = backupDB();
    syncBackup(dumpFile);
}

// 👉 Chạy ngay khi start
job();

// 👉 Lặp lại mỗi 1 giờ
setInterval(job, 60 * 60 * 1000);
