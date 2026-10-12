
/* =========================================================
   SMART RELAY DASHBOARD
   ESP32 + SIM800L + MQTT
   ========================================================= */

/* ---------------- MQTT CONFIGURATION ---------------- */

const DEFAULT_MQTT_BROKER = "ws://localhost:9001";

let MQTT_BROKER =
    localStorage.getItem("mqttServer") || DEFAULT_MQTT_BROKER;

let client = null;
let reconnectTimer = null;

const RELAY_COUNT = 4;
const DEVICE_TIMEOUT = 15000;

const TOPICS = {
    relaySet: number => `smartrelay/relay${number}/set`,
    relayStatus: number => `smartrelay/relay${number}/status`,
    deviceStatus: "smartrelay/device/status",
    simStatus: "smartrelay/sim800l/status",
    gsmStatus: "smartrelay/gsm/status"
};

/* ---------------- SYSTEM STATE ---------------- */

// null means the hardware state is not yet confirmed.
const relayState = {
    1: null,
    2: null,
    3: null,
    4: null
};

// Commands awaiting hardware confirmation.
const pendingCommands = {};

let deviceConnected = false;
let simConnected = false;
let gsmAvailable = false;

let commandCount = 0;
let logs = [];
let notifications = [];
let schedules = [];

let lastDeviceHeartbeat = 0;
let lastGSMMessage = 0;

/* ---------------- DOM HELPERS ---------------- */

function get(id) {
    return document.getElementById(id);
}

function setText(id, value) {
    const element = get(id);
    if (element) element.textContent = value;
}

function safeOn(id, eventName, callback) {
    const element = get(id);

    if (element) {
        element.addEventListener(eventName, callback);
    } else {
        console.warn(`HTML element not found: #${id}`);
    }
}

function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[char]);
}

/* ---------------- PAGE TITLES ---------------- */

const pageTitles = {
    "dashboard-page": [
        "Smart Relay Dashboard",
        "Monitor your IoT relay system"
    ],
    "relay-control-page": [
        "Relay Control",
        "Control relay channels through MQTT"
    ],
    "schedules-page": [
        "Relay Schedules",
        "Create automatic relay commands"
    ],
    "logs-page": [
        "System Logs",
        "View command and device history"
    ],
    "alerts-page": [
        "System Alerts",
        "Monitor system warnings"
    ],
    "device-page": [
        "Device & GSM",
        "Monitor ESP32 and SIM800L"
    ],
    "settings-page": [
        "Settings",
        "Configure dashboard settings"
    ],
    "about-page": [
        "About System",
        "Smart IoT Relay Control System"
    ]
};

/* ---------------- MQTT CONNECTION ---------------- */

function connectMQTT() {
    if (typeof mqtt === "undefined") {
        console.error("MQTT.js is missing. Check the MQTT.js script in index.html.");
        setMQTTStatus(false, "MQTT.js not loaded");
        return;
    }

    if (client) {
        try {
            client.removeAllListeners();
            client.end(true);
        } catch (error) {
            console.warn("Previous MQTT client cleanup:", error);
        }
    }

    clearTimeout(reconnectTimer);

    setMQTTStatus(false, "Connecting...");

    try {
        client = mqtt.connect(MQTT_BROKER, {
            reconnectPeriod: 3000,
            connectTimeout: 10000,
            clean: true
        });
    } catch (error) {
        console.error("Unable to start MQTT connection:", error);
        setMQTTStatus(false, "Connection error");
        return;
    }

    client.on("connect", () => {
        console.log("MQTT connected:", MQTT_BROKER);

        setMQTTStatus(true, "Connected to Mosquitto");
        enableControls();

        const topics = [
            TOPICS.relayStatus(1),
            TOPICS.relayStatus(2),
            TOPICS.relayStatus(3),
            TOPICS.relayStatus(4),
            TOPICS.deviceStatus,
            TOPICS.simStatus,
            TOPICS.gsmStatus
        ];

        client.subscribe(topics, error => {
            if (error) {
                console.error("MQTT subscription failed:", error);
                addLog("MQTT", "SUBSCRIBE ERROR", error.message, "FAIL");
            } else {
                addLog("MQTT", "CONNECTED", "Broker connected and status topics subscribed", "SUCCESS");
            }
        });

        addNotification(
            "MQTT Connected",
            "Connected to the MQTT broker.",
            "good"
        );
    });

    client.on("reconnect", () => {
        setMQTTStatus(false, "Reconnecting...");
    });

    client.on("offline", () => {
        setMQTTStatus(false, "Broker offline");
        disableControls();

        addLog(
            "MQTT",
            "DISCONNECTED",
            "Connection to the broker was lost.",
            "FAIL"
        );
    });

    client.on("close", () => {
        setMQTTStatus(false, "Disconnected");
        disableControls();
    });

    client.on("error", error => {
        console.error("MQTT error:", error);

        setMQTTStatus(false, "Connection error");

        addLog(
            "MQTT",
            "ERROR",
            error.message || "MQTT connection error",
            "FAIL"
        );
    });

    client.on("message", (topic, payload) => {
        const message = payload.toString().trim();

        console.log("MQTT message:", topic, message);

        for (let i = 1; i <= RELAY_COUNT; i++) {
            if (topic === TOPICS.relayStatus(i)) {
                processRelayStatus(i, message);
                return;
            }
        }

        if (topic === TOPICS.deviceStatus) {
            processDeviceStatus(message);
        } else if (topic === TOPICS.simStatus) {
            processSIMStatus(message);
        } else if (topic === TOPICS.gsmStatus) {
            processGSMStatus(message);
        }
    });
}

