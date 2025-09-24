const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
require("dotenv").config();

const BACKUP_DIR = process.env.VM_BACKUP_DIR || "/var/backups/vm";
const RSYNC_TARGETS = process.env.RSYNC_TARGETS ? process.env.RSYNC_TARGETS.split(",") : [];
const NODE_IP = process.env.NODE_IP || "localhost";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PUSHGATEWAY_URL = process.env.PUSHGATEWAY_URL;

const LOG_FILE = path.join(BACKUP_DIR, "vm_backup.log");
const ERR_FILE = path.join(BACKUP_DIR, "vm_backup-error.log");

function log(message, isError = false) {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFileSync(isError ? ERR_FILE : LOG_FILE, line);
    console[isError ? "error" : "log"](line.trim());
}

function sendTelegram(message) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
    axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: TELEGRAM_CHAT_ID,
        text: `[${NODE_IP}] ${message}`
    }).catch(err => log(`Telegram send error: ${err.message}`, true));
}

function pushMetric(vmId, status) {
    if (!PUSHGATEWAY_URL) return;
    try {
        const pushUrl = `${PUSHGATEWAY_URL}/metrics/job/vm_backup/instance/${vmId}`;
        const metric = `vm_backup{vm="${vmId}", node="${NODE_IP}"} ${status}\n`;
        execSync(`echo '${metric}' | curl --data-binary @- ${pushUrl}`);
        log(`Push metric: ${vmId} = ${status}`);
    } catch (e) {
        log(`Push metric lỗi cho VM ${vmId}: ${e.message}`, true);
    }
}

// ======================
// Backup VM/DB
// ======================
function backupVM(vmId) {
    try {
        log(`Backup VM/DB ${vmId}...`);
        execSync(`mkdir -p ${BACKUP_DIR}`);

        if (process.env.BACKUP_TYPE === "vm") {
            execSync(
                `vzdump ${vmId} --dumpdir ${BACKUP_DIR} --mode snapshot --compress lzo --remove 0`,
                { stdio: "inherit" }
            );
            // Cleanup local: giữ 1 bản mới nhất cho VM
            execSync(`ls -1t ${BACKUP_DIR}/vzdump-qemu-${vmId}-*.vma.* | tail -n +2 | xargs -r rm -f`);
            execSync(`ls -1t ${BACKUP_DIR}/vzdump-qemu-${vmId}-*.log | tail -n +2 | xargs -r rm -f`);
        } else if (process.env.BACKUP_TYPE === "db") {
            const timestamp = new Date().toISOString().replace(/[:]/g, "-");
            const backupFile = path.join(BACKUP_DIR, `db_virtualizor_${vmId}_${timestamp}.sql.gz`);
            execSync(`mysqldump -u${process.env.DB_USER} -p${process.env.DB_PASS} ${vmId} | gzip > ${backupFile}`);
            // Cleanup local: giữ 1 bản mới nhất cho DB
            execSync(`ls -1t ${BACKUP_DIR}/db_virtualizor_${vmId}_*.sql.gz | tail -n +2 | xargs -r rm -f`);
        }

        log(`Backup VM/DB ${vmId} thành công`);
        sendTelegram(`Backup VM/DB ${vmId} thành công`);
        pushMetric(vmId, 1);
    } catch (e) {
        log(`Backup VM/DB ${vmId} thất bại: ${e.message}`, true);
        sendTelegram(`Backup VM/DB ${vmId} thất bại: ${e.message}`);
        pushMetric(vmId, 0);
    }
}

// ======================
// Rsync sang tất cả node khác, giữ 1 bản mới nhất
// ======================
function syncBackup() {
    RSYNC_TARGETS.forEach(target => {
        if (!target) return;
        try {
            execSync(`rsync -avz ${BACKUP_DIR}/ root@${target}:${BACKUP_DIR}/`);
            log(`Rsync VM/DB backups sang ${target} thành công`);
            sendTelegram(`Rsync VM/DB backups sang ${target} thành công`);

            // Cleanup remote: giữ 1 bản mới nhất
            execSync(`ssh root@${target} "
                cd ${BACKUP_DIR} &&
                if [ '${process.env.BACKUP_TYPE}' = 'vm' ]; then
                    for id in \$(ls vzdump-qemu-*.vma.* 2>/dev/null | sed -E 's/vzdump-qemu-([0-9]+)-.*/\\1/' | sort -u); do
                        ls -1t vzdump-qemu-\$id-*.vma.* | tail -n +2 | xargs -r rm -f
                        ls -1t vzdump-qemu-\$id-*.log | tail -n +2 | xargs -r rm -f
                    done
                else
                    ls -1t db_virtualizor_*.sql.gz | tail -n +2 | xargs -r rm -f
                fi
            "`);
            log(`Cleanup old backups trên ${target} done`);
            sendTelegram(`Cleanup old backups trên ${target} done`);
        } catch (e) {
            log(`Rsync/Cleanup lỗi sang ${target}: ${e.message}`, true);
            sendTelegram(`Rsync/Cleanup lỗi sang ${target}: ${e.message}`);
        }
    });
}

// ======================
// Main job
// ======================
function job() {
    log("Bắt đầu job backup VM/DB...");
    const VM_LIST = process.env.VM_LIST ? process.env.VM_LIST.split(",").map(v => v.trim()) : [];
    VM_LIST.forEach(backupVM);
    syncBackup();
    log("Job backup VM/DB hoàn tất.");
}

// Chạy ngay khi start
job();

// Lặp lại mỗi 1 giờ
setInterval(job, 60 * 60 * 1000);
