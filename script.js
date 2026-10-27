
/* =========================================================
   SMART RELAY DASHBOARD
   ESP32 + SIM800L + MQTT
   ========================================================= */

/* ---------------- MQTT CONFIGURATION ---------------- */

const DEFAULT_MQTT_BROKER =
    "wss://n1fcf71d.ala.asia-southeast1.emqxsl.com:8084/mqtt";

let MQTT_BROKER = (() => {
    let savedBroker = "";

    try {
        savedBroker = (
            localStorage.getItem("mqttServer") || ""
        ).trim();
    } catch (error) {
        console.warn("Could not read saved MQTT broker:", error);
    }

    if (
        !savedBroker ||
        /^wss?:\/\/localhost(?::|\/|$)/i.test(savedBroker) ||
        /^wss?:\/\/127\.0\.0\.1(?::|\/|$)/i.test(savedBroker)
    ) {
        try {
            localStorage.setItem(
                "mqttServer",
                DEFAULT_MQTT_BROKER
            );
        } catch (error) {
            console.warn("Could not save MQTT broker:", error);
        }

        return DEFAULT_MQTT_BROKER;
    }

    return savedBroker;
})();

function getMQTTCredentials() {
    return {
        username: "REPLACE_WITH_YOUR_EMQX_USERNAME",
        password: "REPLACE_WITH_YOUR_NEW_EMQX_PASSWORD"
    };
}

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

const relayState = {
    1: null,
    2: null,
    3: null,
    4: null
};

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
        console.error(
            "MQTT.js is missing. Check the MQTT.js script in index.html."
        );
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
        const credentials = getMQTTCredentials();

        const mqttOptions = {
            reconnectPeriod: 3000,
            connectTimeout: 10000,
            clean: true,
            keepalive: 30
        };

        if (credentials.username) {
            mqttOptions.username = credentials.username;
        }

        if (credentials.password) {
            mqttOptions.password = credentials.password;
        }

        client = mqtt.connect(MQTT_BROKER, mqttOptions);
    } catch (error) {
        console.error("Unable to start MQTT connection:", error);
        setMQTTStatus(false, "Connection error");
        return;
    }

    client.on("connect", () => {
        console.log("MQTT connected:", MQTT_BROKER);

        setMQTTStatus(true, "Connected to EMQX");
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

                addLog(
                    "MQTT",
                    "SUBSCRIBE ERROR",
                    error.message,
                    "FAIL"
                );
            } else {
                addLog(
                    "MQTT",
                    "CONNECTED",
                    "Broker connected and status topics subscribed",
                    "SUCCESS"
                );
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
        clearPendingCommandsOnDisconnect();

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
        clearPendingCommandsOnDisconnect();
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
        console.warn(
            `Invalid status for relay ${number}:`,
            message
        );
        return;
    }

    const isOn = value === "ON";
    const previousState = relayState[number];

    relayState[number] = isOn;

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

        clearTimeout(pending.timeoutId);
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
    enableControls();
}

/* ---------------- RELAY UI ---------------- */

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
                "<span></span> WAITING FOR CONFIRMATION";
        } else {
            status.className =
                `relay-status ${isOn ? "on" : "off"}`;

            status.innerHTML =
                `<span></span> ${isOn ? "ON" : "OFF"}`;
        }
    }

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

/* ---------------- UNKNOWN RELAY STATES ---------------- */

