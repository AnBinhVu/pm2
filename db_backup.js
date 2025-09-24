const { execSync } = require("child_process");
const axios = require("axios");
const fs = require("fs");
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
// Log file nằm chung thư mục backup
// ======================
const LOG_FILE = `${BACKUP_DIR}/virtualizor_backup.log`;
if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

// ======================
// Hàm ghi log
// ======================
function log(message) {
    const timestamp = new Date().toISOString();
    const fullMessage = `[${timestamp}] ${message}`;
    console.log(fullMessage);
    fs.appendFileSync(LOG_FILE, fullMessage + "\n");
}

// ======================
// Gửi Telegram
// ======================
function sendTelegram(message) {
    axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: TELEGRAM_CHAT_ID,
        text: `[${NODE_IP}] ${message}`
    }).catch(err => log("Telegram send error: " + err.message));
}

// ======================
// Gửi metric
// ======================
function pushMetric(status) {
    try {
        const pushUrl = `${PUSHGATEWAY_URL}/metrics/job/db_backup/instance/${NODE_IP}`;
        const metric = `db_backup{db="${DB_NAME}", node="${NODE_IP}"} ${status}\n`;
        execSync(`echo '${metric}' | curl --data-binary @- ${pushUrl}`);
        log(`Push metric: ${status}`);
    } catch (e) {
        log("Push metric lỗi DB: " + e.message);
    }
}

// ======================
// Backup DB
// ======================
function backupDB() {
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const dumpFile = `${BACKUP_DIR}/db_${DB_NAME}_${timestamp}.sql.gz`;

        execSync(`${MYSQLDUMP_BIN} --socket=${MYSQL_SOCKET} -u${DB_USER} -p${DB_PASS} ${DB_NAME} | gzip > ${dumpFile}`);

        log(`Backup DB ${DB_NAME} OK: ${dumpFile}`);
        sendTelegram(`Backup DB ${DB_NAME} OK: ${dumpFile}`);
        pushMetric(1);

        // Cleanup local DB backups (giữ 1 file mới nhất)
        execSync(`ls -1t ${BACKUP_DIR}/db_${DB_NAME}_*.sql.gz | tail -n +2 | xargs -r rm -f`);
        log("Cleanup old DB backups done");

        return dumpFile;
    } catch (e) {
        log(`Backup DB ${DB_NAME} FAILED: ${e.message}`);
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

        // Chỉ backup những đường dẫn tồn tại
        const pathsToBackup = [
            "/usr/local/virtualizor/universal.php",
            "/usr/local/virtualizor/conf",
            "/var/virtualizor"
        ].filter(fs.existsSync);

        if (pathsToBackup.length === 0) throw new Error("No Virtualizor config files found");

        execSync(`tar -czf ${confFile} ${pathsToBackup.join(" ")}`);

        sendTelegram(`Backup config Virtualizor OK: ${confFile}`);
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
            log(`Rsync backups to ${target} done`);
            sendTelegram(`Rsync backups to ${target} done!`);

            // Cleanup remote backups
            execSync(`ssh root@${target} "
                cd ${BACKUP_DIR} &&
                ls -1t db_${DB_NAME}_*.sql.gz | tail -n +2 | xargs -r rm -f &&
                ls -1t conf_virtualizor_*.tar.gz | tail -n +2 | xargs -r rm -f
            "`);
            log(`Cleanup old backups on ${target} done`);
            sendTelegram(`Cleanup old backups on ${target} done`);
        } catch (e) {
            log(`Rsync/cleanup backups to ${target} FAILED: ${e.message}`);
            sendTelegram(`Rsync/cleanup backups to ${target} FAILED: ${e.message}`);
        }
    });
}

// ======================
// Main job
// ======================
function job() {
    log("Starting Virtualizor backup (DB + Config)...");
    sendTelegram("Starting Virtualizor backup (DB + Config)...");
    const dbFile = backupDB();
    const confFile = backupConfig();
    syncBackup([dbFile, confFile].filter(Boolean));
    log("Backup job finished.\n");
}

// Chạy ngay khi start
job();

// Lặp lại mỗi 1 giờ
setInterval(job, 60 * 60 * 1000);