function setMQTTStatus(connected, message) {
    setText("mqttStatus", connected ? "CONNECTED" : "DISCONNECTED");
    setText("sideMqtt", connected ? "CONNECTED" : "DISCONNECTED");
    setText("mqttPageStatus", connected ? "CONNECTED" : "DISCONNECTED");
    setText("mqttAlert", message);

    const element = get("mqttStatus");

    if (element) {
        element.style.color = connected ? "#16a34a" : "#dc2626";
    }

    updateMQTTColor(connected);
}

/* ---------------- RELAY STATUS ---------------- */

function processRelayStatus(number, message) {
    const value = message.toUpperCase();

    if (value !== "ON" && value !== "OFF") {
        console.warn(`Invalid status for relay ${number}:`, message);
        return;
    }

    const isOn = value === "ON";
    const previousState = relayState[number];

    relayState[number] = isOn;

    // A hardware status message confirms the command result.
    const pending = pendingCommands[number];

    if (pending) {
        if (pending.state === isOn) {
            addLog(
                `Relay ${number}`,
                "CONFIRMED",
                `Hardware confirmed ${value}.`,
                "SUCCESS"
            );
        } else {
            addLog(
                `Relay ${number}`,
                "STATUS MISMATCH",
                `Command was ${pending.state ? "ON" : "OFF"}, but hardware reported ${value}.`,
                "FAIL"
            );
        }

        delete pendingCommands[number];
    } else if (previousState !== isOn) {
        addLog(
            `Relay ${number}`,
            value,
            "Relay state received from hardware.",
            "SUCCESS"
        );
    }

    updateRelayUI(number, isOn);
    updateActiveCount();
    updateLastUpdate();
}

function updateRelayUI(number, isOn) {
    const status = get(`status${number}`);
    const mainToggle = get(`relay${number}-toggle`);
    const controlToggle = get(`control-relay${number}`);
    const controlStatus = get(`control-status${number}`);

    const pending = pendingCommands[number];

    if (status) {
        if (pending) {
            status.className = "relay-status unknown";
            status.innerHTML =
                `<span></span> WAITING FOR CONFIRMATION`;
        } else {
            status.className = `relay-status ${isOn ? "on" : "off"}`;
            status.innerHTML =
                `<span></span> ${isOn ? "ON" : "OFF"}`;
        }
    }

    // Keep both dashboard switches in sync with the latest
    // hardware-confirmed state, unless a command is pending.
    if (!pending) {
        if (mainToggle) mainToggle.checked = isOn;
        if (controlToggle) controlToggle.checked = isOn;
    }

    if (controlStatus) {
        controlStatus.textContent = pending
            ? `PENDING ${pending.state ? "ON" : "OFF"}`
            : (isOn ? "ON" : "OFF");

        controlStatus.style.color = pending
            ? "#d97706"
            : (isOn ? "#16a34a" : "#dc2626");
    }
}

