const { execSync } = require("child_process");
const axios = require("axios");
require("dotenv").config();

// ======================
// Load config từ .env
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
// Gửi metric lên Pushgateway
// ======================
function pushMetric(vmId, status) {
    try {
        const pushUrl = `${PUSHGATEWAY_URL}/instance/${vmId}`;
        const metric = `vm_autofix{vm="${vmId}", node="${NODE_IP}"} ${status}\n`;
        execSync(`echo '${metric}' | curl --data-binary @- ${pushUrl}`);
    } catch (e) {
        console.error(`Push metric lỗi cho VM ${vmId}:`, e.message);
    }
}

// ======================
// Kiểm tra trạng thái VM
// ======================
function checkVM(vmId) {
    try {
        let cmd = `qm status ${vmId}`;
        let status = execSync(cmd).toString();

        if (!status.includes("running")) {
            sendTelegram(`VM ${vmId} không chạy, đang cố gắng restart...`);

            let startCmd = `qm start ${vmId}`;
            execSync(startCmd);

            sendTelegram(`VM ${vmId} đã restart`);
            pushMetric(vmId, 1); // thành công
        } else {
            pushMetric(vmId, 1); // OK
        }
    } catch (e) {
        sendTelegram(`Lỗi khi kiểm tra VM ${vmId}: ${e.message}`);
        pushMetric(vmId, 0); // lỗi
    }
}

// ======================
// Vòng lặp monitor
// ======================
function monitor() {
    VM_LIST.forEach(vmId => checkVM(vmId));
}

setInterval(monitor, 30000);
monitor();
