const { spawn } = require("child_process");
const axios = require("axios");
require("dotenv").config();

const BACKUP_DIR = process.env.VM_BACKUP_DIR || "/var/backups/vm";
const RSYNC_TARGETS = (process.env.RSYNC_TARGETS || "").split(",").map(t => t.trim()).filter(Boolean);
const NODE_IP = process.env.NODE_IP || "local";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PUSHGATEWAY_URL = process.env.PUSHGATEWAY_URL;

// ======================
// Gửi Telegram
// ======================
function sendTelegram(message) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
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
    const pushUrl = `${PUSHGATEWAY_URL}/metrics/job/vm_backup/instance/${vmId}`;
    const metric = `vm_backup{vm="${vmId}", node="${NODE_IP}"} ${status}\n`;
    const curl = spawn("curl", ["--data-binary", `@-`, pushUrl]);
    curl.stdin.write(metric);
    curl.stdin.end();
}

// ======================
// Backup VM/DB
// ======================
function backupVM(vmId) {
    return new Promise((resolve) => {
        console.log(`[${NODE_IP}] Backup ${process.env.BACKUP_TYPE} ${vmId}...`);
        sendTelegram(`Backup ${process.env.BACKUP_TYPE} ${vmId} bắt đầu...`);

        // Tạo thư mục backup
        spawn("mkdir", ["-p", BACKUP_DIR]);

        let backupCmd;
        if (process.env.BACKUP_TYPE === "vm") {
            backupCmd = spawn("vzdump", [vmId, "--dumpdir", BACKUP_DIR, "--mode", "snapshot", "--compress", "lzo", "--remove", "0"], { stdio: "inherit" });
        } else if (process.env.BACKUP_TYPE === "db") {
            const timestamp = new Date().toISOString().replace(/[:]/g, "-");
            const backupFile = `${BACKUP_DIR}/db_virtualizor_${timestamp}.sql.gz`;
            backupCmd = spawn("bash", ["-c", `mysqldump -u ${process.env.DB_USER} -p${process.env.DB_PASS} ${vmId} | gzip > ${backupFile}`], { stdio: "inherit" });
        }

        backupCmd.on("close", (code) => {
            if (code === 0) {
                sendTelegram(`Backup ${process.env.BACKUP_TYPE} ${vmId} thành công`);
                pushMetric(vmId, 1);
                cleanupLocal(vmId).then(() => resolve(vmId));
            } else {
                sendTelegram(`Backup ${process.env.BACKUP_TYPE} ${vmId} thất bại (code ${code})`);
                pushMetric(vmId, 0);
                resolve(null);
            }
        });
    });
}

// ======================
// Cleanup file cũ local
// ======================
function cleanupLocal(vmId) {
    return new Promise((resolve) => {
        let cmd;
        if (process.env.BACKUP_TYPE === "vm") {
            cmd = `ls -1t ${BACKUP_DIR}/vzdump-qemu-${vmId}-*.vma.* | tail -n +2 | xargs -r rm -f; ls -1t ${BACKUP_DIR}/vzdump-qemu-${vmId}-*.log | tail -n +2 | xargs -r rm -f; rm -f ${BACKUP_DIR}/.vzdump-qemu-${vmId}-*.vma.lzo.gdpqbO`;
        } else if (process.env.BACKUP_TYPE === "db") {
            cmd = `ls -1t ${BACKUP_DIR}/db_virtualizor_*.sql.* | tail -n +2 | xargs -r rm -f`;
        }
        const cleanup = spawn("bash", ["-c", cmd]);
        cleanup.on("close", () => {
            console.log(`[${NODE_IP}] Cleanup local old backups for ${vmId} done`);
            resolve();
        });
    });
}

// ======================
// Rsync + cleanup remote
// ======================
function syncBackup(vmId) {
    RSYNC_TARGETS.forEach(target => {
        if (!target) return;
        const rsyncCmd = spawn("rsync", ["-avz", `${BACKUP_DIR}/`, `root@${target}:${BACKUP_DIR}/`], { stdio: "inherit" });

        rsyncCmd.on("close", (code) => {
            if (code === 0) {
                sendTelegram(`Rsync VM/DB backups sang ${target} thành công`);

                // Cleanup remote: giữ bản mới nhất
                let remoteCmd;
                if (process.env.BACKUP_TYPE === "vm") {
                    remoteCmd = `
                        cd ${BACKUP_DIR} &&
                        for id in $(ls vzdump-qemu-*.vma.* 2>/dev/null | sed -E 's/vzdump-qemu-([0-9]+)-.*/\\1/' | sort -u); do
                            ls -1t vzdump-qemu-$id-*.vma.* | tail -n +2 | xargs -r rm -f
                            ls -1t vzdump-qemu-$id-*.log | tail -n +2 | xargs -r rm -f
                            rm -f .vzdump-qemu-$id-*.vma.lzo.gdpqbO
                        done
                    `;
                } else {
                    remoteCmd = `cd ${BACKUP_DIR} && ls -1t db_virtualizor_*.sql.* | tail -n +2 | xargs -r rm -f`;
                }

                const ssh = spawn("ssh", [`root@${target}`, remoteCmd], { stdio: "inherit" });
                ssh.on("close", () => {
                    sendTelegram(`Cleanup old backups trên ${target} done`);
                });
            } else {
                sendTelegram(`Rsync VM/DB backups sang ${target} thất bại`);
            }
        });
    });
}

// ======================
// Main job
// ======================
async function job() {
    const VM_LIST = (process.env.VM_LIST || "").split(",").map(v => v.trim()).filter(Boolean);

    for (const vmId of VM_LIST) {
        const successVm = await backupVM(vmId);
        if (successVm) {
            syncBackup(successVm);
        }
    }
}

// Chạy ngay khi start
job();

// Lặp lại mỗi 1 giờ
setInterval(job, 60 * 60 * 1000);