function setRelaysUnknown() {
    for (let i = 1; i <= RELAY_COUNT; i++) {
        relayState[i] = null;
        delete pendingCommands[i];

        const status = get(`status${i}`);
        const mainToggle = get(`relay${i}-toggle`);
        const controlToggle = get(`control-relay${i}`);
        const controlStatus = get(`control-status${i}`);

        if (status) {
            status.className = "relay-status unknown";
            status.innerHTML = "<span></span> UNKNOWN";
        }

        if (mainToggle) mainToggle.checked = false;
        if (controlToggle) controlToggle.checked = false;

        if (controlStatus) {
            controlStatus.textContent = "UNKNOWN";
            controlStatus.style.color = "#9ca3af";
        }
    }

    updateActiveCount();
}

/* ---------------- RELAY COMMANDS ---------------- */

function sendRelayCommand(number, requestedState) {
    if (!Number.isInteger(number) || number < 1 || number > RELAY_COUNT) {
        console.error("Invalid relay number:", number);
        return;
    }

    if (!client || !client.connected) {
        alert("MQTT is not connected. The command was not sent.");
        restoreRelaySwitch(number);
        return;
    }

    const state = Boolean(requestedState);
    const command = state ? "ON" : "OFF";
    const topic = TOPICS.relaySet(number);

    pendingCommands[number] = {
        state,
        sentAt: Date.now()
    };

    updatePendingUI(number);

    client.publish(topic, command, { qos: 1 }, error => {
        if (error) {
            console.error("Publish failed:", error);

            delete pendingCommands[number];
            restoreRelaySwitch(number);

            addLog(
                `Relay ${number}`,
                "PUBLISH FAILED",
                error.message || "Unable to publish command.",
                "FAIL"
            );

            addNotification(
                "Command Failed",
                `Relay ${number}: ${command} could not be sent.`,
                "danger"
            );

            return;
        }

        commandCount++;
        setText("commandCard", commandCount);

        addLog(
            `Relay ${number}`,
            command,
            "Command published. Waiting for hardware status confirmation.",
            "INFO"
        );

        addNotification(
            `Relay ${number} Command`,
            `${command} command published. Hardware confirmation is pending.`,
            "info"
        );

        updateLastUpdate();
    });
}


function updatePendingUI(number) {
    const status = get(`status${number}`);

    // Do not show PENDING ON/OFF in the relay card.
    // Keep the displayed state based on hardware feedback.
    if (status && relayState[number] === null) {
        status.className = "relay-status unknown";
        status.innerHTML = "<span></span> UNKNOWN";
    }
}

function restoreRelaySwitch(number) {
    const currentState = relayState[number];

    const mainToggle = get(`relay${number}-toggle`);
    const controlToggle = get(`control-relay${number}`);

    if (currentState !== null) {
        if (mainToggle) mainToggle.checked = currentState;
        if (controlToggle) controlToggle.checked = currentState;
        updateRelayUI(number, currentState);
    } else {
        if (mainToggle) mainToggle.checked = false;
        if (controlToggle) controlToggle.checked = false;
    }
}

function sendAllRelays(state) {
    if (!client || !client.connected) {
        alert("MQTT is not connected.");
        return;
    }

    for (let i = 1; i <= RELAY_COUNT; i++) {
        sendRelayCommand(i, state);
    }
}

/* ---------------- CONTROL ENABLE/DISABLE ---------------- */

function enableControls() {
    const connected = Boolean(client && client.connected);

    for (let i = 1; i <= RELAY_COUNT; i++) {
        const mainToggle = get(`relay${i}-toggle`);
        const controlToggle = get(`control-relay${i}`);

        if (mainToggle) mainToggle.disabled = !connected;
        if (controlToggle) controlToggle.disabled = !connected;
    }

    const allOn = get("allOnBtn");
    const allOff = get("allOffBtn");

    if (allOn) allOn.disabled = !connected;
    if (allOff) allOff.disabled = !connected;
}

function disableControls() {
    enableControls();
}

/* ---------------- RELAY SWITCH EVENTS ---------------- */

for (let i = 1; i <= RELAY_COUNT; i++) {
    const mainToggle = get(`relay${i}-toggle`);
    const controlToggle = get(`control-relay${i}`);

    if (mainToggle) {
        mainToggle.addEventListener("change", () => {
            sendRelayCommand(i, mainToggle.checked);
        });
    }

    if (controlToggle) {
        controlToggle.addEventListener("change", () => {
            sendRelayCommand(i, controlToggle.checked);
        });
    }
}