function setRelaysUnknown() {
    for (let i = 1; i <= RELAY_COUNT; i++) {
        relayState[i] = null;

        if (pendingCommands[i]) {
            clearTimeout(pendingCommands[i].timeoutId);
            delete pendingCommands[i];
        }

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
    if (
        !Number.isInteger(number) ||
        number < 1 ||
        number > RELAY_COUNT
    ) {
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

    if (pendingCommands[number]) {
        clearTimeout(pendingCommands[number].timeoutId);
    }

    const pending = {
        state,
        sentAt: Date.now(),
        timeoutId: null
    };

    pendingCommands[number] = pending;

    updatePendingUI(number);

    pending.timeoutId = setTimeout(() => {
        if (pendingCommands[number] !== pending) return;

        delete pendingCommands[number];
        restoreRelaySwitch(number);

        addLog(
            `Relay ${number}`,
            "CONFIRMATION TIMEOUT",
            "No matching relay status was received. The physical state is not confirmed.",
            "FAIL"
        );

        addNotification(
            `Relay ${number} Unconfirmed`,
            "No hardware confirmation received. Check the device and MQTT topics.",
            "danger"
        );

        enableControls();
    }, 10000);

    client.publish(topic, command, { qos: 1 }, error => {
        if (pendingCommands[number] !== pending) return;

        if (error) {
            clearTimeout(pending.timeoutId);
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

/* ---------------- PENDING RELAY UI ---------------- */

function updatePendingUI(number) {
    const status = get(`status${number}`);
    const controlStatus = get(`control-status${number}`);
    const mainToggle = get(`relay${number}-toggle`);
    const controlToggle = get(`control-relay${number}`);
    const pending = pendingCommands[number];

    if (!pending) return;

    if (status) {
        status.className = "relay-status unknown";
        status.innerHTML =
            `<span></span> WAITING FOR ${pending.state ? "ON" : "OFF"} CONFIRMATION`;
    }

    if (controlStatus) {
        controlStatus.textContent =
            `WAITING FOR ${pending.state ? "ON" : "OFF"} CONFIRMATION`;
        controlStatus.style.color = "#d97706";
    }

    // Show the requested state immediately while awaiting feedback.
    // The switch remains disabled until matching feedback arrives.
    if (mainToggle) {
        mainToggle.checked = pending.state;
        mainToggle.disabled = true;
    }

    if (controlToggle) {
        controlToggle.checked = pending.state;
        controlToggle.disabled = true;
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

        const status = get(`status${number}`);
        const controlStatus = get(`control-status${number}`);

        if (status) {
            status.className = "relay-status unknown";
            status.innerHTML = "<span></span> UNKNOWN";
        }

        if (controlStatus) {
            controlStatus.textContent = "UNKNOWN";
            controlStatus.style.color = "#9ca3af";
        }
    }

    enableControls();
}

/* ---------------- ALL RELAY CONTROLS ---------------- */

function sendAllRelays(state) {
    if (!client || !client.connected) {
        alert("MQTT is not connected.");
        console.error("Bulk relay command failed: MQTT disconnected.");
        return;
    }

    const command = state ? "ON" : "OFF";

    console.log(
        `ALL ${command}: sending commands to ${RELAY_COUNT} relays`
    );

    for (let i = 1; i <= RELAY_COUNT; i++) {
        console.log(`Sending ${command} to relay ${i}`);
        sendRelayCommand(i, state);
    }
}

/* ---------------- CONTROL ENABLE/DISABLE ---------------- */

function enableControls() {
    const connected = Boolean(client && client.connected);

    for (let i = 1; i <= RELAY_COUNT; i++) {
        const mainToggle = get(`relay${i}-toggle`);
        const controlToggle = get(`control-relay${i}`);
        const isPending = Boolean(pendingCommands[i]);
        const disabled = !connected || isPending;

        if (mainToggle) mainToggle.disabled = disabled;
        if (controlToggle) controlToggle.disabled = disabled;
    }

    const allOn = get("allOnBtn");
    const allOff = get("allOffBtn");

    if (allOn) allOn.disabled = !connected;
    if (allOff) allOff.disabled = !connected;
}

function disableControls() {
    enableControls();
}

function clearPendingCommandsOnDisconnect() {
    for (let i = 1; i <= RELAY_COUNT; i++) {
        if (pendingCommands[i]) {
            clearTimeout(pendingCommands[i].timeoutId);
            delete pendingCommands[i];

            restoreRelaySwitch(i);
        }
    }
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

            addLog(
                "ESP32",
                "ONLINE",
                "Device status received.",
                "SUCCESS"
            );
        }
    } else if (
        value === "OFFLINE" ||
        value === "DISCONNECTED"
    ) {
        deviceConnected = false;
        lastDeviceHeartbeat = 0;

        updateDeviceUI(false);
        setRelaysUnknown();

        addNotification(
            "ESP32 Disconnected",
            "The device reported an offline status.",
            "danger"
        );

        addLog(
            "ESP32",
            "OFFLINE",
            "Device reported offline.",
            "FAIL"
        );
    } else {
        console.warn("Unknown ESP32 status payload:", message);
        return;
    }

    updateLastUpdate();
}

function updateDeviceUI(connected) {
    setText(
        "deviceStatus",
        connected ? "CONNECTED" : "NOT CONNECTED"
    );

    setText(
        "sideDevice",
        connected ? "CONNECTED" : "NOT CONNECTED"
    );

    setText(
        "devicePageStatus",
        connected ? "CONNECTED" : "NOT CONNECTED"
    );

    setText(
        "systemStatus",
        connected ? "SYSTEM ONLINE" : "NOT CONNECTED"
    );

    const dot = get("systemDot");

    if (dot) {
        dot.classList.toggle("online", connected);
    }
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
}

setInterval(checkDeviceHeartbeat, 3000);

/* ---------------- SIM800L STATUS ---------------- */

function processSIMStatus(message) {
    const value = message.trim().toUpperCase();

    if (["ONLINE", "CONNECTED", "READY"].includes(value)) {
        simConnected = true;
    } else if (
        ["OFFLINE", "DISCONNECTED", "ERROR"].includes(value)
    ) {
        simConnected = false;
    } else {
        console.warn("Unknown SIM800L status payload:", message);
        return;
    }

    updateSIMUI();
    updateLastUpdate();
}

function updateSIMUI() {
    const status = simConnected
        ? "CONNECTED"
        : "NOT CONNECTED";

    setText("simStatus", status);
    setText("sideSim", status);
    setText("simPageStatus", status);
}

/* ---------------- GSM SIGNAL STATUS ---------------- */

function processGSMStatus(message) {
    const value = message.trim();

    if (!value) return;

    lastGSMMessage = Date.now();

    const numericValue = Number(value);

    if (Number.isFinite(numericValue)) {
        gsmAvailable = true;

        setText("gsmSignal", `${numericValue}`);
        setText("gsmCard", `${numericValue}`);
        setText("gsmPageSignal", `${numericValue}`);
    } else {
        gsmAvailable = true;

        setText("gsmSignal", value);
        setText("gsmCard", value);
        setText("gsmPageSignal", value);
    }

    updateLastUpdate();
}

/* ---------------- GSM SIGNAL CONVERSION ---------------- */

function convertCSQ(csq) {
    if (
        csq === 99 ||
        Number.isNaN(csq) ||
        csq < 0 ||
        csq > 31
    ) {
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
        item.classList.toggle(
            "active",
            item.dataset.page === page
        );
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

        if (Array.isArray(parsed)) {
            logs = parsed;
        }
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

    if (notifications.length > 20) {
        notifications.pop();
    }

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

    if (panel) {
        panel.classList.toggle("show");
    }
});

document.addEventListener("click", () => {
    const panel = get("notificationPanel");

    if (panel) {
        panel.classList.remove("show");
    }
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

    if (menu) {
        menu.classList.toggle("show");
    }
});

document.querySelectorAll(
    ".admin-menu button[data-admin]"
).forEach(button => {
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

        if (menu) {
            menu.classList.remove("show");
        }
    });
});

safeOn("topLogout", "click", () => {
    const modal = get("logoutModal");

    if (modal) {
        modal.classList.add("show");
    }
});

safeOn("adminLogout", "click", () => {
    const menu = get("adminMenu");

    if (menu) {
        menu.classList.remove("show");
    }

    const modal = get("logoutModal");

    if (modal) {
        modal.classList.add("show");
    }
});

safeOn("cancelLogout", "click", () => {
    const modal = get("logoutModal");

    if (modal) {
        modal.classList.remove("show");
    }
});

safeOn("confirmLogout", "click", () => {
    const modal = get("logoutModal");
    const loginScreen = get("loginScreen");
    const usernameInput = get("username");
    const passwordInput = get("password");
    const errorElement = get("loginError");

    if (modal) modal.classList.remove("show");

    // Close the MQTT connection during logout.
    if (client) {
        try {
            client.end(true);
        } catch (error) {
            console.warn(
                "Error closing MQTT connection during logout:",
                error
            );
        }

        client = null;
    }

    clearTimeout(reconnectTimer);
    clearPendingCommandsOnDisconnect();
    disableControls();

    // Hide the application pages.
    document.querySelectorAll(".app-page").forEach(page => {
        page.style.display = "none";
    });

    // Return to the login page.
    if (loginScreen) {
        loginScreen.style.display = "flex";
    } else {
        console.error(
            'Login screen element "#loginScreen" was not found.'
        );
    }

    // Clear the login fields.
    if (usernameInput) usernameInput.value = "";
    if (passwordInput) passwordInput.value = "";
    if (errorElement) errorElement.textContent = "";

    if (usernameInput) usernameInput.focus();
});

/* ---------------- SCHEDULES ---------------- */

function loadSchedules() {
    try {
        const saved = localStorage.getItem("relaySchedules");

        if (saved) {
            const parsed = JSON.parse(saved);

            if (Array.isArray(parsed)) {
                schedules = parsed;
            }
        }
    } catch (error) {
        console.warn("Could not load schedules:", error);
    }

    renderSchedules();
}

function saveSchedulesToStorage() {
    try {
        localStorage.setItem(
            "relaySchedules",
            JSON.stringify(schedules)
        );
    } catch (error) {
        console.error("Could not save schedules:", error);

        addNotification(
            "Schedule Error",
            "The schedule could not be saved in this browser.",
            "danger"
        );
    }
}

function renderSchedules() {
    const container = get("scheduleList");
    if (!container) return;

    if (schedules.length === 0) {
        container.innerHTML = `
            <div class="empty-page small-empty">
                <i class="fa-regular fa-calendar"></i>
                <h2>No schedules</h2>
                <p>Create your first automatic relay schedule.</p>
            </div>
        `;
        return;
    }

    container.innerHTML = schedules.map((schedule, index) => `
        <div class="schedule-card">
            <div>
                <h3>Relay ${escapeHTML(schedule.relay)}</h3>
                <p>
                    ${escapeHTML(schedule.action)}
                    · ${escapeHTML(schedule.date)}
                    · ${escapeHTML(schedule.time)}
                </p>
                <small>Repeat: ${escapeHTML(schedule.repeat)}</small>
            </div>
            <button
                type="button"
                class="delete-schedule"
                data-schedule-index="${index}"
            >
                Delete
            </button>
        </div>
    `).join("");

    container.querySelectorAll("[data-schedule-index]").forEach(button => {
        button.addEventListener("click", () => {
            const index = Number(button.dataset.scheduleIndex);

            if (!Number.isInteger(index) || !schedules[index]) return;

            schedules.splice(index, 1);
            saveSchedulesToStorage();
            renderSchedules();
        });
    });
}

function closeScheduleModal() {
    const modal = get("scheduleModal");

    if (modal) {
        modal.classList.remove("show");
    }
}

safeOn("addScheduleBtn", "click", () => {
    const modal = get("scheduleModal");

    if (modal) {
        modal.classList.add("show");
    }
});

safeOn("closeSchedule", "click", closeScheduleModal);
safeOn("cancelSchedule", "click", closeScheduleModal);

safeOn("saveSchedule", "click", () => {
    const relay = Number(get("scheduleRelay")?.value);
    const action = get("scheduleAction")?.value;
    const date = get("scheduleDate")?.value;
    const time = get("scheduleTime")?.value;
    const repeat = get("scheduleRepeat")?.value;

    if (
        !Number.isInteger(relay) ||
        relay < 1 ||
        relay > RELAY_COUNT ||
        !["ON", "OFF"].includes(action) ||
        !date ||
        !time ||
        !["once", "daily", "weekly"].includes(repeat)
    ) {
        alert("Please enter valid schedule details.");
        return;
    }

    const scheduledDate = new Date(`${date}T${time}`);

    if (Number.isNaN(scheduledDate.getTime())) {
        alert("The selected date or time is invalid.");
        return;
    }

    if (repeat === "once" && scheduledDate.getTime() <= Date.now()) {
        alert("Choose a future date and time.");
        return;
    }

    schedules.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        relay,
        action,
        date,
        time,
        repeat,
        executedAt: null
    });

    saveSchedulesToStorage();
    renderSchedules();
    closeScheduleModal();

    addLog(
        "Scheduler",
        "SCHEDULE CREATED",
        `Relay ${relay}: ${action}, ${date} ${time}, ${repeat}`,
        "SUCCESS"
    );
});

