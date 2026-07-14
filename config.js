window.APP_CONFIG = Object.freeze({
    app_name: "Interview Quest"
});

window.formatAppName = function(template) {
    const appName = document.documentElement.dir === "rtl"
        ? "\u2066" + window.APP_CONFIG.app_name + "\u2069"
        : window.APP_CONFIG.app_name;

    return String(template).split("{app_name}").join(appName);
};