safeOn("allOnBtn", "click", () => sendAllRelays(true));
safeOn("allOffBtn", "click", () => sendAllRelays(false));

/* ---------------- ESP32 DEVICE STATUS ---------------- */

function processDeviceStatus(message) {
    const value = message.trim().toUpperCase();

    if (value === "ONLINE" || value === "CONNECTED") {
        const wasDisconnected = !deviceConnected;

        deviceConnected = true;
        lastDeviceHeartbeat = Date.now();

        updateDeviceUI(true);

        if (wasDisconnected) {
            addNotification(
                "ESP32 Connected",
                "Device status reports that the ESP32 is online.",
                "good"
            );

            addLog("ESP32", "ONLINE", "Device status received.", "SUCCESS");
        }
    } else if (value === "OFFLINE" || value === "DISCONNECTED") {
        deviceConnected = false;
        lastDeviceHeartbeat = 0;

        updateDeviceUI(false);
        setRelaysUnknown();

        addNotification(
            "ESP32 Disconnected",
            "The device reported an offline status.",
            "danger"
        );

        addLog("ESP32", "OFFLINE", "Device reported offline.", "FAIL");
    }

    updateLastUpdate();
}

function updateDeviceUI(connected) {
    setText("deviceStatus", connected ? "CONNECTED" : "NOT CONNECTED");
    setText("sideDevice", connected ? "CONNECTED" : "NOT CONNECTED");
    setText("devicePageStatus", connected ? "CONNECTED" : "NOT CONNECTED");
    setText("systemStatus", connected ? "SYSTEM ONLINE" : "NOT CONNECTED");

    const dot = get("systemDot");
    if (dot) dot.classList.toggle("online", connected);
}

function checkDeviceHeartbeat() {
    if (
        deviceConnected &&
        lastDeviceHeartbeat &&
        Date.now() - lastDeviceHeartbeat > DEVICE_TIMEOUT
    ) {
        deviceConnected = false;
        lastDeviceHeartbeat = 0;

        updateDeviceUI(false);
        setRelaysUnknown();

        addLog(
            "ESP32",
            "TIMEOUT",
            "No device heartbeat received within the timeout period.",
            "FAIL"
        );

        addNotification(
            "ESP32 Not Connected",
            "Device heartbeat timed out.",
            "danger"
        );
    }

    // Commands are not hardware confirmations. If no status arrives,
    // show that the command is still awaiting confirmation.
    for (let i = 1; i <= RELAY_COUNT; i++) {
        const pending = pendingCommands[i];

        if (pending && Date.now() - pending.sentAt > 10000) {
            delete pendingCommands[i];
            restoreRelaySwitch(i);

            addLog(
                `Relay ${i}`,
                "CONFIRMATION TIMEOUT",
                "No matching relay status was received. Check the device and MQTT topics.",
                "FAIL"
            );

            addNotification(
                `Relay ${i} Unconfirmed`,
                "No hardware status confirmation received.",
                "danger"
            );
        }
    }
}

setInterval(checkDeviceHeartbeat, 3000);

/* ---------------- SIM800L STATUS ---------------- */

function processSIMStatus(message) {
    const value = message.trim().toUpperCase();

    if (["ONLINE", "CONNECTED", "READY"].includes(value)) {
        simConnected = true;
    } else if (["OFFLINE", "DISCONNECTED", "ERROR"].includes(value)) {
        simConnected = false;
    } else {
        return;
    }

    updateSIMUI();
    updateLastUpdate();
}

function updateSIMUI() {
    const value = simConnected ? "CONNECTED" : "NOT CONNECTED";

    setText("simStatus", value);
    setText("sideSim", value);
    setText("simPageStatus", value);
}

/* ---------------- GSM SIGNAL STATUS ---------------- */

