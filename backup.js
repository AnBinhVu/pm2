const { execSync } = require("child_process");
const axios = require("axios");
require("dotenv").config();

const BACKUP_DIR = process.env.VM_BACKUP_DIR;
const RSYNC_TARGETS = process.env.RSYNC_TARGETS.split(",").map(t => t.trim()).filter(Boolean);
const NODE_IP = process.env.NODE_IP;
const BACKUP_TYPE = process.env.BACKUP_TYPE || "vm"; // "vm" hoặc "db"

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
// Push metric
// ======================
function pushMetric(vmId, status) {
    if (!PUSHGATEWAY_URL) return;
    try {
        const pushUrl = `${PUSHGATEWAY_URL}/metrics/job/vm_backup/instance/${vmId}`;
        const metric = `vm_backup{vm="${vmId}", node="${NODE_IP}"} ${status}\n`;
        execSync(`echo '${metric}' | curl --data-binary @- ${pushUrl}`);
    } catch (e) {
        console.error(`[${NODE_IP}] Push metric lỗi cho VM ${vmId}:`, e.message);
    }
}

// ======================
// Cleanup backup local hoặc remote
// ======================
function cleanupBackups(vmId, targetDir, isRemote = false) {
    const prefix = isRemote ? `ssh root@${vmId} "` : "";
    const suffix = isRemote ? `"` : "";
    try {
        if (BACKUP_TYPE === "vm") {
            execSync(`${prefix}cd ${targetDir} && ls -1t vzdump-qemu-${vmId}-*.vma.* 2>/dev/null | tail -n +2 | xargs -r rm -f${suffix}`);
            execSync(`${prefix}cd ${targetDir} && ls -1t vzdump-qemu-${vmId}-*.log 2>/dev/null | tail -n +2 | xargs -r rm -f${suffix}`);
            execSync(`${prefix}cd ${targetDir} && rm -f .vzdump-qemu-${vmId}-*.vma.lzo.gdpqbO${suffix}`);
        } else if (BACKUP_TYPE === "db") {
            execSync(`${prefix}cd ${targetDir} && ls -1t db_virtualizor_*.sql.* 2>/dev/null | tail -n +2 | xargs -r rm -f${suffix}`);
        }
        console.log(`[${NODE_IP}] Cleanup old backups in ${isRemote ? "remote" : "local"} dir ${targetDir} done for ${vmId}`);
    } catch (e) {
        console.error(`[${NODE_IP}] Cleanup error (${isRemote ? "remote" : "local"}) for ${vmId}:`, e.message);
    }
}

// ======================
// Backup VM hoặc DB
// ======================
function backupVM(vmId) {
    try {
        console.log(`[${NODE_IP}] Backup ${BACKUP_TYPE.toUpperCase()} ${vmId}...`);

        execSync(`mkdir -p ${BACKUP_DIR}`);

        if (BACKUP_TYPE === "vm") {
            // vzdump VM
            execSync(`vzdump ${vmId} --dumpdir ${BACKUP_DIR} --mode snapshot --compress lzo --remove 0`, { stdio: "inherit" });
        } else if (BACKUP_TYPE === "db") {
            const timestamp = new Date().toISOString().replace(/[:]/g, "-");
            const backupFile = `${BACKUP_DIR}/db_virtualizor_${timestamp}.sql.gz`;
            execSync(`mysqldump -u ${process.env.DB_USER} -p${process.env.DB_PASS} ${vmId} | gzip > ${backupFile}`);
        }

        sendTelegram(`Backup ${BACKUP_TYPE.toUpperCase()} ${vmId} thành công`);
        pushMetric(vmId, 1);

        // Cleanup local, giữ 1 file mới nhất
        cleanupBackups(vmId, BACKUP_DIR);

    } catch (e) {
        console.error(`[${NODE_IP}] Backup ${BACKUP_TYPE.toUpperCase()} ${vmId} FAILED:`, e.message);
        sendTelegram(`Backup ${BACKUP_TYPE.toUpperCase()} ${vmId} thất bại: ${e.message}`);
        pushMetric(vmId, 0);
    }
}

// ======================
// Rsync sang các node khác
// ======================
function syncBackup(vmId) {
    RSYNC_TARGETS.forEach(target => {
        if (!target) return;
        try {
            execSync(`rsync -avz ${BACKUP_DIR}/ root@${target}:${BACKUP_DIR}/`);
            sendTelegram(`Rsync ${BACKUP_TYPE.toUpperCase()} backups sang ${target} thành công`);

            // Cleanup remote, giữ file mới nhất
            cleanupBackups(vmId, BACKUP_DIR, true);
            sendTelegram(`Cleanup old backups trên ${target} done`);
        } catch (e) {
            console.error(`[${NODE_IP}] Rsync/Cleanup error to ${target}:`, e.message);
            sendTelegram(`Rsync/Cleanup lỗi sang ${target}: ${e.message}`);
        }
    });
}

// ======================
// Main job
// ======================
function job() {
    const VM_LIST = process.env.VM_LIST.split(",").map(v => v.trim()).filter(Boolean);
    VM_LIST.forEach(vmId => {
        backupVM(vmId);
        syncBackup(vmId);
    });
    console.log(`[${NODE_IP}] Backup job finished.`);
}

// Chạy ngay khi start
job();

// Lặp lại mỗi 1 giờ
setInterval(job, 60 * 60 * 1000);
