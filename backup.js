const { execSync } = require("child_process");
require("dotenv").config();

const BACKUP_DIR = "/var/backups/vm";
const RSYNC_TARGETS = process.env.RSYNC_TARGETS.split(","); // Node 2,3
const NODE_IP = process.env.NODE_IP;

// Hàm backup VM
function backupVM(vmId) {
    try {
        console.log(`[${NODE_IP}] Backup VM ${vmId}...`);
        execSync(`vzdump ${vmId} --dumpdir ${BACKUP_DIR} --mode snapshot --compress lzo`);
        console.log(`[${NODE_IP}] Backup VM ${vmId} done!`);
    } catch (e) {
        console.error(`[${NODE_IP}] Backup VM ${vmId} error:`, e.message);
    }
}

// Hàm rsync sang node khác
function syncBackup() {
    RSYNC_TARGETS.forEach(target => {
        try {
            // Rsync file mới
            execSync(`rsync -avz ${BACKUP_DIR}/ root@${target}:${BACKUP_DIR}/`);
            console.log(`[${NODE_IP}] Rsync backup to ${target} done!`);

            // Xóa file backup cũ hơn 1 ngày (trên node con)
            execSync(`ssh root@${target} "find ${BACKUP_DIR} -type f -mtime +1 -delete"`);
            console.log(`[${NODE_IP}] Cleanup old backups (>1 day) on ${target} done!`);
        } catch (e) {
            console.error(`[${NODE_IP}] Rsync/Cleanup error to ${target}:`, e.message);
        }
    });
}

// Main job
function job() {
    const VM_LIST = process.env.VM_LIST.split(",").map(v => v.trim());
    VM_LIST.forEach(backupVM);
    syncBackup();
}

// Chạy mỗi 6h
setInterval(job, 6 * 60 * 60 * 1000);
job();