function processGSMStatus(message) {
    const value = message.trim();

    if (!value) return;

    gsmAvailable = true;
    lastGSMMessage = Date.now();

    let csq = null;
    let signal = value;

    if (/^\d+$/.test(value)) {
        csq = Number.parseInt(value, 10);
        signal = convertCSQ(csq);
    } else if (value.includes(",")) {
        const parts = value.split(",");
        const parsed = Number.parseInt(parts[0], 10);

        if (!Number.isNaN(parsed)) {
            csq = parsed;
            signal = parts.slice(1).join(",").trim() || convertCSQ(csq);
        }
    }

    setText("gsmSignal", signal);
    setText("gsmCard", csq !== null ? String(csq) : signal);
    setText(
        "gsmPageSignal",
        csq !== null ? `${csq} CSQ - ${signal}` : signal
    );
    setText("gsmValue", "SIM800L");

    updateLastUpdate();
}

function convertCSQ(csq) {
    if (csq === 99 || Number.isNaN(csq) || csq < 0 || csq > 31) {
        return "NOT AVAILABLE";
    }

    if (csq <= 9) return "VERY WEAK";
    if (csq <= 14) return "WEAK";
    if (csq <= 19) return "FAIR";
    if (csq <= 24) return "GOOD";

    return "EXCELLENT";
}

/* ---------------- ACTIVE RELAY COUNT ---------------- */

function updateActiveCount() {
    let active = 0;
    let known = 0;

    for (let i = 1; i <= RELAY_COUNT; i++) {
        if (relayState[i] !== null) {
            known++;

            if (relayState[i] === true) active++;
        }
    }

    if (known === 0) {
        setText("activeRelays", "--");
        setText("activePercentage", "Waiting for device");
        return;
    }

    setText("activeRelays", String(active));
    setText("activePercentage", `${active}/4 relays active`);
}

/* ---------------- PAGE NAVIGATION ---------------- */

document.querySelectorAll(".menu-item").forEach(button => {
    button.addEventListener("click", () => {
        const page = button.dataset.page;
        openPage(page);
        setActiveMenu(page);
    });
});

function openPage(page) {
    document.querySelectorAll(".app-page").forEach(section => {
        section.style.display = "none";
    });

    const selected = get(page);

    if (selected) selected.style.display = "block";

    if (pageTitles[page]) {
        setText("pageTitle", pageTitles[page][0]);
        setText("pageSubtitle", pageTitles[page][1]);
    }
}

function setActiveMenu(page) {
    document.querySelectorAll(".menu-item").forEach(item => {
        item.classList.toggle("active", item.dataset.page === page);
    });
}

safeOn("topSettings", "click", () => {
    openPage("settings-page");
    setActiveMenu("settings-page");
});

safeOn("viewLogs", "click", () => {
    openPage("logs-page");
    setActiveMenu("logs-page");
});

/* ---------------- ACTIVITY FEED ---------------- */

function addActivity(relay, state) {
    const list = get("activityList");
    if (!list) return;

    const empty = list.querySelector(".no-activity");
    if (empty) empty.remove();

    const item = document.createElement("div");
    item.className = "activity-item";

    item.innerHTML = `
        <div class="activity-icon ${state === "ON" ? "on" : "off"}">
            <i class="fa-solid fa-power-off"></i>
        </div>
        <div class="activity-info">
            <strong>${escapeHTML(relay)} ${escapeHTML(state)}</strong>
            <small>Hardware confirmed • ${new Date().toLocaleTimeString()}</small>
        </div>
    `;

    list.prepend(item);

    while (list.children.length > 8) {
        list.removeChild(list.lastChild);
    }
}

/* ---------------- LOGS ---------------- */

function addLog(source, event, details, result = "INFO") {
    const entry = {
        time: new Date().toLocaleString(),
        source,
        event,
        details,
        result
    };

    logs.unshift(entry);
    if (logs.length > 200) logs.pop();

    renderLogs();

    try {
        localStorage.setItem("relayLogs", JSON.stringify(logs));
    } catch (error) {
        console.warn("Could not save logs:", error);
    }
}

function renderLogs() {
    const container = get("fullLogs");
    if (!container) return;

    if (logs.length === 0) {
        container.innerHTML = "<p>No logs available.</p>";
        return;
    }

    container.innerHTML = logs.map(log => `
        <div class="log-row">
            <span>${escapeHTML(log.time)}</span>
            <strong>${escapeHTML(log.source)}</strong>
            <span>${escapeHTML(log.event)} - ${escapeHTML(log.details)}</span>
            <strong class="${
                log.result === "SUCCESS" ? "log-success" :
                log.result === "FAIL" ? "log-fail" : "log-info"
            }">${escapeHTML(log.result)}</strong>
        </div>
    `).join("");
}

