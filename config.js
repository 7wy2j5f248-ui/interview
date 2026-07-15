window.APP_CONFIG = Object.freeze({
    app_name: "Interview Quest",
    rtl_languages: Object.freeze(["ar", "ur"])
});

window.getLanguageDirection = function(language) {
    const normalizedLanguage = typeof language === "string"
        ? language.trim().toLowerCase()
        : "";

    return window.APP_CONFIG.rtl_languages.includes(normalizedLanguage)
        ? "rtl"
        : "ltr";
};

window.isolateDynamicText = function(value) {
    return document.documentElement.dir === "rtl"
        ? "\u2068" + String(value) + "\u2069"
        : String(value);
};

window.formatAppName = function(template) {
    const appName = document.documentElement.dir === "rtl"
        ? "\u2066" + window.APP_CONFIG.app_name + "\u2069"
        : window.APP_CONFIG.app_name;

    return String(template).split("{app_name}").join(appName);
};
