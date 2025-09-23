const { execSync } = require("child_process");
const axios = require("axios");
require("dotenv").config();

const BACKUP_DIR = process.env.DB_BACKUP_DIR;
const RSYNC_TARGETS = process.env.RSYNC_TARGETS.split(",");
const NODE_IP = process.env.NODE_IP;

const DB_USER = process.env.DB_USER || "root";
const DB_PASS = process.env.DB_PASS || "";
const DB_NAME = process.env.DB_NAME || "virtualizor";
const MYSQLDUMP_BIN = process.env.MYSQLDUMP_BIN || "mysqldump";
const MYSQL_SOCKET = process.env.MYSQL_SOCKET;

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
        const pushUrl = `${PUSHGATEWAY_URL}/metrics/job/db_backup/instance/${NODE_IP}`;
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

        // Cleanup local DB backups
        execSync(`ls -1t ${BACKUP_DIR}/db_${DB_NAME}_*.sql.gz | tail -n +2 | xargs -r rm -f`);
        console.log(`[${NODE_IP}] Cleanup old DB backups done`);

        return dumpFile;
    } catch (e) {
        sendTelegram(`Backup DB ${DB_NAME} FAILED: ${e.message}`);
        pushMetric(0);
        return null;
    }
}

// ======================
// Backup Config Virtualizor
// ======================
function backupConfig() {
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const confFile = `${BACKUP_DIR}/conf_virtualizor_${timestamp}.tar.gz`;

        execSync(`tar -czf ${confFile} /usr/local/virtualizor/universal.php /usr/local/virtualizor/conf /etc/virtualizor`);

        sendTelegram(`Backup config Virtualizor OK: ${confFile}`);

        // Cleanup local config backups
        execSync(`ls -1t ${BACKUP_DIR}/conf_virtualizor_*.tar.gz | tail -n +2 | xargs -r rm -f`);
        console.log(`[${NODE_IP}] Cleanup old config backups done`);

        return confFile;
    } catch (e) {
        sendTelegram(`Backup config Virtualizor FAILED: ${e.message}`);
        return null;
    }
}

// ======================
// Rsync
// ======================
function syncBackup(files) {
    if (!files || files.length === 0) return;
    RSYNC_TARGETS.forEach(target => {
        if (!target) return;
        try {
            execSync(`rsync -avz ${files.join(" ")} root@${target}:${BACKUP_DIR}/`);
            sendTelegram(`Rsync backups to ${target} done!`);

            // Cleanup remote backups (DB + Config)
            execSync(`ssh root@${target} "
                cd ${BACKUP_DIR} &&
                ls -1t db_${DB_NAME}_*.sql.gz | tail -n +2 | xargs -r rm -f &&
                ls -1t conf_virtualizor_*.tar.gz | tail -n +2 | xargs -r rm -f
            "`);
            sendTelegram(`Cleanup old backups on ${target} done`);
        } catch (e) {
            sendTelegram(`Rsync/cleanup backups to ${target} FAILED: ${e.message}`);
        }
    });
}

// ======================
// Main job
// ======================
function job() {
    sendTelegram(`Starting Virtualizor backup (DB + Config)...`);
    const dbFile = backupDB();
    const confFile = backupConfig();
    syncBackup([dbFile, confFile].filter(Boolean));
}

// Chạy ngay khi start
job();

// Lặp lại mỗi 1 giờ
setInterval(job, 60 * 60 * 1000);