try {
    const savedLogs = localStorage.getItem("relayLogs");
    if (savedLogs) {
        const parsed = JSON.parse(savedLogs);
        if (Array.isArray(parsed)) logs = parsed;
    }
} catch (error) {
    console.warn("Could not load saved logs:", error);
}

safeOn("clearLogs", "click", () => {
    logs = [];

    try {
        localStorage.removeItem("relayLogs");
    } catch (error) {
        console.warn(error);
    }

    renderLogs();
});

/* ---------------- NOTIFICATIONS ---------------- */

function addNotification(title, message, type = "info") {
    notifications.unshift({
        title,
        message,
        type,
        time: new Date().toLocaleTimeString()
    });

    if (notifications.length > 20) notifications.pop();

    renderNotifications();
}

function renderNotifications() {
    const list = get("notificationList");
    const badge = get("notificationBadge");

    if (!list || !badge) return;

    badge.textContent = String(notifications.length);

    if (notifications.length === 0) {
        list.innerHTML = `
            <div class="empty-notification">No notifications</div>
        `;
        return;
    }

    list.innerHTML = notifications.map(item => `
        <div class="notification-item">
            <i class="fa-solid fa-circle-info"></i>
            <div>
                <strong>${escapeHTML(item.title)}</strong>
                <small>${escapeHTML(item.message)} • ${escapeHTML(item.time)}</small>
            </div>
        </div>
    `).join("");
}

safeOn("notificationBtn", "click", event => {
    event.stopPropagation();

    const panel = get("notificationPanel");
    if (panel) panel.classList.toggle("show");
});

document.addEventListener("click", () => {
    const panel = get("notificationPanel");
    if (panel) panel.classList.remove("show");
});

safeOn("notificationPanel", "click", event => {
    event.stopPropagation();
});

safeOn("clearNotifications", "click", () => {
    notifications = [];
    renderNotifications();
});

/* ---------------- ADMIN MENU & LOGOUT ---------------- */

safeOn("adminUserButton", "click", () => {
    const menu = get("adminMenu");
    if (menu) menu.classList.toggle("show");
});

document.querySelectorAll(".admin-menu button[data-admin]").forEach(button => {
    button.addEventListener("click", () => {
        const type = button.dataset.admin;

        if (type === "account") {
            openPage("settings-page");
            setActiveMenu("settings-page");
        } else if (type === "profile") {
            alert("Admin User\nRole: Administrator");
        } else if (type === "activity") {
            openPage("logs-page");
            setActiveMenu("logs-page");
        }

        const menu = get("adminMenu");
        if (menu) menu.classList.remove("show");
    });
});

safeOn("topLogout", "click", () => {
    const modal = get("logoutModal");
    if (modal) modal.classList.add("show");
});

safeOn("adminLogout", "click", () => {
    const menu = get("adminMenu");
    if (menu) menu.classList.remove("show");

    const modal = get("logoutModal");
    if (modal) modal.classList.add("show");
});

safeOn("cancelLogout", "click", () => {
    const modal = get("logoutModal");
    if (modal) modal.classList.remove("show");
});

safeOn("confirmLogout", "click", () => {
    alert("This demo login is local to the browser. Connect a real authentication system for secure logout.");

    const modal = get("logoutModal");
    if (modal) modal.classList.remove("show");
});

/* ---------------- SCHEDULES ---------------- */

function loadSchedules() {
    try {
        const saved = localStorage.getItem("relaySchedules");
        if (saved) {
            const parsed = JSON.parse(saved);
            if (Array.isArray(parsed)) schedules = parsed;
        }
    } catch (error) {
        console.warn("Could not load schedules:", error);
    }
}

function saveSchedules() {
    try {
        localStorage.setItem("relaySchedules", JSON.stringify(schedules));
    } catch (error) {
        console.error("Could not save schedules:", error);
    }
}

function closeSchedule() {
    const modal = get("scheduleModal");
    if (modal) modal.classList.remove("show");
}

safeOn("addScheduleBtn", "click", () => {
    const modal = get("scheduleModal");
    if (modal) modal.classList.add("show");
});

safeOn("closeSchedule", "click", closeSchedule);
safeOn("cancelSchedule", "click", closeSchedule);

