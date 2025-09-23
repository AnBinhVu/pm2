const { execSync } = require("child_process");
const axios = require("axios");
require("dotenv").config();

const BACKUP_DIR = process.env.VM_BACKUP_DIR;
const RSYNC_TARGETS = process.env.RSYNC_TARGETS.split(",");
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
// Push metric
// ======================
function pushMetric(vmId, status) {
    try {
        const pushUrl = `${PUSHGATEWAY_URL}/metrics/job/vm_backup/instance/${vmId}`;
        const metric = `vm_backup{vm="${vmId}", node="${NODE_IP}"} ${status}\n`;
        execSync(`echo '${metric}' | curl --data-binary @- ${pushUrl}`);
    } catch (e) {
        console.error(`Push metric lỗi cho VM ${vmId}:`, e.message);
    }
}

// ======================
// Backup VM
// ======================
function backupVM(vmId) {
    try {
        console.log(`[${NODE_IP}] Backup VM ${vmId}...`);

        execSync(`mkdir -p ${BACKUP_DIR}`);
        // Backup VM hoặc DB theo môi trường
        if (process.env.BACKUP_TYPE === "vm") {
            execSync(
                `vzdump ${vmId} --dumpdir ${BACKUP_DIR} --mode snapshot --compress lzo --remove 0`,
                { stdio: "inherit" }
            );
        } else if (process.env.BACKUP_TYPE === "db") {
            const timestamp = new Date().toISOString().replace(/[:]/g, "-");
            const backupFile = `${BACKUP_DIR}/db_virtualizor_${timestamp}.sql.gz`;
            execSync(`mysqldump -u ${process.env.DB_USER} -p${process.env.DB_PASS} ${vmId} | gzip > ${backupFile}`);
        }

        sendTelegram(`Backup VM/DB ${vmId} thành công`);
        pushMetric(vmId, 1);

        // Cleanup local, giữ lại bản mới nhất
        if (process.env.BACKUP_TYPE === "vm") {
            execSync(`ls -1t ${BACKUP_DIR}/vzdump-qemu-${vmId}-*.vma.* | tail -n +2 | xargs -r rm -f`);
            execSync(`ls -1t ${BACKUP_DIR}/vzdump-qemu-${vmId}-*.log | tail -n +2 | xargs -r rm -f`);
        } else if (process.env.BACKUP_TYPE === "db") {
            execSync(`ls -1t ${BACKUP_DIR}/db_virtualizor_*.sql.* | tail -n +2 | xargs -r rm -f`);
        }

        console.log(`[${NODE_IP}] Cleanup old backups for ${vmId} done`);
    } catch (e) {
        console.error(`[${NODE_IP}] Backup VM/DB ${vmId} error:`, e.message);
        sendTelegram(`Backup VM/DB ${vmId} thất bại: ${e.message}`);
        pushMetric(vmId, 0);
    }
}

// ======================
// Rsync backups sang node khác
// ======================
function syncBackup() {
    RSYNC_TARGETS.forEach(target => {
        if (!target) return;
        try {
            execSync(`rsync -avz ${BACKUP_DIR}/ root@${target}:${BACKUP_DIR}/`);
            sendTelegram(`Rsync VM/DB backups sang ${target} thành công`);

            // Cleanup remote, giữ lại bản mới nhất
            execSync(`ssh root@${target} "cd ${BACKUP_DIR} && if [ '${process.env.BACKUP_TYPE}' = 'vm' ]; then for id in $(ls vzdump-qemu-*.vma.* 2>/dev/null | sed -E 's/vzdump-qemu-([0-9]+)-.*/\\1/' | sort -u); do ls -1t vzdump-qemu-$id-*.vma.* | tail -n +2 | xargs -r rm -f; ls -1t vzdump-qemu-$id-*.log | tail -n +2 | xargs -r rm -f; done; else ls -1t db_virtualizor_*.sql.* | tail -n +2 | xargs -r rm -f; fi"`);
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
    const VM_LIST = process.env.VM_LIST.split(",").map(v => v.trim());
    VM_LIST.forEach(backupVM);
    syncBackup();
}

// Chạy ngay khi start
job();

// Lặp lại mỗi 1 giờ
setInterval(job, 60 * 60 * 1000);
