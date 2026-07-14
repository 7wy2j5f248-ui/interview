window.APP_CONFIG = Object.freeze({
    app_name: "Interview Quest"
});

window.formatAppName = function(template) {
    return String(template).split("{app_name}").join(window.APP_CONFIG.app_name);
};