safeOn("saveSchedule", "click", () => {
    const relay = get("scheduleRelay")?.value;
    const action = get("scheduleAction")?.value;
    const date = get("scheduleDate")?.value;
    const time = get("scheduleTime")?.value;
    const repeat = get("scheduleRepeat")?.value || "Once";

    if (!relay || !action || !date || !time) {
        alert("Please select the relay, action, date, and time.");
        return;
    }

    const runAt = new Date(`${date}T${time}`);

    if (Number.isNaN(runAt.getTime())) {
        alert("Please enter a valid date and time.");
        return;
    }

    if (runAt.getTime() <= Date.now()) {
        alert("Choose a future date and time.");
        return;
    }

    schedules.push({
        id: Date.now(),
        relay: String(relay),
        action: String(action).toUpperCase(),
        date,
        time,
        repeat,
        enabled: true,
        lastRunKey: null
    });

    saveSchedules();
    renderSchedules();
    closeSchedule();

    addLog(
        "SCHEDULE",
        "CREATED",
        `Relay ${relay} ${action} at ${date} ${time}; repeat: ${repeat}`,
        "SUCCESS"
    );

    addNotification(
        "Schedule Created",
        `Relay ${relay} ${action} scheduled for ${date} ${time}.`,
        "info"
    );
});

function renderSchedules() {
    const list = get("scheduleList");
    if (!list) return;

    if (schedules.length === 0) {
        list.innerHTML = `
            <div class="empty-page small-empty">
                <i class="fa-regular fa-calendar"></i>
                <h2>No schedules</h2>
                <p>Create your first automatic relay schedule.</p>
            </div>
        `;
        return;
    }

    list.innerHTML = schedules.map(schedule => `
        <div class="schedule-item">
            <div class="relay-color">
                <i class="fa-solid fa-bolt"></i>
            </div>
            <div class="schedule-info">
                <strong>
                    Relay ${escapeHTML(schedule.relay)}
                    → ${escapeHTML(schedule.action)}
                </strong>
                <small>
                    ${escapeHTML(schedule.date)} •
                    ${escapeHTML(schedule.time)} •
                    ${escapeHTML(schedule.repeat)}
                    • ${schedule.enabled ? "Enabled" : "Disabled"}
                </small>
            </div>
            <div class="schedule-actions">
                <button class="delete-schedule"
                    data-id="${Number(schedule.id)}"
                    aria-label="Delete schedule">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
        </div>
    `).join("");

    list.querySelectorAll(".delete-schedule").forEach(button => {
        button.addEventListener("click", () => {
            deleteSchedule(Number(button.dataset.id));
        });
    });
}

function deleteSchedule(id) {
    schedules = schedules.filter(schedule => schedule.id !== id);

    saveSchedules();
    renderSchedules();

    addLog("SCHEDULE", "DELETED", "Schedule removed.", "SUCCESS");
}

function scheduleTick() {
    const now = new Date();

    schedules.forEach(schedule => {
        if (!schedule.enabled) return;

        const scheduledTime = new Date(`${schedule.date}T${schedule.time}`);
        if (Number.isNaN(scheduledTime.getTime())) return;

        const repeat = String(schedule.repeat).toLowerCase();
        let shouldRun = false;
        let runKey = "";

        if (repeat === "daily" || repeat === "every day") {
            shouldRun =
                now.getHours() === scheduledTime.getHours() &&
                now.getMinutes() === scheduledTime.getMinutes();

            runKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${schedule.time}`;
        } else if (
            repeat === "weekly" ||
            repeat === "every week"
        ) {
            shouldRun =
                now.getDay() === scheduledTime.getDay() &&
                now.getHours() === scheduledTime.getHours() &&
                now.getMinutes() === scheduledTime.getMinutes();

            runKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${schedule.time}`;
        } else {
            // One-time schedules.
            shouldRun = now >= scheduledTime;
            runKey = `once-${schedule.id}`;

            if (shouldRun) schedule.enabled = false;
        }

        if (!shouldRun || schedule.lastRunKey === runKey) return;

        // Mark this occurrence to prevent repeated execution during
        // the same minute.
        schedule.lastRunKey = runKey;

        const relayNumber = Number(schedule.relay);
        const state = String(schedule.action).toUpperCase() === "ON";

        if (!client || !client.connected) {
            addLog(
                "SCHEDULE",
                "NOT EXECUTED",
                `Relay ${relayNumber} schedule skipped because MQTT is disconnected.`,
                "FAIL"
            );
            return;
        }

        sendRelayCommand(relayNumber, state);

        addLog(
            "SCHEDULE",
            "TRIGGERED",
            `Relay ${relayNumber} ${state ? "ON" : "OFF"} command triggered.`,
            "INFO"
        );
    });

    saveSchedules();
    renderSchedules();
}