/* ---------------- SCHEDULE EXECUTION ---------------- */

// Browser-based schedules run only while this page is open.
function checkSchedules() {
    const now = new Date();

    schedules.forEach(schedule => {
        const [year, month, day] = schedule.date.split("-").map(Number);
        const [hour, minute] = schedule.time.split(":").map(Number);

        const target = new Date(
            year,
            month - 1,
            day,
            hour,
            minute,
            0,
            0
        );

        if (now < target) return;

        const matches =
            schedule.repeat === "daily"
                ? now.getHours() === hour &&
                  now.getMinutes() === minute
                : schedule.repeat === "weekly"
                    ? now.getHours() === hour &&
                      now.getMinutes() === minute &&
                      now.getDay() === target.getDay()
                    : now.getTime() >= target.getTime() &&
                      !schedule.executedAt;

        if (!matches) return;

        if (
            schedule.executedAt ===
            `${now.toDateString()} ${hour}:${minute}`
        ) {
            return;
        }

        sendRelayCommand(
            Number(schedule.relay),
            schedule.action === "ON"
        );

        schedule.executedAt =
            `${now.toDateString()} ${hour}:${minute}`;

        addLog(
            "Scheduler",
            "SCHEDULE TRIGGERED",
            `Relay ${schedule.relay}: ${schedule.action}`,
            "INFO"
        );

        if (schedule.repeat === "once") {
            schedule.completed = true;
        }
    });

    const remaining = schedules.filter(schedule => !schedule.completed);

    if (remaining.length !== schedules.length) {
        schedules = remaining;
        saveSchedulesToStorage();
        renderSchedules();
    }
}

