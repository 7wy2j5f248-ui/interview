const COURTESIES = new Set([
    "hi", "hello", "hello there", "hey", "greetings", "good morning",
    "good afternoon", "good evening", "thanks", "thank you",
    "thank you very much", "bye", "goodbye",
    "你好", "您好", "早上好", "下午好", "晚上好", "谢谢", "再见",
    "مرحبا", "أهلا", "السلام عليكم", "شكرا", "مع السلامة",
    "hola", "buenos días", "buenas tardes", "gracias", "adiós",
    "bonjour", "bonsoir", "merci", "au revoir",
    "olá", "bom dia", "boa tarde", "obrigado", "obrigada", "tchau",
    "merhaba", "günaydın", "teşekkürler", "hoşça kal",
    "नमस्ते", "नमस्कार", "धन्यवाद", "अलविदा",
    "হ্যালো", "নমস্কার", "ধন্যবাদ", "বিদায়",
    "xin chào", "chào bạn", "cảm ơn", "tạm biệt",
    "வணக்கம்", "நன்றி", "பிரியாவிடை", "habari", "jambo", "asante",
    "kwa heri", "سلام", "السلام علیکم", "شکریہ", "خدا حافظ",
    "halo", "selamat pagi", "terima kasih", "sampai jumpa",
    "salaan", "mahadsanid", "nabad gelyo", "မင်္ဂလာပါ",
    "ကျေးဇူးတင်ပါတယ်", "နှုတ်ဆက်ပါတယ်", "درود", "صبح بخیر", "تشکر",
    "ممنون", "خداحافظ"
].map(normalizedCourtesy));

function text(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizedCourtesy(value) {
    return (typeof value === "string" ? value : "")
        .normalize("NFKC")
        .toLocaleLowerCase()
        .replace(/[\p{P}\p{S}]+/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();
}

export function isConversationalCourtesy(value) {
    const normalized = normalizedCourtesy(value);
    return Boolean(normalized) && COURTESIES.has(normalized);
}

export function prepareParticipantMessages(rows) {
    const messages = [];
    let skippedRecords = 0;
    (Array.isArray(rows) ? rows : []).forEach(row => {
        const speaker = text(row?.Speaker)?.toLocaleLowerCase();
        const id = text(row?.id);
        const originalText = text(row?.Message);
        if (!id || !originalText
            || (speaker !== "user" && speaker !== "participant")) {
            skippedRecords += 1;
            return;
        }
        const language = text(row?.Language)?.toLocaleLowerCase() || null;
        const englishTranslation = text(row?.EnglishTranslation);
        messages.push({
            id,
            sessionId: text(row?.Session),
            participantId: text(row?.Participant),
            language,
            timestamp: text(row?.Timestamp),
            originalText,
            englishTranslation,
            analysisText: language === "en"
                ? originalText : englishTranslation || originalText
        });
    });
    return { messages, skippedRecords };
}
