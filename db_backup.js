const { execSync } = require("child_process");
const axios = require("axios");
require("dotenv").config();

const BACKUP_DIR = "/var/backups/db";
const RSYNC_TARGETS = process.env.RSYNC_TARGETS.split(",");
const NODE_IP = process.env.NODE_IP;

const DB_USER = process.env.DB_USER || "root";
const DB_PASS = process.env.DB_PASS || "";
const DB_NAME = process.env.DB_NAME || "virtualizor";

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
        const dumpFile = `${BACKUP_DIR}/virtualizor_${timestamp}.sql.gz`;

        execSync(`mkdir -p ${BACKUP_DIR}`);
        execSync(`mysqldump -u${DB_USER} -p${DB_PASS} ${DB_NAME} | gzip > ${dumpFile}`);

        sendTelegram(`Backup DB ${DB_NAME} OK`);
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
            sendTelegram(`Rsync DB backup to ${target} OK`);
        } catch (e) {
            sendTelegram(`Rsync DB backup to ${target} FAILED: ${e.message}`);
        }
    });
}

// Main job
function job() {
    const dumpFile = backupDB();
    syncBackup(dumpFile);
}

job();
setInterval(job, 60 * 60 * 1000);
