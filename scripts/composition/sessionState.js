let activeMasterApp = null;
let activePlayerApp = null;

export function getActiveMasterApp() {
    return activeMasterApp;
}

export function setActiveMasterApp(app) {
    activeMasterApp = app;
}

export function clearActiveMasterApp() {
    activeMasterApp = null;
}

export function getActivePlayerApp() {
    return activePlayerApp;
}

export function setActivePlayerApp(app) {
    activePlayerApp = app;
}

export function clearActivePlayerApp() {
    activePlayerApp = null;
}