setInterval(checkSchedules, 1000);

/* ---------------- MQTT SETTINGS ---------------- */

safeOn("saveSettings", "click", () => {
    const brokerInput = get("mqttServerInput");

    if (!brokerInput) {
        console.warn("MQTT settings input was not found.");
        return;
    }

    const broker = brokerInput.value.trim();

    if (!/^wss:\/\//i.test(broker)) {
        alert("Enter a secure WebSocket URL beginning with wss://");
        return;
    }

    try {
        const parsed = new URL(broker);

        if (!parsed.hostname) {
            throw new Error("Missing broker hostname");
        }
    } catch (error) {
        alert("The MQTT WebSocket URL is invalid.");
        return;
    }

    MQTT_BROKER = broker;

    try {
        localStorage.setItem("mqttServer", broker);
    } catch (error) {
        alert("Could not save the MQTT address in this browser.");
        return;
    }

    connectMQTT();
});

function loadMQTTSettings() {
    const brokerInput = get("mqttServerInput");

    if (brokerInput) {
        brokerInput.value = MQTT_BROKER;
    }
}

safeOn("resetSettings", "click", () => {
    MQTT_BROKER = DEFAULT_MQTT_BROKER;

    try {
        localStorage.setItem("mqttServer", MQTT_BROKER);
    } catch (error) {
        console.warn("Could not save default MQTT URL:", error);
    }

    loadMQTTSettings();
    connectMQTT();
});
/* ---------------- THEME ---------------- */

