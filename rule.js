const { execSync } = require("child_process");
const axios = require("axios");
require("dotenv").config();

// ======================
// Config
// ======================
const NODE_IP = process.env.NODE_IP;
const VM_LIST = process.env.VM_LIST.split(",").map(v => v.trim());
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
function pushMetric(vmId, status) {
    try {
        const pushUrl = `${PUSHGATEWAY_URL}/instance/${vmId}`;
        const metric = `vm_network{vm="${vmId}", node="${NODE_IP}"} ${status}\n`;
        execSync(`echo '${metric}' | curl --data-binary @- ${pushUrl}`);
    } catch (e) {
        console.error(`Push metric lỗi cho VM ${vmId}:`, e.message);
    }
}

// ======================
// Ping VM
// ======================
function pingVM(vmId) {
    try {
        // Lấy IP từ Proxmox config
        const conf = execSync(`qm config ${vmId}`).toString();
        const match = conf.match(/ip=(\\d+\\.\\d+\\.\\d+\\.\\d+)/);
        if (!match) {
            console.log(`[${NODE_IP}] VM ${vmId} không tìm thấy IP trong config`);
            return;
        }
        const ip = match[1];

        try {
            execSync(`ping -c1 -W2 ${ip}`, { stdio: "ignore" });
            console.log(`[${NODE_IP}] VM ${vmId} (${ip}) online`);
            pushMetric(vmId, 1);
        } catch {
            console.warn(`[${NODE_IP}] VM ${vmId} (${ip}) mất mạng -> reboot`);
            sendTelegram(`VM ${vmId} (${ip}) mất mạng, reboot...`);

            try {
                execSync(`qm reboot ${vmId}`);
            } catch {
                execSync(`qm stop ${vmId} && qm start ${vmId}`);
            }

            sendTelegram(`VM ${vmId} đã reboot`);
            pushMetric(vmId, 0);
        }
    } catch (e) {
        console.error(`[${NODE_IP}] Lỗi check VM ${vmId}:`, e.message);
        sendTelegram(`Lỗi check VM ${vmId}: ${e.message}`);
        pushMetric(vmId, 0);
    }
}

// ======================
// Monitor
// ======================
function monitor() {
    VM_LIST.forEach(pingVM);
}

setInterval(monitor, 60000); // check mỗi phút
monitor();