window.deleteSchedule = deleteSchedule;

loadSchedules();
renderSchedules();
setInterval(scheduleTick, 1000);

/* ---------------- SETTINGS ---------------- */

safeOn("saveSettings", "click", () => {
    const serverInput = get("mqttServerInput");
    const deviceInput = get("deviceIdInput");

    const server = serverInput?.value.trim();
    const device = deviceInput?.value.trim();

    if (!server) {
        alert("Enter the MQTT WebSocket address.");
        return;
    }

    if (!/^wss?:\/\//i.test(server)) {
        alert("The MQTT address must begin with ws:// or wss://");
        return;
    }

    try {
        localStorage.setItem("mqttServer", server);
        localStorage.setItem("deviceId", device || "");
    } catch (error) {
        alert("Could not save settings in this browser.");
        return;
    }

    if (server !== MQTT_BROKER) {
        MQTT_BROKER = server;
        connectMQTT();
    }

    addLog("SETTINGS", "SAVED", "Dashboard settings updated.", "SUCCESS");
    alert("Settings saved. MQTT connection is being updated if necessary.");
});

/* ---------------- CLOCK & LAST UPDATE ---------------- */

function updateClock() {
    setText("currentTime", new Date().toLocaleTimeString());
}

function updateLastUpdate() {
    setText("lastUpdate", new Date().toLocaleTimeString());
}

function updateMQTTColor(connected) {
    const element = get("mqttStatus");

    if (element) {
        element.style.color = connected ? "#16a34a" : "#dc2626";
    }
}

setInterval(updateClock, 1000);
updateClock();

/* ---------------- LIGHT / DARK MODE ---------------- */

safeOn("theme-toggle", "click", () => {
    document.body.classList.toggle("dark-mode");

    const dark = document.body.classList.contains("dark-mode");
    const button = get("theme-toggle");

    if (button) button.textContent = dark ? "☀️" : "🌙";

    try {
        localStorage.setItem("theme", dark ? "dark" : "light");
    } catch (error) {
        console.warn("Could not save theme:", error);
    }
});

try {
    const savedTheme = localStorage.getItem("theme");

    if (savedTheme === "dark") {
        document.body.classList.add("dark-mode");

        const button = get("theme-toggle");
        if (button) button.textContent = "☀️";
    }
} catch (error) {
    console.warn("Could not load theme:", error);
}

/* ---------------- LOGIN ---------------- */

safeOn("loginForm", "submit", event => {
    event.preventDefault();

    const username = get("username")?.value.trim() || "";
    const password = get("password")?.value || "";
    const errorElement = get("loginError");
    const loginScreen = get("loginScreen");

    // Demo-only credentials. This is not secure authentication.
    if (username === "the beyonders" && password === "12345678") {
        if (errorElement) errorElement.textContent = "";
        if (loginScreen) loginScreen.style.display = "none";

        addLog("LOGIN", "SUCCESS", "Demo login successful.", "SUCCESS");
    } else {
        if (errorElement) {
            errorElement.textContent = "Incorrect username or password.";
        }

        const passwordInput = get("password");
        if (passwordInput) {
            passwordInput.value = "";
            passwordInput.focus();
        }
    }
});

/* ---------------- INITIALIZE DASHBOARD ---------------- */

disableControls();
setRelaysUnknown();
updateDeviceUI(false);
updateSIMUI();
renderNotifications();
renderLogs();
renderSchedules();

// Populate settings inputs from saved values.
if (get("mqttServerInput")) {
    get("mqttServerInput").value = MQTT_BROKER;
}

if (get("deviceIdInput")) {
    get("deviceIdInput").value =
        localStorage.getItem("deviceId") || "";
}

// Connect after all event handlers and UI initialization.
connectMQTT();