function applyTheme(theme) {
    const isDark = theme === "dark";

    document.body.classList.toggle("dark-mode", isDark);

    const button = document.getElementById("theme-toggle");

    if (button) {
        button.textContent = isDark ? "🌙" : "☀️";

        button.setAttribute(
            "title",
            isDark ? "Switch to light mode" : "Switch to dark mode"
        );

        button.setAttribute(
            "aria-label",
            isDark ? "Switch to light mode" : "Switch to dark mode"
        );
    }

    try {
        localStorage.setItem("relayTheme", isDark ? "dark" : "light");
    } catch (error) {
        console.error("Unable to save theme:", error);
    }
}

function initializeTheme() {
    let savedTheme = "light";

    try {
        savedTheme =
            localStorage.getItem("relayTheme") ||
            localStorage.getItem("theme") ||
            "light";
    } catch (error) {
        console.warn("Could not load saved theme:", error);
    }

    applyTheme(savedTheme);
}

safeOn("theme-toggle", "click", () => {
    const isDark = document.body.classList.contains("dark-mode");

    applyTheme(isDark ? "light" : "dark");

    console.log(
        "Theme changed to:",
        document.body.classList.contains("dark-mode") ? "dark" : "light"
    );
});


/* ---------------- CLOCK ---------------- */

