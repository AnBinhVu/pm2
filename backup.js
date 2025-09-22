const { execSync } = require("child_process");
const axios = require("axios");
require("dotenv").config();

const BACKUP_DIR = "/var/backups/vm";
const RSYNC_TARGETS = process.env.RSYNC_TARGETS.split(","); // Node 2,3
const NODE_IP = process.env.NODE_IP;

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
// Gửi metric lên Pushgateway
// ======================
function pushMetric(vmId, status) {
    try {
        const pushUrl = `${PUSHGATEWAY_URL}/instance/${vmId}`;
        const metric = `vm_backup{vm="${vmId}", node="${NODE_IP}"} ${status}\n`;
        execSync(`echo '${metric}' | curl --data-binary @- ${pushUrl}`);
    } catch (e) {
        console.error(`Push metric lỗi cho VM ${vmId}:`, e.message);
    }
}

// ======================
// Hàm backup VM
// ======================
function backupVM(vmId) {
    try {
        console.log(`[${NODE_IP}] Backup VM ${vmId}...`);
        execSync(`vzdump ${vmId} --dumpdir ${BACKUP_DIR} --mode snapshot --compress lzo`);
        console.log(`[${NODE_IP}] Backup VM ${vmId} done!`);
        sendTelegram(`Backup VM ${vmId} thành công`);
        pushMetric(vmId, 1);
    } catch (e) {
        console.error(`[${NODE_IP}] Backup VM ${vmId} error:`, e.message);
        sendTelegram(`Backup VM ${vmId} thất bại: ${e.message}`);
        pushMetric(vmId, 0);
    }
}

// ======================
// Hàm rsync sang node khác
// ======================
function syncBackup() {
    RSYNC_TARGETS.forEach(target => {
        try {
            // Rsync file mới
            execSync(`rsync -avz ${BACKUP_DIR}/ root@${target}:${BACKUP_DIR}/`);
            console.log(`[${NODE_IP}] Rsync backup to ${target} done!`);
            sendTelegram(`Rsync backup sang ${target} thành công`);

            // Xóa file backup cũ hơn 1 ngày (trên node con)
            execSync(`ssh root@${target} "find ${BACKUP_DIR} -type f -mtime +1 -delete"`);
            console.log(`[${NODE_IP}] Cleanup old backups (>1 day) on ${target} done!`);
            sendTelegram(`Cleanup backup cũ trên ${target} xong`);
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
    const VM_LIST = process.env.VM_LIST.split(",").map(v => v.trim());
    VM_LIST.forEach(backupVM);
    syncBackup();
}

// 👉 Chạy ngay khi start
job();

// 👉 Lặp lại mỗi 1 giờ
setInterval(job, 60 * 60 * 1000);
