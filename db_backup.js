const { execSync } = require("child_process");
require("dotenv").config();

const BACKUP_DIR = "/var/backups/db";
const RSYNC_TARGETS = process.env.RSYNC_TARGETS.split(","); // Node 2,3
const NODE_IP = process.env.NODE_IP;

// Thông tin DB từ .env
const DB_USER = process.env.DB_USER || "root";
const DB_PASS = process.env.DB_PASS || "";
const DB_NAME = process.env.DB_NAME || "virtualizor";

// Hàm backup DB
function backupDB() {
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const dumpFile = `${BACKUP_DIR}/virtualizor_${timestamp}.sql.gz`;

        console.log(`[${NODE_IP}] Backup DB ${DB_NAME}...`);
        execSync(`mkdir -p ${BACKUP_DIR}`);
        execSync(`mysqldump -u${DB_USER} -p${DB_PASS} ${DB_NAME} | gzip > ${dumpFile}`);

        console.log(`[${NODE_IP}] Backup DB done: ${dumpFile}`);
        return dumpFile;
    } catch (e) {
        console.error(`[${NODE_IP}] Backup DB error:`, e.message);
        return null;
    }
}

// Hàm rsync sang node khác
function syncBackup(file) {
    if (!file) return;
    RSYNC_TARGETS.forEach(target => {
        try {
            execSync(`rsync -avz ${file} root@${target}:${BACKUP_DIR}/`);
            console.log(`[${NODE_IP}] Rsync DB backup to ${target} done!`);
        } catch (e) {
            console.error(`[${NODE_IP}] Rsync error to ${target}:`, e.message);
        }
    });
}

// Main job
function job() {
    const dumpFile = backupDB();
    syncBackup(dumpFi