function updateClock() {
    setText("currentTime", new Date().toLocaleTimeString());
}

updateClock();
setInterval(updateClock, 1000);


/* ---------------- LAST UPDATE ---------------- */

function updateLastUpdate() {
    setText("lastUpdate", new Date().toLocaleTimeString());
}


/* ---------------- MQTT VISUAL STATUS ---------------- */

function updateMQTTColor(connected) {
    const element = get("systemDot");

    if (element) {
        element.classList.toggle(
            "online",
            Boolean(connected && deviceConnected)
        );
    }
}


/* ---------------- LOGIN ---------------- */

safeOn("loginForm", "submit", event => {
    event.preventDefault();

    const username = get("username")?.value.trim() || "";
    const password = get("password")?.value || "";

    const errorElement = get("loginError");
    const loginScreen = get("loginScreen");

    if (
        username === "the beyonders" &&
        password === "12345678"
    ) {
        if (errorElement) {
            errorElement.textContent = "";
        }

        if (loginScreen) {
            loginScreen.style.display = "none";
        }

        addLog(
            "LOGIN",
            "SUCCESS",
            "Demo login successful.",
            "SUCCESS"
        );
    } else {
        if (errorElement) {
            errorElement.textContent =
                "Incorrect username or password.";
        }

        const passwordInput = get("password");

        if (passwordInput) {
            passwordInput.value = "";
            passwordInput.focus();
        }
    }
});


/* ---------------- INITIALIZATION ---------------- */

function initializeDashboard() {
    loadMQTTSettings();

    initializeTheme();

    loadSchedules();

    renderLogs();

    renderNotifications();

    updateClock();

    updateActiveCount();

    // Start with relay toggles visually OFF.
    for (let i = 1; i <= RELAY_COUNT; i++) {
        const mainToggle = get(`relay${i}-toggle`);
        const controlToggle = get(`control-relay${i}`);

        if (mainToggle) {
            mainToggle.checked = false;
        }

        if (controlToggle) {
            controlToggle.checked = false;
        }
    }

    // Connect to the MQTT broker.
    connectMQTT();
}

if (document.readyState === "loading") {
    document.addEventListener(
        "DOMContentLoaded",
        initializeDashboard,
        { once: true }
    );
} else {
    initializeDashboard();
}


/* ---------------- MOBILE SIDEBAR ---------------- */

(function setupMobileSidebar() {
    const sidebar = document.querySelector(".sidebar");

    if (
        !sidebar ||
        document.getElementById("mobileMenuToggle")
    ) {
        return;
    }

    const menuButton = document.createElement("button");

    menuButton.id = "mobileMenuToggle";
    menuButton.type = "button";
    menuButton.textContent = "\u2630";

    menuButton.setAttribute(
        "aria-label",
        "Open navigation menu"
    );

    menuButton.setAttribute("aria-expanded", "false");

    const overlay = document.createElement("div");

    overlay.id = "mobileSidebarOverlay";

    document.body.appendChild(overlay);
    document.body.appendChild(menuButton);


    function closeSidebar() {
        document.body.classList.remove("mobile-sidebar-open");

        menuButton.setAttribute("aria-expanded", "false");

        menuButton.setAttribute(
            "aria-label",
            "Open navigation menu"
        );
    }


    function toggleSidebar() {
        const isOpen =
            document.body.classList.toggle("mobile-sidebar-open");

        menuButton.setAttribute(
            "aria-expanded",
            String(isOpen)
        );

        menuButton.setAttribute(
            "aria-label",
            isOpen
                ? "Close navigation menu"
                : "Open navigation menu"
        );
    }


    menuButton.addEventListener("click", toggleSidebar);

    overlay.addEventListener("click", closeSidebar);

    sidebar.querySelectorAll(".menu-item").forEach(item => {
        item.addEventListener("click", closeSidebar);
    });

    document.addEventListener("keydown", event => {
        if (event.key === "Escape") {
            closeSidebar();
        }
    });

    window.addEventListener("resize", () => {
        if (window.innerWidth > 600) {
            closeSidebar();
        }
    });
})();
