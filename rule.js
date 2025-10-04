const { execSync } = require("child_process");
const axios = require("axios");
const ping = require("ping");
require("dotenv").config();

// ======================
// Load config từ .env
// ======================
const NODE_IP = process.env.NODE_IP;
const VM_LIST = process.env.VM_LIST.split(",").map(v => v.trim());

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PUSHGATEWAY_URL = process.env.PUSHGATEWAY_URL;

// Map VMID → IP từ .env (VM_IPS=1008:192.168.80.120,1009:192.168.80.121)
const VM_IPS = Object.fromEntries(
    (process.env.VM_IPS || "")
        .split(",")
        .map(x => x.trim().split(":"))
        .filter(x => x.length === 2)
);

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
        const metric = `vm_network{vm="${vmId}", node="${NODE_IP}"} ${status}\n`;
        execSync(`echo '${metric}' | curl --data-binary @- ${pushUrl}`);
    } catch (e) {
        console.error(`Push metric lỗi cho VM ${vmId}:`, e.message);
    }
}

// ======================
// Ping VM
// ======================
async function pingVM(vmId) {
    try {
        const ip = VM_IPS[vmId];
        if (!ip) {
            console.log(`[${NODE_IP}] VM ${vmId} chưa khai báo IP trong .env`);
            return;
        }

        const res = await ping.promise.probe(ip, { timeout: 2, extra: ["-c1"] });

        if (res.alive) {
            console.log(`[${NODE_IP}] VM ${vmId} (${ip}) online`);
            pushMetric(vmId, 1);
        } else {
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
// Vòng lặp monitor
// ======================
async function monitor() {
    for (const vmId of VM_LIST) {
        await pingVM(vmId);
    }
}

setInterval(monitor, 60000); // check mỗi 60 giây
monitor();
