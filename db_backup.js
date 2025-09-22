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

// Telegram
function sendTelegram(message) {
    axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: TELEGRAM_CHAT_ID,
        text: `[${NODE_IP}] ${message}`
    }).catch(err => console.error("Telegram send error:", err.message));
}

// Push metric
function pushMetric(status) {
    try {
        const pushUrl = `${PUSHGATEWAY_URL}/instance/${DB_NAME}`;
        const metric = `db_backup{db="${DB_NAME}", node="${NODE_IP}"} ${status}\n`;
        execSync(`echo '${metric}' | curl --data-binary @- ${pushUrl}`);
    } catch (e) {
        console.error("Push metric lỗi DB:", e.message);
    }
}

// Backup DB
function backupDB() {
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const dumpFile = `${BACKUP_DIR}/db_${DB_NAME}_${timestamp}.sql.gz`;

        execSync(`mkdir -p ${BACKUP_DIR}`);
        execSync(`${MYSQLDUMP_BIN} --socket=${MYSQL_SOCKET} -u${DB_USER} -p${DB_PASS} ${DB_NAME} | gzip > ${dumpFile}`);

        sendTelegram(`Backup DB ${DB_NAME} OK: ${dumpFile}`);
        pushMetric(1);
        return dumpFile;
    } catch (e) {
        sendTelegram(`Backup DB ${DB_NAME} FAILED: ${e.message}`);
        pushMetric(0);
        return null;
    }
}

// Rsync
function syncBackup(file) {
    if (!file) return;
    RSYNC_TARGETS.forEach(target => {
        try {
            execSync(`rsync -avz ${file} root@${target}:${BACKUP_DIR}/`);
            sendTelegram(`Rsync DB backup to ${target} done!`);
            // Cleanup old backups (>7 ngày) trên target
            execSync(`ssh root@${target} "find ${BACKUP_DIR} -type f -mtime +7 -delete"`);
            sendTelegram(`Cleanup old DB backups (>7d) on ${target} done!`);
        } catch (e) {
            sendTelegram(`Rsync/cleanup DB backup to ${target} FAILED: ${e.message}`);
        }
    });
}

// Cleanup local backups >7 ngày
function cleanupLocal() {
    try {
        execSync(`find ${BACKUP_DIR} -type f -mtime +7 -delete`);
        console.log(`[${NODE_IP}] Cleanup old local DB backups done!`);
    } catch (e) {
        console.error(`[${NODE_IP}] Cleanup local DB backups error:`, e.message);
    }
}

// Main job
function job() {
    sendTelegram(`Starting DB backup for ${DB_NAME}...`);
    const dumpFile = backupDB();
    syncBackup(dumpFile);
    cleanupLocal();
}

job();
setInterval(job, 60 * 60 * 1000); // chạy mỗi 1 giờ
